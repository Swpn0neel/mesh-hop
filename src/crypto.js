import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const PAIR_PREFIX = "mh1_";
const FRAME_VERSION = 1;
const FRAME_AAD = Buffer.from("meshhop/frame/v1", "utf8");
const MAX_FRAME_PAYLOAD = 512 * 1024;

export const FrameType = Object.freeze({
  OPEN: 1,
  DATA: 2,
  END: 3,
  ERROR: 4,
  OPEN_OK: 5,
});

const validFrameTypes = new Set(Object.values(FrameType));

export function createPairCode() {
  return `${PAIR_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function parsePairCode(pairCode) {
  if (typeof pairCode !== "string" || !pairCode.startsWith(PAIR_PREFIX)) {
    throw new Error("PAIR_CODE must begin with mh1_");
  }

  const encoded = pairCode.slice(PAIR_PREFIX.length);
  const secret = Buffer.from(encoded, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== encoded) {
    throw new Error("PAIR_CODE is malformed");
  }
  return secret;
}

function deriveHmac(secret, label) {
  return createHmac("sha256", secret).update(label, "utf8").digest();
}

export function derivePairMaterial(pairCode) {
  const secret = parsePairCode(pairCode);
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      Buffer.from("meshhop-v1", "utf8"),
      Buffer.from("frame-key", "utf8"),
      32,
    ),
  );

  return {
    key,
    roomId: deriveHmac(secret, "room-id").subarray(0, 16).toString("hex"),
    roomToken: deriveHmac(secret, "room-auth").toString("hex"),
  };
}

export function newSessionId() {
  return randomBytes(16);
}

export function sessionIdToKey(sessionId) {
  assertSessionId(sessionId);
  return sessionId.toString("hex");
}

function assertSessionId(sessionId) {
  if (!Buffer.isBuffer(sessionId) || sessionId.length !== 16) {
    throw new Error("Session ID must be a 16-byte Buffer");
  }
}

export function encryptFrame(key, type, sessionId, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Frame key must be a 32-byte Buffer");
  }
  if (!validFrameTypes.has(type)) {
    throw new Error("Unknown frame type");
  }
  assertSessionId(sessionId);
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME_PAYLOAD) {
    throw new Error(`Frame payload exceeds ${MAX_FRAME_PAYLOAD} bytes`);
  }

  const plaintext = Buffer.allocUnsafe(18 + body.length);
  plaintext[0] = FRAME_VERSION;
  plaintext[1] = type;
  sessionId.copy(plaintext, 2);
  body.copy(plaintext, 18);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(FRAME_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

export function decryptFrame(key, encrypted) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Frame key must be a 32-byte Buffer");
  }
  const frame = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
  if (frame.length < 12 + 18 + 16) {
    throw new Error("Encrypted frame is too short");
  }

  const iv = frame.subarray(0, 12);
  const tag = frame.subarray(frame.length - 16);
  const ciphertext = frame.subarray(12, frame.length - 16);

  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(FRAME_AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Frame authentication failed");
  }

  if (plaintext[0] !== FRAME_VERSION || !validFrameTypes.has(plaintext[1])) {
    throw new Error("Unsupported frame version or type");
  }

  return {
    type: plaintext[1],
    sessionId: Buffer.from(plaintext.subarray(2, 18)),
    payload: Buffer.from(plaintext.subarray(18)),
  };
}

export function tokensEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
