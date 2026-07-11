#!/usr/bin/env node
import net from "node:net";
import { pathToFileURL } from "node:url";
import { FrameType, sessionIdToKey } from "./crypto.js";
import {
  parseAllowlist,
  resolvePublicAddresses,
  validateDestination,
} from "./net-policy.js";
import { RelayConnection } from "./relay-connection.js";

class ByteBudget {
  constructor(limit) {
    this.limit = limit;
    this.used = 0;
    this.windowStarted = Date.now();
  }

  take(bytes) {
    if (Date.now() - this.windowStarted >= 60_000) {
      this.used = 0;
      this.windowStarted = Date.now();
    }
    this.used += bytes;
    return this.used <= this.limit;
  }
}

function connectAddress({ address, family }, port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: address, family, port });
    const timer = setTimeout(() => socket.destroy(new Error("Connection timed out")), timeoutMs);
    const onError = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

async function connectPublicDestination(host, port) {
  const addresses = await resolvePublicAddresses(host);
  const errors = [];
  for (const address of addresses) {
    try {
      return await connectAddress(address, port);
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`Could not connect to ${host}: ${errors.join("; ")}`);
}

export async function startExit({
  coordinatorUrl,
  pairCode,
  allowDomains = "",
  allowAllPublicHttps = false,
  maxConnections = 8,
  maxBytesPerMinute = 250 * 1024 * 1024,
  logger = console,
} = {}) {
  if (!pairCode) throw new Error("PAIR_CODE is required");
  const rules = parseAllowlist(allowDomains);
  if (!allowAllPublicHttps && rules.length === 0) {
    throw new Error("Set ALLOW_DOMAINS or explicitly set ALLOW_ALL_PUBLIC_HTTPS=1");
  }
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 100) {
    throw new Error("MAX_CONNECTIONS must be between 1 and 100");
  }
  if (!Number.isFinite(maxBytesPerMinute) || maxBytesPerMinute < 1024) {
    throw new Error("MAX_BYTES_PER_MINUTE must be a positive number of at least 1024");
  }

  const budget = new ByteBudget(maxBytesPerMinute);
  const sessions = new Map();
  const relay = new RelayConnection({ coordinatorUrl, pairCode, role: "exit", logger });

  function sendError(sessionId, message) {
    relay.send(FrameType.ERROR, sessionId, Buffer.from(String(message).slice(0, 300), "utf8"));
  }

  function closeForBudget(session) {
    sendError(session.id, "Exit bandwidth limit reached; try again after the current minute");
    session.socket?.destroy();
  }

  async function openSession(sessionId, payload) {
    const key = sessionIdToKey(sessionId);
    if (sessions.has(key)) {
      sendError(sessionId, "Duplicate session");
      return;
    }
    if (sessions.size >= maxConnections) {
      sendError(sessionId, "Exit connection limit reached");
      return;
    }

    const session = { id: sessionId, key, socket: null, cancelled: false, suppressEnd: false };
    sessions.set(key, session);

    let destination;
    try {
      const requested = JSON.parse(payload.toString("utf8"));
      destination = validateDestination(requested.host, requested.port, {
        rules,
        allowAllPublicHttps,
      });
      session.socket = await connectPublicDestination(destination.host, destination.port);
    } catch (error) {
      sessions.delete(key);
      sendError(sessionId, error.message);
      return;
    }

    if (session.cancelled || !relay.peerReady) {
      session.socket.destroy();
      sessions.delete(key);
      return;
    }

    logger.info?.(`Allowed HTTPS connection to ${destination.host}`);
    session.socket.on("data", (chunk) => {
      if (!budget.take(chunk.length)) {
        closeForBudget(session);
        return;
      }
      if (!relay.send(FrameType.DATA, session.id, chunk)) session.socket.destroy();
    });
    session.socket.on("error", (error) => {
      if (!session.suppressEnd) sendError(session.id, error.message);
    });
    session.socket.on("close", () => {
      sessions.delete(key);
      if (!session.suppressEnd && relay.peerReady) relay.send(FrameType.END, session.id);
    });
    relay.send(FrameType.OPEN_OK, session.id);
  }

  relay.on("frame", ({ type, sessionId, payload }) => {
    const key = sessionIdToKey(sessionId);
    if (type === FrameType.OPEN) {
      void openSession(sessionId, payload);
      return;
    }

    const session = sessions.get(key);
    if (!session) return;
    if (type === FrameType.DATA && session.socket) {
      if (!budget.take(payload.length)) {
        closeForBudget(session);
        return;
      }
      session.socket.write(payload);
      return;
    }
    if (type === FrameType.END) {
      session.suppressEnd = true;
      if (session.socket) session.socket.end();
      else session.cancelled = true;
    }
  });

  relay.on("peer-state", (ready) => {
    logger.info?.(ready ? "Paired client is online" : "Paired client is offline");
    if (ready) return;
    for (const session of sessions.values()) {
      session.suppressEnd = true;
      session.cancelled = true;
      session.socket?.destroy();
    }
    sessions.clear();
  });

  relay.start();
  return {
    relay,
    async close() {
      relay.stop();
      for (const session of sessions.values()) session.socket?.destroy();
      sessions.clear();
    },
  };
}

async function main() {
  await startExit({
    coordinatorUrl: process.env.COORDINATOR_URL ?? "ws://127.0.0.1:8787/relay",
    pairCode: process.env.PAIR_CODE,
    allowDomains: process.env.ALLOW_DOMAINS ?? "",
    allowAllPublicHttps: process.env.ALLOW_ALL_PUBLIC_HTTPS === "1",
    maxConnections: Number(process.env.MAX_CONNECTIONS ?? 8),
    maxBytesPerMinute: Number(process.env.MAX_BYTES_PER_MINUTE ?? 250 * 1024 * 1024),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
