import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { httpsUpgradeLocation, redirectHttpRequestToHttps } from "../src/http-upgrade.js";
import { classifyConnection, compareProxyQuality } from "../src/public/network.js";
import { megabitsPerSecond, parseCloudflareTrace } from "../src/public/probe.js";
import { parseProxyLines } from "../src/public/sources.js";
import { PublicProxyPool, uniqueExitIps } from "../src/public/pool.js";
import { connectViaProxy } from "../src/public/tunnel.js";
import { startPublicMode } from "../src/public.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

async function roundTrip(socket, value) {
  const received = once(socket, "data");
  socket.write(value);
  const [data] = await received;
  return data;
}

test("plain HTTP proxy requests are safely upgraded to HTTPS", async () => {
  assert.equal(
    httpsUpgradeLocation("http://crackle.com/watch/free?genre=comedy", "crackle.com"),
    "https://crackle.com/watch/free?genre=comedy",
  );
  assert.equal(httpsUpgradeLocation("/watch", "www.crackle.com"), "https://www.crackle.com/watch");
  assert.throws(() => httpsUpgradeLocation("http://127.0.0.1/"), /DNS hostnames/);
  assert.throws(() => httpsUpgradeLocation("http://crackle.com:8080/"), /standard HTTP port/);

  const server = http.createServer((request, response) => redirectHttpRequestToHttps(request, response, "MeshHop Public"));
  const port = await listen(server);
  try {
    const result = await new Promise((resolve, reject) => {
      const request = http.get({
        host: "127.0.0.1",
        port,
        path: "http://crackle.com/",
        headers: { host: "crackle.com" },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve({ status: response.statusCode, location: response.headers.location }));
      });
      request.once("error", reject);
    });
    assert.deepEqual(result, { status: 308, location: "https://crackle.com/" });
  } finally {
    await close(server);
  }
});

test("public proxy source parser accepts supported public endpoints and removes unsafe entries", () => {
  const parsed = parseProxyLines(`
http://8.8.8.8:8080
socks5://1.1.1.1:1080
socks4://9.9.9.9:9050
https://208.67.222.222:443
http://127.0.0.1:8080
ftp://8.8.4.4:21
broken
  `);
  assert.deepEqual(parsed, [
    { protocol: "http", host: "8.8.8.8", port: 8080 },
    { protocol: "socks5", host: "1.1.1.1", port: 1080 },
    { protocol: "socks4", host: "9.9.9.9", port: 9050 },
    { protocol: "https", host: "208.67.222.222", port: 443 },
  ]);
});

test("network heuristics balance consumer-looking networks against latency", () => {
  assert.equal(classifyConnection({ isp: "Comcast Cable Communications" }), "consumer-likely");
  assert.equal(classifyConnection({ org: "Amazon Data Services" }), "hosting-likely");
  assert.equal(classifyConnection({ isp: "Unfamiliar Network LLC" }), "unknown");

  const consumer = { latencyMs: 2300, throughputMbps: 5, network: { kind: "consumer-likely" } };
  const hosting = { latencyMs: 1000, throughputMbps: 8, network: { kind: "hosting-likely" } };
  assert.ok(compareProxyQuality(consumer, hosting) < 0);
  const verySlowConsumer = { latencyMs: 5000, throughputMbps: 0.5, network: { kind: "consumer-likely" } };
  assert.ok(compareProxyQuality(verySlowConsumer, hosting) > 0);
  assert.ok(compareProxyQuality(consumer, hosting, "speed") > 0);
  assert.ok(compareProxyQuality(verySlowConsumer, hosting, "consumer") < 0);
});

test("speed ranking uses transfer throughput rather than latency alone", () => {
  assert.equal(megabitsPerSecond(250_000, 1_000), 2);
  const lowLatencyButSlow = { latencyMs: 200, throughputMbps: 0.5 };
  const higherLatencyButFast = { latencyMs: 700, throughputMbps: 10 };
  assert.ok(compareProxyQuality(higherLatencyButFast, lowLatencyButSlow, "speed") < 0);
});

test("strict IP mode records failure without rotating the active exit", () => {
  const current = { protocol: "http", host: "8.8.8.8", port: 8080, exitIp: "1.1.1.1", failures: 0 };
  const fallback = { protocol: "http", host: "9.9.9.9", port: 8080, exitIp: "2.2.2.2", failures: 0 };
  const strict = new PublicProxyPool({ autoFallback: false });
  strict.proxies = [current, fallback];
  strict.reportFailure(current);
  strict.reportFailure(current);
  strict.reportFailure(current);
  assert.equal(strict.current.exitIp, "1.1.1.1");
  assert.equal(strict.current.failures, 3);
  assert.equal(strict.current.consecutiveFailures, 3);

  const automatic = new PublicProxyPool({ autoFallback: true });
  automatic.proxies = [
    { ...current, failures: 0, consecutiveFailures: 0 },
    { ...fallback, failures: 0, consecutiveFailures: 0 },
  ];
  automatic.reportFailure(automatic.current);
  assert.equal(automatic.current.exitIp, "1.1.1.1");
  automatic.reportFailure(automatic.current);
  assert.equal(automatic.current.exitIp, "1.1.1.1");
  automatic.reportFailure(automatic.current);
  assert.equal(automatic.current.exitIp, "2.2.2.2");
});

test("a successful tunnel resets the consecutive failure threshold", () => {
  const current = { protocol: "http", host: "8.8.8.8", port: 8080, exitIp: "1.1.1.1", failures: 0, successes: 0 };
  const fallback = { protocol: "http", host: "9.9.9.9", port: 8080, exitIp: "2.2.2.2", failures: 0, successes: 0 };
  const pool = new PublicProxyPool({ autoFallback: true });
  pool.proxies = [current, fallback];
  pool.reportFailure(current);
  pool.reportFailure(current);
  pool.reportSuccess(current);
  pool.reportFailure(current);
  assert.equal(pool.current.exitIp, "1.1.1.1");
  assert.equal(pool.current.consecutiveFailures, 1);
});

test("a late success from an old exit cannot switch the active IP back", () => {
  const oldExit = { protocol: "http", host: "8.8.8.8", port: 8080, exitIp: "1.1.1.1", failures: 0, successes: 0 };
  const newExit = { protocol: "http", host: "9.9.9.9", port: 8080, exitIp: "2.2.2.2", failures: 0, successes: 0 };
  const pool = new PublicProxyPool({ autoFallback: true });
  pool.proxies = [oldExit, newExit];
  pool.rotate();
  pool.reportSuccess(oldExit);
  assert.equal(pool.current.exitIp, "2.2.2.2");
  assert.equal(oldExit.successes, 1);
});

test("fallback pools retain only distinct observed exit IPs", () => {
  const distinct = uniqueExitIps([
    { host: "first", exitIp: "216.38.28.47" },
    { host: "duplicate-port", exitIp: "216.38.28.47" },
    { host: "second", exitIp: "8.8.8.8" },
  ]);
  assert.deepEqual(distinct.map((proxy) => proxy.host), ["first", "second"]);
});

test("Cloudflare trace parser extracts observed IP and country", () => {
  assert.deepEqual(parseCloudflareTrace("ip=8.8.8.8\nloc=US\nwarp=off\n"), {
    ip: "8.8.8.8",
    loc: "US",
    warp: "off",
  });
});

test("HTTP CONNECT upstream creates a working tunnel", async () => {
  const proxyServer = net.createServer((socket) => {
    socket.once("data", (header) => {
      assert.match(header.toString("latin1"), /^CONNECT example\.com:443 HTTP\/1\.1/);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.on("data", (data) => socket.write(data));
    });
  });
  const port = await listen(proxyServer);
  let tunnel;
  try {
    tunnel = await connectViaProxy({ protocol: "http", host: "127.0.0.1", port }, "example.com", 443);
    assert.deepEqual(await roundTrip(tunnel, Buffer.from("hello")), Buffer.from("hello"));
  } finally {
    tunnel?.destroy();
    await close(proxyServer);
  }
});

test("startPublicMode survives a failed initial discovery and starts empty", async () => {
  const warnings = [];
  const logger = { info() {}, warn: (message) => warnings.push(message), error() {} };
  const app = await startPublicMode({
    // A refused loopback source makes the first discovery fail without any
    // outbound network access.
    sourceUrls: ["http://127.0.0.1:1/none"],
    listenPort: 0,
    controlPort: 0,
    refreshMinutes: 60,
    logger,
  });
  try {
    assert.equal(app.pool.current, null);
    assert.equal(app.pool.status().proxies.length, 0);
    assert.ok(warnings.some((message) => /Initial proxy discovery failed/.test(message)));
    const status = await fetch(`http://127.0.0.1:${app.controlPort}/api/status`).then((r) => r.json());
    assert.equal(status.proxies.length, 0);
  } finally {
    await app.close();
  }
});

test("SOCKS5 encodes an IPv4 literal target as an address, not a hostname", async () => {
  let request;
  const proxyServer = net.createServer((socket) => {
    let stage = 0;
    socket.on("data", (data) => {
      if (stage === 0) {
        stage = 1;
        socket.write(Buffer.from([0x05, 0x00]));
      } else if (stage === 1) {
        request = data;
        stage = 2;
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      } else {
        socket.write(data);
      }
    });
  });
  const port = await listen(proxyServer);
  let tunnel;
  try {
    tunnel = await connectViaProxy({ protocol: "socks5", host: "127.0.0.1", port }, "203.0.113.7", 443);
    // VER, CMD, RSV, ATYP=0x01 (IPv4), then the four address octets and port.
    assert.deepEqual(request.subarray(0, 4), Buffer.from([0x05, 0x01, 0x00, 0x01]));
    assert.deepEqual(request.subarray(4, 8), Buffer.from([203, 0, 113, 7]));
    assert.equal(request.readUInt16BE(8), 443);
  } finally {
    tunnel?.destroy();
    await close(proxyServer);
  }
});

test("an expired connect deadline rejects without leaking an errored socket", async () => {
  // Bind then immediately release a loopback port so connections to it are
  // refused. With the previous code, an already-expired deadline created a
  // socket with no error listener; the refused connection then surfaced as an
  // uncaught 'error' that crashed the engine. A clean rejection is expected.
  const placeholder = net.createServer();
  const port = await listen(placeholder);
  await close(placeholder);
  await assert.rejects(
    () => connectViaProxy({ protocol: "http", host: "127.0.0.1", port }, "example.com", 443, 0),
    /timed out/,
  );
});

test("unauthenticated SOCKS5 upstream creates a working tunnel", async () => {
  const proxyServer = net.createServer((socket) => {
    let stage = 0;
    socket.on("data", (data) => {
      if (stage === 0) {
        assert.deepEqual(data, Buffer.from([0x05, 0x01, 0x00]));
        stage = 1;
        socket.write(Buffer.from([0x05, 0x00]));
      } else if (stage === 1) {
        assert.equal(data[0], 0x05);
        assert.equal(data[1], 0x01);
        stage = 2;
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      } else {
        socket.write(data);
      }
    });
  });
  const port = await listen(proxyServer);
  let tunnel;
  try {
    tunnel = await connectViaProxy({ protocol: "socks5", host: "127.0.0.1", port }, "example.com", 443);
    assert.deepEqual(await roundTrip(tunnel, Buffer.from("hello")), Buffer.from("hello"));
  } finally {
    tunnel?.destroy();
    await close(proxyServer);
  }
});
