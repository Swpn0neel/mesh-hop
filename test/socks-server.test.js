import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import { tunnelThroughPool } from "../src/public/relay.js";
import { createSocksServer } from "../src/public/socks-server.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

// A minimal fake upstream that speaks the HTTP CONNECT protocol our tunnel
// client uses, then echoes any bytes sent to it — enough to exercise the
// SOCKS server's tunnel-and-pipe logic without a real public proxy or exit.
function createFakeUpstreamHttpProxy() {
  return net.createServer((socket) => {
    socket.once("data", (header) => {
      if (!/^CONNECT /.test(header.toString("latin1"))) {
        socket.destroy();
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.on("data", (data) => socket.write(data));
    });
  });
}

function fakePool(proxy, overrides = {}) {
  return {
    current: proxy,
    reportSuccess() {},
    reportFailure() {},
    ...overrides,
  };
}

function socksGreeting() {
  return Buffer.from([0x05, 0x01, 0x00]); // VER, NMETHODS=1, METHODS=[no-auth]
}

function socksConnectRequest(host, port) {
  const domain = Buffer.from(host, "utf8");
  const request = Buffer.alloc(7 + domain.length);
  request.set([0x05, 0x01, 0x00, 0x03, domain.length], 0);
  domain.copy(request, 5);
  request.writeUInt16BE(port, 5 + domain.length);
  return request;
}

test("tunnelThroughPool retries once the pool rotates away from a failing exit", async () => {
  const upstream = createFakeUpstreamHttpProxy();
  const upstreamPort = await listen(upstream);
  const bad = { protocol: "http", host: "127.0.0.1", port: 1 }; // nothing listening there
  const good = { protocol: "http", host: "127.0.0.1", port: upstreamPort };
  const pool = fakePool(bad, {
    reportFailure() { this.current = good; }, // simulate the pool rotating after a failure
  });
  const clientSocket = new net.Socket();
  let tunnel;
  try {
    const result = await tunnelThroughPool(pool, clientSocket, "example.com", 443, { maxAttempts: 3 });
    tunnel = result.upstream;
    assert.equal(result.proxy, good);
    assert.ok(tunnel);
  } finally {
    tunnel?.destroy();
    await close(upstream);
  }
});

test("tunnelThroughPool reports no upstream when the pool has no current exit", async () => {
  const pool = fakePool(null);
  const clientSocket = new net.Socket();
  const result = await tunnelThroughPool(pool, clientSocket, "example.com", 443);
  assert.equal(result.upstream, null);
  assert.deepEqual(result.failures, []);
});

test("SOCKS server tunnels a CONNECT request through the pool's current exit", async () => {
  const upstream = createFakeUpstreamHttpProxy();
  const upstreamPort = await listen(upstream);
  const pool = fakePool({ protocol: "http", host: "127.0.0.1", port: upstreamPort });
  const socksServer = createSocksServer(pool, { connectTimeoutMs: 2_000 });
  const socksPort = await listen(socksServer);

  const client = net.createConnection({ host: "127.0.0.1", port: socksPort });
  try {
    await once(client, "connect");
    client.write(socksGreeting());
    const [methodReply] = await once(client, "data");
    assert.deepEqual(methodReply, Buffer.from([0x05, 0x00]));

    client.write(socksConnectRequest("example.com", 443));
    const [connectReply] = await once(client, "data");
    assert.equal(connectReply[0], 0x05);
    assert.equal(connectReply[1], 0x00); // OK

    client.write(Buffer.from("hello"));
    const [echoed] = await once(client, "data");
    assert.deepEqual(echoed, Buffer.from("hello"));
  } finally {
    client.destroy();
    await close(socksServer);
    await close(upstream);
  }
});

test("SOCKS server rejects a non-443 destination port", async () => {
  const pool = fakePool({ protocol: "http", host: "127.0.0.1", port: 1 });
  const socksServer = createSocksServer(pool);
  const socksPort = await listen(socksServer);

  const client = net.createConnection({ host: "127.0.0.1", port: socksPort });
  try {
    await once(client, "connect");
    client.write(socksGreeting());
    await once(client, "data");
    client.write(socksConnectRequest("example.com", 80));
    const [reply] = await once(client, "data");
    assert.equal(reply[0], 0x05);
    assert.equal(reply[1], 0x02); // NOT_ALLOWED
  } finally {
    client.destroy();
    await close(socksServer);
  }
});

test("SOCKS server rejects a BIND command (CONNECT only)", async () => {
  const socksServer = createSocksServer(fakePool(null));
  const socksPort = await listen(socksServer);

  const client = net.createConnection({ host: "127.0.0.1", port: socksPort });
  try {
    await once(client, "connect");
    client.write(socksGreeting());
    await once(client, "data");
    const domain = Buffer.from("example.com", "utf8");
    const request = Buffer.alloc(7 + domain.length);
    request.set([0x05, 0x02 /* BIND */, 0x00, 0x03, domain.length], 0);
    domain.copy(request, 5);
    request.writeUInt16BE(443, 5 + domain.length);
    client.write(request);
    const [reply] = await once(client, "data");
    assert.equal(reply[0], 0x05);
    assert.equal(reply[1], 0x07); // COMMAND_NOT_SUPPORTED
  } finally {
    client.destroy();
    await close(socksServer);
  }
});

test("SOCKS server reports host-unreachable when the pool has no exit", async () => {
  const socksServer = createSocksServer(fakePool(null));
  const socksPort = await listen(socksServer);

  const client = net.createConnection({ host: "127.0.0.1", port: socksPort });
  try {
    await once(client, "connect");
    client.write(socksGreeting());
    await once(client, "data");
    client.write(socksConnectRequest("example.com", 443));
    const [reply] = await once(client, "data");
    assert.equal(reply[0], 0x05);
    assert.equal(reply[1], 0x04); // HOST_UNREACHABLE
  } finally {
    client.destroy();
    await close(socksServer);
  }
});

test("SOCKS server rejects an unsupported authentication-method offer", async () => {
  const socksServer = createSocksServer(fakePool(null));
  const socksPort = await listen(socksServer);

  const client = net.createConnection({ host: "127.0.0.1", port: socksPort });
  try {
    await once(client, "connect");
    // Offer only username/password auth (0x02) — the server only accepts "no auth".
    client.write(Buffer.from([0x05, 0x01, 0x02]));
    const [reply] = await once(client, "data");
    assert.deepEqual(reply, Buffer.from([0x05, 0xff]));
  } finally {
    client.destroy();
    await close(socksServer);
  }
});
