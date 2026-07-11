import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asset = path.join(root, "src-tauri", "resources", "uBlock0_1.72.2.firefox.signed.xpi");
const expected = "40c315b0da7871868155ecfae7a50a58dfa0920aebd865e008214986f1b7c578";
const payload = await readFile(asset);
const actual = createHash("sha256").update(payload).digest("hex");

if (actual !== expected) {
  throw new Error(`Bundled uBlock Origin failed SHA-256 verification: expected ${expected}, received ${actual}`);
}
console.log(`Verified uBlock Origin 1.72.2 (${Math.round(payload.length / 1024)} KiB)`);
