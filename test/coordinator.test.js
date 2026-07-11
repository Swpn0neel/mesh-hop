import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { createPairCode, derivePairMaterial } from "../src/crypto.js";
import { startCoordinator } from "../src/coordinator.js";

const silentLogger = { info() {}, warn() {}, error() {} };

function messageQueue(socket) {
  const queued = [];
  const waiters = [];
  socket.on("message", (data, isBinary) => {
    const message = { data: Buffer.from(data), isBinary };
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queued.push(message);
  });
  return {
    next() {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    async until(predicate) {
      for (;;) {
        const message = await this.next();
        if (predicate(message)) return message;
      }
    },
  };
}

test("coordinator authenticates a pair and forwards only opaque binary frames", async () => {
  const coordinator = await startCoordinator({ host: "127.0.0.1", port: 0, logger: silentLogger });
  const material = derivePairMaterial(createPairCode());
  const baseUrl = `ws://127.0.0.1:${coordinator.port}/relay?room=${material.roomId}`;
  const client = new WebSocket(`${baseUrl}&role=client`);
  const exit = new WebSocket(`${baseUrl}&role=exit`);
  const clientMessages = messageQueue(client);
  const exitMessages = messageQueue(exit);

  try {
    await Promise.all([once(client, "open"), once(exit, "open")]);
    client.send(JSON.stringify({ type: "auth", token: material.roomToken }));
    exit.send(JSON.stringify({ type: "auth", token: material.roomToken }));

    const isReady = ({ data, isBinary }) =>
      !isBinary && JSON.parse(data.toString("utf8")).type === "peer-ready";
    await Promise.all([clientMessages.until(isReady), exitMessages.until(isReady)]);

    const opaque = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const forwardedPromise = exitMessages.until(({ isBinary }) => isBinary);
    client.send(opaque, { binary: true });
    const forwarded = await forwardedPromise;
    assert.equal(forwarded.isBinary, true);
    assert.deepEqual(forwarded.data, opaque);
  } finally {
    client.terminate();
    exit.terminate();
    await coordinator.close();
  }
});
