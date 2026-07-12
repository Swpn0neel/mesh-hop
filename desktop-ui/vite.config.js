import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(directory, "../package.json"), "utf8"));

export default defineConfig({
  root: directory,
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: path.resolve(directory, "../desktop-dist"),
    emptyOutDir: true,
    target: "esnext",
    minify: "esbuild",
  },
});
