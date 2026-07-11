import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = path.join(root, "desktop-engine-build");
const binaryDirectory = path.join(root, "src-tauri", "binaries");
const bundlePath = path.join(buildDirectory, "meshhop-engine.cjs");
const blobPath = path.join(buildDirectory, "meshhop-engine.blob");
const configPath = path.join(buildDirectory, "sea-config.json");
const targetTriple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const extension = process.platform === "win32" ? ".exe" : "";
const binaryPath = path.join(binaryDirectory, `meshhop-engine-${targetTriple}${extension}`);

async function removeWithRetry(file) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(file, { force: true });
      return;
    } catch (error) {
      if (!new Set(["EPERM", "EBUSY", "EACCES"]).has(error.code) || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

mkdirSync(buildDirectory, { recursive: true });
mkdirSync(binaryDirectory, { recursive: true });

console.log("Bundling MeshHop proxy engine...");
await build({
  entryPoints: [path.join(root, "src", "desktop-engine.js")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logOverride: { "empty-import-meta": "silent" },
});

writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

console.log("Generating Node single-executable blob...");
execFileSync(process.execPath, ["--experimental-sea-config", configPath], {
  cwd: root,
  stdio: "inherit",
});

await removeWithRetry(binaryPath);
copyFileSync(process.execPath, binaryPath);

const postjectArgs = [
  path.join(root, "node_modules", "postject", "dist", "cli.js"),
  binaryPath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}

console.log(`Injecting sidecar for ${targetTriple}...`);
execFileSync(process.execPath, postjectArgs, { cwd: root, stdio: "inherit" });

if (!existsSync(binaryPath) || statSync(binaryPath).size < readFileSync(bundlePath).length) {
  throw new Error("Sidecar build did not produce a valid executable");
}

console.log(`Sidecar ready: ${path.relative(root, binaryPath)} (${Math.round(statSync(binaryPath).size / 1024 / 1024)} MB)`);
