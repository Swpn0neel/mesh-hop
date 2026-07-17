import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { httpsUpgradeLocation, redirectHttpRequestToHttps } from "../src/http-upgrade.js";
import { classifyConnection, compareProxyQuality } from "../src/public/network.js";
import {
  classifyProbeError,
  formatFailureSummary,
  parseCloudflareTrace,
  tallyFailure,
} from "../src/public/probe.js";
import {
  adaptiveMaxCandidates,
  parseProxyLines,
} from "../src/public/sources.js";
import { diversifyByAsn, PublicProxyPool, uniqueExitIps } from "../src/public/pool.js";
import { connectViaProxy } from "../src/public/tunnel.js";
import { USER_AGENT } from "../src/public/user-agent.js";
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

test("parser accepts bare host:port lines with an explicit default protocol", () => {
  const parsed = parseProxyLines("8.8.8.8:8080\n1.1.1.1:1080", { defaultProtocol: "socks5" });
  assert.deepEqual(parsed, [
    { protocol: "socks5", host: "8.8.8.8", port: 8080 },
    { protocol: "socks5", host: "1.1.1.1", port: 1080 },
  ]);
});

test("adaptiveMaxCandidates samples more aggressively for lower-supply countries", () => {
  assert.equal(adaptiveMaxCandidates(500, 160, "US"), 160);
  assert.equal(adaptiveMaxCandidates(500, 160, "JP"), 240);
  assert.equal(adaptiveMaxCandidates(100, 160, "JP"), 100);
  assert.equal(adaptiveMaxCandidates(0, 160, "US"), 0);
});

test("diversifyByAsn prefers distinct ASNs when filling the pool", () => {
  const proxies = [
    { exitIp: "1.1.1.1", network: { asn: 100 } },
    { exitIp: "1.1.1.2", network: { asn: 100 } },
    { exitIp: "2.2.2.2", network: { asn: 200 } },
    { exitIp: "3.3.3.3", network: { asn: 300 } },
    { exitIp: "4.4.4.4", network: { asn: 100 } },
  ];
  const selected = diversifyByAsn(proxies, 3);
  assert.equal(selected.length, 3);
  const asns = selected.map((proxy) => proxy.network.asn);
  assert.deepEqual(asns, [100, 200, 300]);
});

test("network heuristics balance consumer-looking networks against latency", () => {
  assert.equal(classifyConnection({ isp: "Comcast Cable Communications" }), "consumer-likely");
  assert.equal(classifyConnection({ isp: "Deutsche Telekom AG" }), "consumer-likely");
  assert.equal(classifyConnection({ isp: "NTT Communications" }), "consumer-likely");
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

test("selectExit switches directly to a specific verified exit", () => {
  const first = { protocol: "http", host: "8.8.8.8", port: 8080, exitIp: "1.1.1.1" };
  const second = { protocol: "socks5", host: "9.9.9.9", port: 1080, exitIp: "2.2.2.2" };
  const pool = new PublicProxyPool({ autoFallback: true });
  pool.proxies = [first, second];
  assert.equal(pool.selectExit({ protocol: "socks5", host: "9.9.9.9", port: 1080 }).exitIp, "2.2.2.2");
  assert.equal(pool.current.exitIp, "2.2.2.2");
  // An exit not in the current pool (e.g. dropped by a refresh) is rejected
  // without disturbing the active selection.
  assert.equal(pool.selectExit({ protocol: "http", host: "10.0.0.1", port: 1 }), null);
  assert.equal(pool.current.exitIp, "2.2.2.2");
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

test("probe failure classification and summary explain empty pools", () => {
  assert.equal(classifyProbeError(new Error("Proxy handshake timed out")), "timeout");
  assert.equal(classifyProbeError(new Error("Observed country was DE")), "wrong-country");
  assert.equal(classifyProbeError(new Error("connect ECONNREFUSED")), "connect");
  const counts = new Map();
  tallyFailure(counts, new Error("Proxy connection timed out"));
  tallyFailure(counts, new Error("Proxy connection timed out"));
  tallyFailure(counts, new Error("Observed country was GB"));
  assert.match(formatFailureSummary(counts, 40), /Of 40 sampled: 2 timed out, 1 wrong exit country/);
});

test("pool emits structured progress events during refresh", async () => {
  const stages = [];
  const pool = new PublicProxyPool({
    sourceUrls: ["http://127.0.0.1:1/none"],
    logger: { info() {}, warn() {}, error() {} },
  });
  pool.on("progress", (progress) => stages.push(progress.stage));
  await assert.rejects(() => pool.refresh(), /No supported proxies|None of|failed/i);
  assert.ok(stages.includes("fetch"));
  assert.ok(pool.status().lastDiscoveryError);
});

test("blockExit removes an IP from the pool and rotates when needed", () => {
  const first = { protocol: "http", host: "8.8.8.8", port: 8080, exitIp: "1.1.1.1" };
  const second = { protocol: "http", host: "9.9.9.9", port: 8080, exitIp: "2.2.2.2" };
  const pool = new PublicProxyPool({
    blockedExitIps: ["1.1.1.1"],
    logger: { info() {}, warn() {}, error() {} },
  });
  pool.proxies = [first, second];
  // Constructor blocklist does not retroactively strip an injected pool; blockExit does.
  pool.blockExit("1.1.1.1");
  assert.equal(pool.proxies.length, 1);
  assert.equal(pool.current.exitIp, "2.2.2.2");
  assert.ok(pool.status().blockedExitIps.includes("1.1.1.1"));
  assert.equal(pool.selectExit({ protocol: "http", host: "8.8.8.8", port: 8080 }), null);
});

test("heartbeat reports success and failure against the active exit", async () => {
  const pool = new PublicProxyPool({ autoFallback: true, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(await pool.heartbeat(), null);

  const current = {
    protocol: "http",
    host: "127.0.0.1",
    port: 1,
    exitIp: "1.1.1.1",
    failures: 0,
    consecutiveFailures: 0,
    successes: 0,
  };
  const fallback = {
    protocol: "http",
    host: "127.0.0.1",
    port: 2,
    exitIp: "2.2.2.2",
    failures: 0,
    consecutiveFailures: 0,
    successes: 0,
  };
  pool.proxies = [current, fallback];
  pool.currentIndex = 0;

  // Port 1 is closed → heartbeat fails and counts toward the failure threshold.
  const first = await pool.heartbeat();
  assert.equal(first.ok, false);
  assert.equal(pool.current.consecutiveFailures, 1);

  await pool.heartbeat();
  await pool.heartbeat();
  assert.equal(pool.current.exitIp, "2.2.2.2");
});

test("HTTP CONNECT upstream creates a working tunnel", async () => {
  const proxyServer = net.createServer((socket) => {
    socket.once("data", (header) => {
      const text = header.toString("latin1");
      assert.match(text, /^CONNECT example\.com:443 HTTP\/1\.1/);
      assert.ok(text.includes(`User-Agent: ${USER_AGENT}\r\n`));
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
    heartbeatSeconds: 0,
    logger,
  });
  try {
    assert.equal(app.pool.current, null);
    assert.equal(app.pool.status().proxies.length, 0);
    assert.ok(app.pool.status().lastDiscoveryError);
    assert.ok(warnings.some((message) => /Initial proxy discovery failed/.test(message)));
    const status = await fetch(`http://127.0.0.1:${app.controlPort}/api/status`).then((r) => r.json());
    assert.equal(status.proxies.length, 0);
    assert.ok(status.lastDiscoveryError);
  } finally {
    await app.close();
  }
});

test("desktop control endpoints require the configured bearer token", async () => {
  const app = await startPublicMode({
    sourceUrls: ["http://127.0.0.1:1/none"],
    listenPort: 0,
    controlPort: 0,
    controlToken: "test-control-token",
    refreshMinutes: 60,
    heartbeatSeconds: 0,
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    const base = `http://127.0.0.1:${app.controlPort}`;
    const unauthorized = await fetch(`${base}/api/status`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${base}/api/status`, {
      headers: { authorization: "Bearer test-control-token" },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual((await authorized.json()).proxies, []);

    const unauthorizedRotate = await fetch(`${base}/api/rotate`, { method: "POST" });
    assert.equal(unauthorizedRotate.status, 401);
  } finally {
    await app.close();
  }
});

test("the /api/select route switches to a specific exit and rejects unknown ones", async () => {
  const app = await startPublicMode({
    sourceUrls: ["http://127.0.0.1:1/none"],
    listenPort: 0,
    controlPort: 0,
    refreshMinutes: 60,
    heartbeatSeconds: 0,
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    const first = { protocol: "http", host: "8.8.8.8", port: 8080, exitIp: "1.1.1.1" };
    const second = { protocol: "socks5", host: "9.9.9.9", port: 1080, exitIp: "2.2.2.2" };
    app.pool.proxies = [first, second];
    app.pool.currentIndex = 0;
    const base = `http://127.0.0.1:${app.controlPort}`;

    const selected = await fetch(`${base}/api/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: "socks5", host: "9.9.9.9", port: 1080 }),
    });
    assert.equal(selected.status, 200);
    assert.equal((await selected.json()).current.exitIp, "2.2.2.2");

    const unknown = await fetch(`${base}/api/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: "http", host: "10.0.0.1", port: 1 }),
    });
    assert.equal(unknown.status, 404);
    assert.equal(app.pool.current.exitIp, "2.2.2.2");

    const malformed = await fetch(`${base}/api/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: "http" }),
    });
    assert.equal(malformed.status, 400);
  } finally {
    await app.close();
  }
});

test("startPublicMode reports an occupied proxy port before discovery", async () => {
  const blocker = net.createServer();
  const port = await listen(blocker);
  try {
    await assert.rejects(
      () => startPublicMode({
        sourceUrls: ["http://127.0.0.1:1/should-not-be-fetched"],
        listenPort: port,
        controlPort: 0,
        logger: { info() {}, warn() {}, error() {} },
      }),
      new RegExp(`browser proxy port ${port} is already in use`),
    );
  } finally {
    await close(blocker);
  }
});

test("a control-port bind failure releases the already-bound proxy port", async () => {
  const proxyReservation = net.createServer();
  const proxyPort = await listen(proxyReservation);
  await close(proxyReservation);

  const controlBlocker = net.createServer();
  const controlPort = await listen(controlBlocker);
  try {
    await assert.rejects(
      () => startPublicMode({
        sourceUrls: ["http://127.0.0.1:1/should-not-be-fetched"],
        listenPort: proxyPort,
        controlPort,
        logger: { info() {}, warn() {}, error() {} },
      }),
      new RegExp(`control port ${controlPort} is already in use`),
    );

    const rebound = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        rebound.once("error", reject);
        rebound.listen(proxyPort, "127.0.0.1", resolve);
      });
    } finally {
      await close(rebound);
    }
  } finally {
    await close(controlBlocker);
  }
});

test("closing public mode destroys active sockets and is idempotent", async () => {
  const app = await startPublicMode({
    sourceUrls: ["http://127.0.0.1:1/none"],
    listenPort: 0,
    controlPort: 0,
    refreshMinutes: 60,
    heartbeatSeconds: 0,
    logger: { info() {}, warn() {}, error() {} },
  });
  const socket = net.connect(app.proxyPort, "127.0.0.1");
  await once(socket, "connect");
  const closed = once(socket, "close");
  await app.close();
  await closed;
  await app.close();
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
