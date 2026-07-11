import assert from "node:assert/strict";
import test from "node:test";
import {
  FrameType,
  createPairCode,
  decryptFrame,
  derivePairMaterial,
  encryptFrame,
  newSessionId,
  parsePairCode,
} from "../src/crypto.js";

test("pair codes contain a 256-bit secret and derive stable room material", () => {
  const pairCode = createPairCode();
  assert.equal(parsePairCode(pairCode).length, 32);
  assert.deepEqual(derivePairMaterial(pairCode), derivePairMaterial(pairCode));
  assert.notEqual(derivePairMaterial(pairCode).roomId, derivePairMaterial(createPairCode()).roomId);
});

test("encrypted frames round-trip without exposing their plaintext", () => {
  const { key } = derivePairMaterial(createPairCode());
  const sessionId = newSessionId();
  const payload = Buffer.from("example.com", "utf8");
  const encrypted = encryptFrame(key, FrameType.OPEN, sessionId, payload);

  assert.equal(encrypted.includes(payload), false);
  const decrypted = decryptFrame(key, encrypted);
  assert.equal(decrypted.type, FrameType.OPEN);
  assert.deepEqual(decrypted.sessionId, sessionId);
  assert.deepEqual(decrypted.payload, payload);
});

test("tampered encrypted frames are rejected", () => {
  const { key } = derivePairMaterial(createPairCode());
  const encrypted = encryptFrame(key, FrameType.DATA, newSessionId(), Buffer.from("hello"));
  encrypted[20] ^= 0xff;
  assert.throws(() => decryptFrame(key, encrypted), /authentication failed/);
});

test("malformed pair codes are rejected", () => {
  assert.throws(() => parsePairCode("not-a-pair-code"), /mh1_/);
  assert.throws(() => parsePairCode("mh1_short"), /malformed/);
});
