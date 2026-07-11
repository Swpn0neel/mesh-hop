import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { httpsUpgradeLocation, redirectHttpRequestToHttps } from "../src/http-upgrade.js";

test("httpsUpgradeLocation upgrades absolute and relative targets, preserving path and query", () => {
  assert.equal(
    httpsUpgradeLocation("http://Example.COM/a/b?x=1&y=2", "example.com"),
    "https://example.com/a/b?x=1&y=2",
  );
  assert.equal(
    httpsUpgradeLocation("/only/path?q=1", "www.example.com"),
    "https://www.example.com/only/path?q=1",
  );
  assert.equal(httpsUpgradeLocation("http://example.com", "example.com"), "https://example.com/");
  // An explicit standard port is fine (the URL parser normalizes :80 away).
  assert.equal(httpsUpgradeLocation("http://example.com:80/p", "example.com"), "https://example.com/p");
});

test("httpsUpgradeLocation rejects unsupported or unsafe targets", () => {
  assert.throws(() => httpsUpgradeLocation("https://example.com/", "example.com"), /Only HTTP/);
  assert.throws(() => httpsUpgradeLocation("ftp://example.com/", "example.com"), /Only HTTP/);
  assert.throws(() => httpsUpgradeLocation("http://user:pass@example.com/", "example.com"), /Credentials/);
  assert.throws(() => httpsUpgradeLocation("http://example.com:8080/", "example.com"), /standard HTTP port/);
  assert.throws(() => httpsUpgradeLocation("http://127.0.0.1/", "127.0.0.1"), /DNS hostnames/);
  assert.throws(() => httpsUpgradeLocation("http://localhost/", "localhost"), /hostname is invalid/);
  assert.throws(() => httpsUpgradeLocation("", "example.com"), /malformed/);
  assert.throws(() => httpsUpgradeLocation(42, "example.com"), /malformed/);
  assert.throws(
    () => httpsUpgradeLocation(`http://example.com/${"a".repeat(9000)}`, "example.com"),
    /malformed/,
  );
  assert.throws(() => httpsUpgradeLocation("http://exa mple.com/", "example.com"), /malformed/);
});

async function requestThroughProxy(port, target, hostHeader) {
  return await new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: target, headers: { host: hostHeader } },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({ status: response.statusCode, location: response.headers.location }),
        );
      },
    );
    request.once("error", reject);
  });
}

test("redirectHttpRequestToHttps returns 308 for valid targets and 400 for unsafe ones", async () => {
  const server = http.createServer((request, response) =>
    redirectHttpRequestToHttps(request, response, "MeshHop"),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const ok = await requestThroughProxy(port, "http://example.com/p?q=1", "example.com");
    assert.deepEqual(ok, { status: 308, location: "https://example.com/p?q=1" });

    const bad = await requestThroughProxy(port, "http://127.0.0.1/", "127.0.0.1");
    assert.equal(bad.status, 400);
    assert.equal(bad.location, undefined);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
