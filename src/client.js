#!/usr/bin/env node
import http from "node:http";
import { pathToFileURL } from "node:url";
import { FrameType, newSessionId, sessionIdToKey } from "./crypto.js";
import { redirectHttpRequestToHttps } from "./http-upgrade.js";
import { parseConnectAuthority } from "./net-policy.js";
import { RelayConnection } from "./relay-connection.js";

function connectError(socket, status, message) {
  if (socket.destroyed) return;
  const safeMessage = String(message).replace(/[\r\n]/g, " ").slice(0, 200);
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(safeMessage)}\r\n\r\n${safeMessage}`,
  );
}

export async function startClient({
  coordinatorUrl,
  pairCode,
  listenHost = "127.0.0.1",
  listenPort = 7777,
  logger = console,
} = {}) {
  if (!pairCode) throw new Error("PAIR_CODE is required");
  const sessions = new Map();
  const relay = new RelayConnection({ coordinatorUrl, pairCode, role: "client", logger });

  function removeSession(session, notifyExit = true) {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.openTimer);
    sessions.delete(session.key);
    if (notifyExit && relay.peerReady) relay.send(FrameType.END, session.id);
  }

  relay.on("frame", ({ type, sessionId, payload }) => {
    const key = sessionIdToKey(sessionId);
    const session = sessions.get(key);
    if (!session) return;

    if (type === FrameType.OPEN_OK && !session.open) {
      session.open = true;
      clearTimeout(session.openTimer);
      session.socket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: MeshHop\r\n\r\n");
      if (session.head.length && !relay.send(FrameType.DATA, session.id, session.head)) {
        session.socket.destroy();
        return;
      }
      session.socket.resume();
      return;
    }

    if (type === FrameType.DATA && session.open) {
      if (!session.socket.write(payload)) session.socket.pause();
      return;
    }

    if (type === FrameType.ERROR) {
      const message = payload.toString("utf8") || "The exit rejected the connection";
      if (!session.open) connectError(session.socket, "502 Bad Gateway", message);
      else session.socket.destroy(new Error(message));
      removeSession(session, false);
      return;
    }

    if (type === FrameType.END) {
      removeSession(session, false);
      session.socket.end();
    }
  });

  relay.on("peer-state", (ready) => {
    logger.info?.(ready ? "Paired exit is online" : "Paired exit is offline");
    if (ready) return;
    for (const session of sessions.values()) {
      if (!session.open) connectError(session.socket, "503 Service Unavailable", "Paired exit went offline");
      else session.socket.destroy();
      removeSession(session, false);
    }
  });

  const server = http.createServer((request, response) => {
    redirectHttpRequestToHttps(request, response);
  });

  server.on("connect", (request, socket, head) => {
    let destination;
    try {
      destination = parseConnectAuthority(request.url);
      if (destination.port !== 443) throw new Error("Only HTTPS port 443 is supported");
    } catch (error) {
      connectError(socket, "400 Bad Request", error.message);
      return;
    }

    if (!relay.peerReady) {
      connectError(socket, "503 Service Unavailable", "Paired exit is not online");
      return;
    }

    socket.pause();
    socket.setNoDelay(true);
    const id = newSessionId();
    const key = sessionIdToKey(id);
    const session = {
      id,
      key,
      socket,
      head: Buffer.from(head),
      open: false,
      closed: false,
      openTimer: null,
    };
    sessions.set(key, session);

    socket.on("data", (chunk) => {
      if (session.open && !relay.send(FrameType.DATA, id, chunk)) socket.destroy();
    });
    socket.on("drain", () => socket.resume());
    socket.on("close", () => removeSession(session));
    socket.on("error", () => {});

    session.openTimer = setTimeout(() => {
      connectError(socket, "504 Gateway Timeout", "The exit timed out opening the destination");
      removeSession(session);
    }, 12_000);
    session.openTimer.unref?.();

    const openPayload = Buffer.from(JSON.stringify(destination), "utf8");
    if (!relay.send(FrameType.OPEN, id, openPayload)) {
      connectError(socket, "503 Service Unavailable", "Paired exit is unavailable");
      removeSession(session, false);
    }
  });

  server.on("clientError", (_error, socket) => connectError(socket, "400 Bad Request", "Malformed proxy request"));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  relay.start();

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : listenPort;
  logger.info?.(`Local HTTPS proxy listening on http://${listenHost}:${actualPort}`);

  return {
    relay,
    server,
    host: listenHost,
    port: actualPort,
    async close() {
      relay.stop();
      for (const session of sessions.values()) session.socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function main() {
  await startClient({
    coordinatorUrl: process.env.COORDINATOR_URL ?? "ws://127.0.0.1:8787/relay",
    pairCode: process.env.PAIR_CODE,
    listenHost: process.env.LISTEN_HOST ?? "127.0.0.1",
    listenPort: Number(process.env.LISTEN_PORT ?? 7777),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
