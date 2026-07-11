import assert from "node:assert/strict";
import http from "node:http";
import tls from "node:tls";
import test from "node:test";
import { startClient } from "../src/client.js";
import { startCoordinator } from "../src/coordinator.js";
import { createPairCode } from "../src/crypto.js";
import { startExit } from "../src/exit.js";

const silentLogger = { info() {}, warn() {}, error() {} };

function getThroughProxy(proxyPort) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: "example.com:443",
    });
    request.once("error", reject);
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT returned ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      const secureSocket = tls.connect(
        { socket, servername: "example.com", ALPNProtocols: ["http/1.1"] },
        () => {
          secureSocket.write(
            "GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\nUser-Agent: MeshHop-Test\r\n\r\n",
          );
        },
      );
      const chunks = [];
      secureSocket.on("data", (chunk) => chunks.push(chunk));
      secureSocket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      secureSocket.once("error", reject);
    });
    request.end();
  });
}

test("live: HTTPS reaches a public site through the paired exit", { timeout: 30_000 }, async () => {
  const coordinator = await startCoordinator({ host: "127.0.0.1", port: 0, logger: silentLogger });
  const pairCode = createPairCode();
  const coordinatorUrl = `ws://127.0.0.1:${coordinator.port}/relay`;
  const exit = await startExit({
    coordinatorUrl,
    pairCode,
    allowDomains: "example.com",
    logger: silentLogger,
  });
  const client = await startClient({
    coordinatorUrl,
    pairCode,
    listenPort: 0,
    logger: silentLogger,
  });

  try {
    await Promise.all([client.relay.waitForReady(), exit.relay.waitForReady()]);
    const response = await getThroughProxy(client.port);
    assert.match(response, /^HTTP\/1\.1 200 /);
    assert.match(response, /Example Domain/i);
  } finally {
    await client.close();
    await exit.close();
    await coordinator.close();
  }
});
