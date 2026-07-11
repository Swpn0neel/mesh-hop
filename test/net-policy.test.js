import assert from "node:assert/strict";
import test from "node:test";
import {
  isPublicAddress,
  normalizeConnectHost,
  normalizeDomain,
  parseConnectAuthority,
} from "../src/net-policy.js";

test("CONNECT authority parsing accepts hostnames, IP literals, and IPv6", () => {
  assert.deepEqual(parseConnectAuthority("example.com:443"), { host: "example.com", port: 443 });
  assert.deepEqual(parseConnectAuthority("10.0.0.1:443"), { host: "10.0.0.1", port: 443 });
  assert.deepEqual(parseConnectAuthority("[2606:4700:4700::1111]:443"), {
    host: "2606:4700:4700::1111",
    port: 443,
  });
  assert.deepEqual(parseConnectAuthority("intranet:443"), { host: "intranet", port: 443 });
  assert.throws(() => parseConnectAuthority("example.com"), /include a port/);
  assert.throws(() => parseConnectAuthority("example.com:https"), /port is invalid/);
  assert.throws(() => parseConnectAuthority("example.com:70000"), /port is invalid/);
});

test("CONNECT host normalization keeps IP literals and validates hostnames", () => {
  assert.equal(normalizeConnectHost("EXAMPLE.COM."), "example.com");
  assert.equal(normalizeConnectHost("8.8.8.8"), "8.8.8.8");
  assert.equal(normalizeConnectHost("2606:4700:4700::1111"), "2606:4700:4700::1111");
  assert.equal(normalizeConnectHost("intranet"), "intranet");
  assert.throws(() => normalizeConnectHost("bad_host!"), /invalid/);
});

test("IP policy distinguishes internet addresses from local and reserved ranges", () => {
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const address of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "::1", "fc00::1", "fe80::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("international domains normalize to ASCII", () => {
  assert.equal(normalizeDomain("bücher.example"), "xn--bcher-kva.example");
});
