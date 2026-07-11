#!/usr/bin/env node
import { createHash } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { tokensEqual } from "./crypto.js";

const ROOM_PATTERN = /^[a-f0-9]{32}$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function tokenFingerprint(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sendControl(socket, type) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type }));
  }
}

export async function startCoordinator({
  host = "127.0.0.1",
  port = 8787,
  logger = console,
} = {}) {
  const rooms = new Map();
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("MeshHop coordinator\n");
  });

  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 600 * 1024 });

  function updateRoom(room) {
    const client = room.peers.get("client");
    const exit = room.peers.get("exit");
    const ready = client?.readyState === WebSocket.OPEN && exit?.readyState === WebSocket.OPEN;
    for (const peer of [client, exit]) sendControl(peer, ready ? "peer-ready" : "peer-waiting");
  }

  server.on("upgrade", (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, "http://coordinator.local");
    } catch {
      socket.destroy();
      return;
    }
    const roomId = url.searchParams.get("room") ?? "";
    const role = url.searchParams.get("role") ?? "";
    if (url.pathname !== "/relay" || !ROOM_PATTERN.test(roomId) || !new Set(["client", "exit"]).has(role)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request, { roomId, role });
    });
  });

  webSockets.on("connection", (socket, _request, { roomId, role }) => {
    let room = null;
    let authenticated = false;
    const authTimer = setTimeout(() => socket.close(1008, "Authentication timeout"), 5_000);
    authTimer.unref?.();

    socket.on("message", (data, isBinary) => {
      if (!authenticated) {
        if (isBinary) {
          socket.close(1008, "Authenticate first");
          return;
        }

        let message;
        try {
          message = JSON.parse(data.toString("utf8"));
        } catch {
          socket.close(1008, "Invalid authentication");
          return;
        }
        if (message.type !== "auth" || !TOKEN_PATTERN.test(message.token ?? "")) {
          socket.close(1008, "Invalid authentication");
          return;
        }

        const fingerprint = tokenFingerprint(message.token);
        room = rooms.get(roomId);
        if (!room) {
          room = { tokenFingerprint: fingerprint, peers: new Map() };
          rooms.set(roomId, room);
        } else if (!tokensEqual(room.tokenFingerprint, fingerprint)) {
          socket.close(1008, "Room authentication failed");
          return;
        }

        const existing = room.peers.get(role);
        if (existing?.readyState === WebSocket.OPEN) {
          socket.close(1008, `A ${role} is already connected`);
          return;
        }

        clearTimeout(authTimer);
        authenticated = true;
        room.peers.set(role, socket);
        sendControl(socket, "authenticated");
        updateRoom(room);
        return;
      }

      if (!isBinary) {
        socket.close(1003, "Only encrypted binary frames are accepted");
        return;
      }

      const targetRole = role === "client" ? "exit" : "client";
      const target = room.peers.get(targetRole);
      if (target?.readyState === WebSocket.OPEN) {
        target.send(data, { binary: true });
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (!room || room.peers.get(role) !== socket) return;
      room.peers.delete(role);
      updateRoom(room);
      if (room.peers.size === 0) rooms.delete(roomId);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualHost = typeof address === "object" && address ? address.address : host;
  const actualPort = typeof address === "object" && address ? address.port : port;
  logger.info?.(`MeshHop coordinator listening on http://${actualHost}:${actualPort}`);

  return {
    host: actualHost,
    port: actualPort,
    server,
    webSockets,
    async close() {
      for (const client of webSockets.clients) client.terminate();
      await Promise.all([
        new Promise((resolve) => webSockets.close(() => resolve())),
        new Promise((resolve) => server.close(() => resolve())),
      ]);
    },
  };
}

async function main() {
  const port = Number(process.env.PORT ?? process.env.COORDINATOR_PORT ?? 8787);
  const host = process.env.COORDINATOR_HOST ?? "0.0.0.0";
  await startCoordinator({ host, port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
