import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { decryptFrame, derivePairMaterial, encryptFrame } from "./crypto.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function validateCoordinatorUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("COORDINATOR_URL is not a valid URL");
  }
  if (!new Set(["ws:", "wss:"]).has(url.protocol)) {
    throw new Error("COORDINATOR_URL must use ws:// or wss://");
  }
  if (url.protocol !== "wss:" && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error("A non-local coordinator must use wss://");
  }
  return url;
}

export class RelayConnection extends EventEmitter {
  constructor({ coordinatorUrl, pairCode, role, logger = console }) {
    super();
    if (!new Set(["client", "exit"]).has(role)) throw new Error("Invalid relay role");
    this.baseUrl = validateCoordinatorUrl(coordinatorUrl);
    this.material = derivePairMaterial(pairCode);
    this.role = role;
    this.logger = logger;
    this.socket = null;
    this.peerReady = false;
    this.stopped = false;
    this.retryMs = 500;
    this.retryTimer = null;
  }

  start() {
    this.stopped = false;
    this.#connect();
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.#setPeerReady(false);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
  }

  send(type, sessionId, payload) {
    if (!this.peerReady || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const encrypted = encryptFrame(this.material.key, type, sessionId, payload);
    if (this.socket.bufferedAmount > 4 * 1024 * 1024) {
      this.logger.warn?.("Relay buffer limit reached; closing the connection");
      this.socket.close(1013, "Backpressure limit");
      return false;
    }
    this.socket.send(encrypted, { binary: true });
    return true;
  }

  async waitForReady(timeoutMs = 10_000) {
    if (this.peerReady) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for the paired peer"));
      }, timeoutMs);
      const onState = (ready) => {
        if (!ready) return;
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off("peer-state", onState);
      };
      this.on("peer-state", onState);
    });
  }

  #setPeerReady(ready) {
    if (this.peerReady === ready) return;
    this.peerReady = ready;
    this.emit("peer-state", ready);
  }

  #scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.#connect();
    }, delay);
  }

  #connect() {
    if (this.stopped) return;
    const url = new URL(this.baseUrl);
    url.searchParams.set("room", this.material.roomId);
    url.searchParams.set("role", this.role);

    const socket = new WebSocket(url, { maxPayload: 600 * 1024 });
    this.socket = socket;

    socket.on("open", () => {
      this.retryMs = 500;
      socket.send(JSON.stringify({ type: "auth", token: this.material.roomToken }));
    });

    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        let message;
        try {
          message = JSON.parse(data.toString("utf8"));
        } catch {
          socket.close(1002, "Invalid control message");
          return;
        }
        if (message.type === "peer-ready") this.#setPeerReady(true);
        if (message.type === "peer-waiting") this.#setPeerReady(false);
        return;
      }

      try {
        this.emit("frame", decryptFrame(this.material.key, Buffer.from(data)));
      } catch (error) {
        this.logger.warn?.(`Dropped invalid encrypted frame: ${error.message}`);
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.#setPeerReady(false);
      this.#scheduleReconnect();
    });

    socket.on("error", (error) => {
      this.logger.warn?.(`Coordinator connection error: ${error.message}`);
    });
  }
}
