import net from "node:net";
import tls from "node:tls";
import ipaddr from "ipaddr.js";

// Build the SOCKS5 address portion (ATYP + address) for a target host. IPv4 and
// IPv6 literals are encoded as their native address types; anything else is sent
// as a domain name for the proxy to resolve.
function socks5Address(host) {
  if (net.isIPv4(host)) {
    return Buffer.from([0x01, ...ipaddr.parse(host).toByteArray()]);
  }
  if (net.isIPv6(host)) {
    return Buffer.from([0x04, ...ipaddr.parse(host).toByteArray()]);
  }
  const domain = Buffer.from(host, "utf8");
  if (domain.length > 255) throw new Error("Destination hostname is too long for SOCKS5");
  return Buffer.from([0x03, domain.length, ...domain]);
}

class SocketReader {
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
    this.onEnd = () => this.#fail(new Error("Proxy closed the connection during handshake"));
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
    if (!this.waiter) return;
    let result;
    try {
      result = this.waiter.extract(this.buffer);
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (!result) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    this.buffer = result.remaining;
    waiter.resolve(result.value);
  }

  #wait(extract, timeoutMs) {
    if (this.waiter) throw new Error("Concurrent socket reads are not supported");
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error("Proxy handshake timed out"));
      }, Math.max(1, timeoutMs));
      this.waiter = { extract, resolve, reject, timer };
      this.#drain();
    });
  }

  readBytes(length, timeoutMs) {
    return this.#wait((buffer) => {
      if (buffer.length < length) return null;
      return { value: buffer.subarray(0, length), remaining: buffer.subarray(length) };
    }, timeoutMs);
  }

  readUntil(marker, maximum, timeoutMs) {
    return this.#wait((buffer) => {
      const index = buffer.indexOf(marker);
      if (index === -1) {
        if (buffer.length > maximum) throw new Error("Proxy handshake response is too large");
        return null;
      }
      const end = index + marker.length;
      return { value: buffer.subarray(0, end), remaining: buffer.subarray(end) };
    }, timeoutMs);
  }

  finish() {
    if (this.waiter) throw new Error("Cannot finish while a read is pending");
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("end", this.onEnd);
    if (this.buffer.length) {
      this.socket.pause();
      this.socket.unshift(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
  }
}

function remaining(deadline) {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error("Proxy connection timed out");
  return value;
}

function openTcp(host, port, deadline) {
  return new Promise((resolve, reject) => {
    // Compute the budget before creating the socket. If the deadline has already
    // passed, reject without ever opening a connection: a socket created here
    // would have no error listener and no timeout, leaking the descriptor and
    // (on a refused connection) crashing the engine with an uncaught 'error'.
    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0) {
      reject(new Error("Proxy connection timed out"));
      return;
    }
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error("Proxy TCP connection timed out")), timeLeft);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function wrapProxyTls(socket, proxy, deadline) {
  // Same guard as openTcp: never start a TLS handshake we have no time budget
  // for, so the tls.Socket below always has its error listener attached.
  const timeLeft = deadline - Date.now();
  if (timeLeft <= 0) throw new Error("Proxy connection timed out");
  return await new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername: net.isIP(proxy.host) ? undefined : proxy.host,
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    const timer = setTimeout(() => secure.destroy(new Error("TLS proxy handshake timed out")), timeLeft);
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function httpConnectOnSocket(socket, targetHost, targetPort, deadline) {
  const reader = new SocketReader(socket);
  try {
    // IPv6 literals must be bracketed in the request-target and Host header.
    const authorityHost = net.isIPv6(targetHost) ? `[${targetHost}]` : targetHost;
    socket.write(
      `CONNECT ${authorityHost}:${targetPort} HTTP/1.1\r\nHost: ${authorityHost}:${targetPort}\r\nProxy-Connection: keep-alive\r\nUser-Agent: MeshHop-Public/0.2\r\n\r\n`,
    );
    const header = await reader.readUntil(Buffer.from("\r\n\r\n"), 16 * 1024, remaining(deadline));
    const statusLine = header.toString("latin1").split("\r\n", 1)[0];
    if (!/^HTTP\/1\.[01] 2\d\d(?: |$)/.test(statusLine)) {
      throw new Error(`HTTP proxy rejected CONNECT (${statusLine.slice(0, 100)})`);
    }
    reader.finish();
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function connectHttpProxy(proxy, targetHost, targetPort, deadline) {
  if (proxy.protocol === "https") {
    let raw;
    try {
      raw = await openTcp(proxy.host, proxy.port, deadline);
      const secure = await wrapProxyTls(raw, proxy, deadline);
      return await httpConnectOnSocket(secure, targetHost, targetPort, deadline);
    } catch (tlsError) {
      raw?.destroy();
      const fallback = await openTcp(proxy.host, proxy.port, deadline);
      try {
        return await httpConnectOnSocket(fallback, targetHost, targetPort, deadline);
      } catch {
        fallback.destroy();
        throw tlsError;
      }
    }
  }
  const socket = await openTcp(proxy.host, proxy.port, deadline);
  return await httpConnectOnSocket(socket, targetHost, targetPort, deadline);
}

async function connectSocks5(proxy, targetHost, targetPort, deadline) {
  const socket = await openTcp(proxy.host, proxy.port, deadline);
  const reader = new SocketReader(socket);
  try {
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const greeting = await reader.readBytes(2, remaining(deadline));
    if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
      throw new Error("SOCKS5 proxy does not permit unauthenticated access");
    }

    const address = socks5Address(targetHost);
    const request = Buffer.alloc(3 + address.length + 2);
    request.set([0x05, 0x01, 0x00], 0);
    address.copy(request, 3);
    request.writeUInt16BE(targetPort, 3 + address.length);
    socket.write(request);

    const response = await reader.readBytes(4, remaining(deadline));
    if (response[0] !== 0x05 || response[1] !== 0x00) {
      throw new Error(`SOCKS5 proxy rejected the connection (code ${response[1]})`);
    }
    let addressBytes;
    if (response[3] === 0x01) addressBytes = 4;
    else if (response[3] === 0x04) addressBytes = 16;
    else if (response[3] === 0x03) addressBytes = (await reader.readBytes(1, remaining(deadline)))[0];
    else throw new Error("SOCKS5 proxy returned an invalid address type");
    await reader.readBytes(addressBytes + 2, remaining(deadline));
    reader.finish();
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function connectSocks4(proxy, targetHost, targetPort, deadline) {
  const socket = await openTcp(proxy.host, proxy.port, deadline);
  const reader = new SocketReader(socket);
  try {
    const domain = Buffer.from(targetHost, "utf8");
    const request = Buffer.alloc(10 + domain.length);
    request[0] = 0x04;
    request[1] = 0x01;
    request.writeUInt16BE(targetPort, 2);
    request.set([0x00, 0x00, 0x00, 0x01, 0x00], 4);
    domain.copy(request, 9);
    request[9 + domain.length] = 0x00;
    socket.write(request);
    const response = await reader.readBytes(8, remaining(deadline));
    if (response[1] !== 0x5a) {
      throw new Error(`SOCKS4 proxy rejected the connection (code ${response[1]})`);
    }
    reader.finish();
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export async function connectViaProxy(proxy, targetHost, targetPort = 443, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  if (proxy.protocol === "http" || proxy.protocol === "https") {
    return await connectHttpProxy(proxy, targetHost, targetPort, deadline);
  }
  if (proxy.protocol === "socks5") return await connectSocks5(proxy, targetHost, targetPort, deadline);
  if (proxy.protocol === "socks4") return await connectSocks4(proxy, targetHost, targetPort, deadline);
  throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`);
}

function decodeChunked(body) {
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset, "latin1");
    if (lineEnd === -1) throw new Error("Invalid chunked response");
    const size = Number.parseInt(body.toString("ascii", offset, lineEnd).split(";", 1)[0], 16);
    if (!Number.isFinite(size)) throw new Error("Invalid HTTP chunk size");
    offset = lineEnd + 2;
    if (size === 0) break;
    if (offset + size + 2 > body.length) throw new Error("Truncated chunked response");
    chunks.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

export async function httpsGetViaProxy(
  proxy,
  { host, path = "/", timeoutMs = 7_000, maximumBytes = 256 * 1024 } = {},
) {
  const started = performance.now();
  // A single wall-clock budget covers the proxy tunnel, TLS handshake, and the
  // HTTP exchange, so a slow proxy cannot spend timeoutMs on each stage in turn.
  const deadline = Date.now() + timeoutMs;
  const tunnel = await connectViaProxy(proxy, host, 443, Math.max(1, deadline - Date.now()));
  const secure = tls.connect({
    socket: tunnel,
    servername: host,
    rejectUnauthorized: true,
    ALPNProtocols: ["http/1.1"],
  });

  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(
      () => secure.destroy(new Error("HTTPS probe timed out")),
      Math.max(1, deadline - Date.now()),
    );
    secure.once("secureConnect", () => {
      secure.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: MeshHop-Public/0.2\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
      );
    });
    secure.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        secure.destroy(new Error("HTTPS probe response exceeded its size limit"));
        return;
      }
      chunks.push(chunk);
    });
    secure.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    secure.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) throw new Error("HTTPS probe returned an invalid HTTP response");
  const headerText = raw.toString("latin1", 0, headerEnd);
  const statusMatch = /^HTTP\/1\.[01] (\d{3})/i.exec(headerText);
  if (!statusMatch) throw new Error("HTTPS probe returned an invalid status line");
  let body = raw.subarray(headerEnd + 4);
  if (/\r\ntransfer-encoding:\s*chunked\s*(?:\r\n|$)/i.test(`\r\n${headerText}\r\n`)) {
    body = decodeChunked(body);
  }
  return {
    statusCode: Number(statusMatch[1]),
    headers: headerText,
    body,
    elapsedMs: Math.round(performance.now() - started),
  };
}

// Steady-state download rate (Mbps) from a series of cumulative byte readings,
// where each reading is { tMs, bytes } and tMs is milliseconds since the first
// body byte arrived. The rate is measured over a window that begins after a
// warm-up period (so TCP slow-start does not drag the number down) and spans up
// to measureMs. If the transfer ended before the warm-up completed, the whole
// transfer is used as a fallback. Pure and deterministic: unit-testable without
// a socket. Returns 0 when there is not enough signal to measure.
export function windowedThroughputMbps(readings, { warmupMs = 400, measureMs = 2_500 } = {}) {
  if (!Array.isArray(readings) || readings.length < 2) return 0;
  const first = readings[0];
  const last = readings[readings.length - 1];

  let start = readings.find((reading) => reading.tMs >= warmupMs);
  let end = null;
  if (start) {
    const target = start.tMs + measureMs;
    for (const reading of readings) {
      if (reading.tMs >= start.tMs && reading.tMs <= target) end = reading;
    }
  }
  // Fallback: warm-up consumed the whole (short) transfer, so measure end to end.
  if (!start || !end || end.tMs <= start.tMs) {
    start = first;
    end = last;
  }

  const seconds = (end.tMs - start.tMs) / 1_000;
  const bits = (end.bytes - start.bytes) * 8;
  if (seconds <= 0 || bits <= 0) return 0;
  return Math.round((bits / seconds / 1_000_000) * 100) / 100;
}

const SPEED_REQUEST_BYTES = 64 * 1024 * 1024; // Upper bound; the transfer is aborted once the window closes.
const SPEED_WARMUP_MS = 400;
const SPEED_MEASURE_MS = 2_500;

// Measure sustained download throughput through the proxy against Cloudflare's
// speed endpoint. Unlike a fixed-size probe timed from before the handshake,
// this streams a large payload and times only the transfer window, so the result
// reflects real bandwidth rather than connection setup latency.
export async function measureDownloadThroughput(
  proxy,
  {
    host = "speed.cloudflare.com",
    requestBytes = SPEED_REQUEST_BYTES,
    warmupMs = SPEED_WARMUP_MS,
    measureMs = SPEED_MEASURE_MS,
    timeoutMs = 12_000,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const tunnel = await connectViaProxy(proxy, host, 443, Math.max(1, deadline - Date.now()));
  const secure = tls.connect({
    socket: tunnel,
    servername: host,
    rejectUnauthorized: true,
    ALPNProtocols: ["http/1.1"],
  });

  return await new Promise((resolve, reject) => {
    let headerBuffer = Buffer.alloc(0);
    let headersDone = false;
    let statusCode = 0;
    let requestSentAt = 0;
    let firstBodyAt = 0;
    let ttfbMs = 0;
    let bodyBytes = 0;
    const readings = [];
    let settled = false;

    // On deadline, measure from whatever was transferred rather than discarding a
    // slow-but-working exit; the guards in finish() reject only if too little
    // arrived to measure at all.
    const timer = setTimeout(() => finish(), Math.max(1, deadline - Date.now()));

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secure.destroy();
      if (error) return reject(error);
      if (statusCode !== 200) return reject(new Error(`Speed probe returned HTTP ${statusCode || "?"}`));
      if (readings.length < 2) return reject(new Error("Speed probe did not transfer enough data to measure"));
      const throughputMbps = windowedThroughputMbps(readings, { warmupMs, measureMs });
      if (throughputMbps <= 0) return reject(new Error("Speed probe did not produce a usable measurement"));
      resolve({
        throughputMbps,
        ttfbMs,
        sampleBytes: bodyBytes,
        windowMs: Math.round(readings[readings.length - 1].tMs),
      });
    }

    secure.once("secureConnect", () => {
      requestSentAt = performance.now();
      secure.write(
        `GET /__down?bytes=${requestBytes} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: MeshHop-Public/0.2\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
      );
    });

    secure.on("data", (chunk) => {
      let bodyChunk = chunk;
      if (!headersDone) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const headerEnd = headerBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          if (headerBuffer.length > 32 * 1024) finish(new Error("Speed probe returned oversized headers"));
          return;
        }
        const headerText = headerBuffer.toString("latin1", 0, headerEnd);
        const match = /^HTTP\/1\.[01] (\d{3})/i.exec(headerText);
        statusCode = match ? Number(match[1]) : 0;
        if (statusCode !== 200) return finish();
        headersDone = true;
        bodyChunk = headerBuffer.subarray(headerEnd + 4);
        headerBuffer = Buffer.alloc(0);
      }

      if (bodyChunk.length === 0) return;
      const now = performance.now();
      if (firstBodyAt === 0) {
        firstBodyAt = now;
        ttfbMs = Math.round(now - requestSentAt);
      }
      bodyBytes += bodyChunk.length;
      const tMs = now - firstBodyAt;
      readings.push({ tMs, bytes: bodyBytes });
      if (tMs >= warmupMs + measureMs) finish();
    });

    secure.once("end", () => finish());
    secure.once("error", (error) => finish(error));
  });
}
