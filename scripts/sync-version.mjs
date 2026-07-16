// Keeps the app version in sync across the files that declare it, using the root
// package.json as the single source of truth.
//
//   node scripts/sync-version.mjs          # rewrite the other files to match
//   node scripts/sync-version.mjs --check  # exit non-zero if anything is stale
//
// Run --check in CI so a version bump can never drift between package.json,
// tauri.conf.json, Cargo.toml, runtime user-agent, the README, and the website.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json version "${version}" is not a plain semver x.y.z`);
}

const targets = [
  {
    file: "src-tauri/tauri.conf.json",
    update: (text) => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
  },
  {
    // Only the [package] version is line-anchored; dependency versions are inline.
    file: "src-tauri/Cargo.toml",
    update: (text) => text.replace(/^version = "[^"]+"/m, `version = "${version}"`),
  },
  {
    file: "src/public/user-agent.js",
    update: (text) => text.replace(/MeshHop-Public\/\d+\.\d+\.\d+/, `MeshHop-Public/${version}`),
  },
  {
    file: "README.md",
    update: (text) => text.replace(/Current stable release:\s*`[^`]+`/, `Current stable release: \`${version}\``),
  },
  {
    file: "website/src/lib/release.ts",
    update: (text) => text.replace(/(RELEASE_VERSION\s*=\s*")[^"]+(")/, `$1${version}$2`),
  },
];

const stale = [];
for (const { file, update } of targets) {
  const absolute = path.join(root, file);
  const current = readFileSync(absolute, "utf8");
  const next = update(current);
  if (next === current) continue;
  if (checkOnly) {
    stale.push(file);
  } else {
    writeFileSync(absolute, next);
    console.log(`Updated ${file} -> ${version}`);
  }
}

if (checkOnly && stale.length > 0) {
  console.error(`Version ${version} is out of sync in:\n  ${stale.join("\n  ")}`);
  console.error("Run: npm run version:sync");
  process.exit(1);
}
console.log(checkOnly ? `Version ${version} is in sync across all files.` : "Version sync complete.");
