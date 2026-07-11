import assert from "node:assert/strict";
import test from "node:test";
import { parseCloudflareTrace } from "../src/public/probe.js";
import { httpsGetViaProxy } from "../src/public/tunnel.js";
import { startPublicMode } from "../src/public.js";

test("public live: discover, rank, and browse through a verified US exit", { timeout: 60_000 }, async () => {
  const app = await startPublicMode({
    country: "US",
    listenPort: 0,
    controlPort: 0,
    maxCandidates: 40,
    probeConcurrency: 20,
    probeTimeoutMs: 5_000,
    poolSize: 5,
    refreshMinutes: 60,
  });
  try {
    console.log("Public pool ready; testing local proxy tunnel");
    const response = await httpsGetViaProxy(
      { protocol: "http", host: "127.0.0.1", port: app.proxyPort },
      { host: "www.cloudflare.com", path: "/cdn-cgi/trace", timeoutMs: 10_000 },
    );
    console.log("Local proxy tunnel returned; checking location");
    const trace = parseCloudflareTrace(response.body.toString("utf8"));
    assert.equal(response.statusCode, 200);
    assert.equal(trace.loc, "US");
    assert.equal(trace.ip, app.pool.current.exitIp);

    const status = await fetch(`http://127.0.0.1:${app.controlPort}/api/status`).then((value) => value.json());
    console.log("Control endpoint returned");
    assert.equal(status.country, "US");
    assert.ok(status.proxies.length > 0);
  } finally {
    console.log("Closing public mode");
    await app.close();
    console.log("Public mode closed");
  }
});
