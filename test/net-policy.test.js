import assert from "node:assert/strict";
import test from "node:test";
import {
  isDomainAllowed,
  isPublicAddress,
  normalizeDomain,
  parseAllowlist,
  parseConnectAuthority,
  resolvePublicAddresses,
  validateDestination,
} from "../src/net-policy.js";

test("domain policy supports exact and suffix rules", () => {
  const rules = parseAllowlist("example.com, *.openai.com");
  assert.equal(isDomainAllowed("example.com", rules), true);
  assert.equal(isDomainAllowed("api.openai.com", rules), true);
  assert.equal(isDomainAllowed("notopenai.com", rules), false);
  assert.equal(isDomainAllowed("other.example.com", rules), false);
});

test("destination policy permits only approved HTTPS hostnames", () => {
  const rules = parseAllowlist("example.com");
  assert.deepEqual(validateDestination("EXAMPLE.COM.", 443, { rules }), {
    host: "example.com",
    port: 443,
  });
  assert.throws(() => validateDestination("example.com", 80, { rules }), /port 443/);
  assert.throws(() => validateDestination("127.0.0.1", 443, { rules }), /hostnames/);
  assert.throws(() => validateDestination("other.example", 443, { rules }), /not allowed/);
});

test("CONNECT authority parsing rejects malformed and IP destinations", () => {
  assert.deepEqual(parseConnectAuthority("example.com:443"), { host: "example.com", port: 443 });
  assert.throws(() => parseConnectAuthority("example.com"), /include a port/);
  assert.throws(() => parseConnectAuthority("10.0.0.1:443"), /hostnames/);
});

test("IP policy distinguishes internet addresses from local and reserved ranges", () => {
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const address of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "::1", "fc00::1", "fe80::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("DNS validation rejects a hostname if any answer is private", async () => {
  const mixedLookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await assert.rejects(() => resolvePublicAddresses("example.com", mixedLookup), /private or reserved/);

  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  assert.deepEqual(await resolvePublicAddresses("example.com", publicLookup), [
    { address: "93.184.216.34", family: 4 },
  ]);
});

test("international domains normalize to ASCII", () => {
  assert.equal(normalizeDomain("bücher.example"), "xn--bcher-kva.example");
});
