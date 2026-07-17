import net from "node:net";
import ipaddr from "ipaddr.js";
import { normalizeConnectHost } from "../net-policy.js";
import { tunnelThroughPool } from "./relay.js";

// A minimal, defensive SOCKS5 server (RFC 1928) so non-browser apps can route
// through the currently selected exit too. It mirrors the local browser
// CONNECT proxy's policy exactly: loopback only, no authentication (the port
// itself is the trust boundary, same as the HTTP CONNECT listener), CONNECT
// command only, and HTTPS port 443 only — this is not a general-purpose SOCKS
// proxy, it is the same "HTTPS over TCP, port 443 only" scope with a
// different client-facing protocol.
const SOCKS_VERSION = 0x05;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const HANDSHAKE_TIMEOUT_MS = 10_000;

const REPLY = {
  OK: 0x00,
  GENERAL_FAILURE: 0x01,
  NOT_ALLOWED: 0x02,
  HOST_UNREACHABLE: 0x04,
  COMMAND_NOT_SUPPORTED: 0x07,
  ADDRESS_TYPE_NOT_SUPPORTED: 0x08,
};

// BND.ADDR/BND.PORT are not meaningful here (we never expose a real bind
// address); 0.0.0.0:0 is what most SOCKS5 clients expect for a CONNECT reply
// when the proxy doesn't have a distinct bound address to report.
function replyPacket(code) {
  return Buffer.from([SOCKS_VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

function destroyWithReply(socket, code) {
  if (socket.destroyed) return;
  socket.end(replyPacket(code));
}

// A small buffered reader over the client socket, the mirror image of
// tunnel.js's SocketReader (which reads from the upstream proxy side). Kept
// local to this file rather than shared, since the two read in opposite
// directions for different protocols.
class ClientReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.failure = null;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    };
    this.onError = (error) => this.#fail(error);
    this.onEnd = () => this.#fail(new Error("Client closed the connection during handshake"));
    socket.on("data", this.onData);
    socket.once("error", this.onError);
    socket.once("end", this.onEnd);
  }

  #fail(error) {
    this.failure = error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #drain() {
    if (!this.waiter || this.buffer.length < this.waiter.length) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    const value = this.buffer.subarray(0, waiter.length);
    this.buffer = this.buffer.subarray(waiter.length);
    waiter.resolve(value);
  }

  readBytes(length, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    if (this.waiter) return Promise.reject(new Error("Concurrent reads are not supported"));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error("SOCKS handshake timed out"));
      }, Math.max(1, timeoutMs));
      this.waiter = { length, resolve, reject, timer };
      this.#drain();
    });
  }

  // Stop buffering and hand back anything read past the request header (a
  // client is allowed to pipeline its first upstream bytes immediately after
  // the CONNECT request, before waiting for our reply).
  detach() {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("end", this.onEnd);
    const leftover = this.buffer;
    this.buffer = Buffer.alloc(0);
    return leftover;
  }
}

async function parseDestinationAddress(reader) {
  const header = await reader.readBytes(4);
  const [version, cmd, , atyp] = header;
  if (version !== SOCKS_VERSION) throw Object.assign(new Error("Unsupported SOCKS version"), { reply: REPLY.GENERAL_FAILURE });
  if (cmd !== CMD_CONNECT) throw Object.assign(new Error("Only the CONNECT command is supported"), { reply: REPLY.COMMAND_NOT_SUPPORTED });

  let hostRaw;
  if (atyp === ATYP_IPV4) {
    const addr = await reader.readBytes(4);
    hostRaw = Array.from(addr).join(".");
  } else if (atyp === ATYP_DOMAIN) {
    const lengthByte = await reader.readBytes(1);
    const domain = await reader.readBytes(lengthByte[0]);
    hostRaw = domain.toString("utf8");
  } else if (atyp === ATYP_IPV6) {
    const addr = await reader.readBytes(16);
    hostRaw = ipaddr.fromByteArray(Array.from(addr)).toString();
  } else {
    throw Object.assign(new Error("Unsupported SOCKS address type"), { reply: REPLY.ADDRESS_TYPE_NOT_SUPPORTED });
  }
  const portBytes = await reader.readBytes(2);
  const port = portBytes.readUInt16BE(0);
  return { hostRaw, port };
}

export function createSocksServer(pool, { connectTimeoutMs = 5_000, maxAttempts = 3, autoFallback = true, logger = console } = {}) {
  async function handleClient(socket) {
    socket.setNoDelay(true);
    const reader = new ClientReader(socket);

    const greeting = await reader.readBytes(2);
    if (greeting[0] !== SOCKS_VERSION) return destroyWithReply(socket, REPLY.GENERAL_FAILURE);
    const methodCount = greeting[1];
    const methods = methodCount > 0 ? await reader.readBytes(methodCount) : Buffer.alloc(0);
    if (!methods.includes(0x00)) {
      // No acceptable authentication method (we only offer "no auth").
      if (!socket.destroyed) socket.end(Buffer.from([SOCKS_VERSION, 0xff]));
      return;
    }
    if (socket.destroyed) return;
    socket.write(Buffer.from([SOCKS_VERSION, 0x00]));

    const { hostRaw, port } = await parseDestinationAddress(reader);

    let destination;
    try {
      if (port !== 443) throw new Error("Only HTTPS port 443 is supported");
      destination = { host: normalizeConnectHost(hostRaw), port };
    } catch (error) {
      logger.warn?.(`SOCKS destination rejected (${hostRaw}:${port}): ${error.message}`);
      return destroyWithReply(socket, REPLY.NOT_ALLOWED);
    }

    const leftover = reader.detach();
    const { upstream, failures } = await tunnelThroughPool(pool, socket, destination.host, destination.port, {
      connectTimeoutMs,
      maxAttempts,
      autoFallback,
    });
    if (!upstream) {
      if (!socket.destroyed) {
        logger.warn?.(`SOCKS tunnel to ${destination.host}:443 failed: ${failures.join(" | ") || "no verified exit available"}`);
      }
      return destroyWithReply(socket, REPLY.HOST_UNREACHABLE);
    }
    if (socket.destroyed) {
      upstream.destroy();
      return;
    }

    socket.write(replyPacket(REPLY.OK));
    if (leftover.length) upstream.write(leftover);
    socket.pipe(upstream);
    upstream.pipe(socket);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }

  const server = net.createServer((socket) => {
    handleClient(socket).catch((error) => {
      logger.warn?.(`SOCKS client handling failed: ${error.message}`);
      if (!socket.destroyed) {
        const code = Number.isInteger(error?.reply) ? error.reply : REPLY.GENERAL_FAILURE;
        destroyWithReply(socket, code);
      }
    });
  });
  return server;
}
