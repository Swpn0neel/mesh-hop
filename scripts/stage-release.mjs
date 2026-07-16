import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const repository = process.env.GITHUB_REPOSITORY ?? "Swpn0neel/mesh-hop";
const tag = process.env.RELEASE_TAG ?? `v${version}`;
const outputDirectory = path.resolve(root, process.env.RELEASE_DIR ?? "release");

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json version "${version}" is not a plain semver x.y.z`);
}

if (tag !== `v${version}`) {
  throw new Error(`Release tag "${tag}" does not match package version "${version}"`);
}

if (outputDirectory === root || !outputDirectory.startsWith(`${root}${path.sep}`)) {
  throw new Error(`Release directory must stay inside the project: ${outputDirectory}`);
}

const sourceDirectory = path.join(root, "src-tauri", "target", "release", "bundle");
const definitions = [
  {
    id: "nsis",
    source: path.join(sourceDirectory, "nsis", `MeshHop_${version}_x64-setup.exe`),
    versionedFile: `MeshHop_${version}_x64-setup.exe`,
    latestFile: "MeshHop-windows-x64-setup.exe",
  },
  {
    id: "msi",
    source: path.join(sourceDirectory, "msi", `MeshHop_${version}_x64_en-US.msi`),
    versionedFile: `MeshHop_${version}_x64_en-US.msi`,
    latestFile: "MeshHop-windows-x64.msi",
  },
];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

function assetDetails(file, filename) {
  return {
    file: filename,
    sizeBytes: statSync(file).size,
    sha256: sha256(file),
  };
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const assets = {};
const checksumLines = [];

for (const definition of definitions) {
  try {
    statSync(definition.source);
  } catch {
    throw new Error(`Installer not found: ${path.relative(root, definition.source)}`);
  }

  const versionedPath = path.join(outputDirectory, definition.versionedFile);
  const latestPath = path.join(outputDirectory, definition.latestFile);
  copyFileSync(definition.source, versionedPath);
  copyFileSync(definition.source, latestPath);

  const versioned = assetDetails(versionedPath, definition.versionedFile);
  const latest = assetDetails(latestPath, definition.latestFile);
  assets[definition.id] = {
    latest,
    versioned,
    latestUrl: `https://github.com/${repository}/releases/latest/download/${definition.latestFile}`,
    versionedUrl: `https://github.com/${repository}/releases/download/${tag}/${definition.versionedFile}`,
  };
  checksumLines.push(`${versioned.sha256}  ${versioned.file}`);
  checksumLines.push(`${latest.sha256}  ${latest.file}`);
}

writeFileSync(outputDirectory + "/SHA256SUMS.txt", `${checksumLines.join("\n")}\n`);

const manifest = {
  schemaVersion: 1,
  product: "MeshHop",
  version,
  tag,
  channel: "stable",
  repository,
  releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
  latestReleaseUrl: `https://github.com/${repository}/releases/latest`,
  generatedAt: new Date().toISOString(),
  assets: {
    windows: {
      nsis: assets.nsis,
      msi: assets.msi,
    },
  },
};

writeFileSync(
  outputDirectory + "/meshhop-release.json",
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`Staged MeshHop ${version} release assets in ${path.relative(root, outputDirectory)}:`);
for (const definition of definitions) {
  const detail = assets[definition.id].versioned;
  console.log(`- ${detail.file} (${Math.round(detail.sizeBytes / 1024 / 1024)} MiB)`);
}
