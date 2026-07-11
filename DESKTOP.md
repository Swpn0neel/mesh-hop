# MeshHop desktop application

The desktop package uses Tauri 2.11, a vanilla Vite frontend, and the existing JavaScript proxy engine bundled as a Node single-executable sidecar.

## End-user installation

For ordinary Windows installation, use the NSIS setup executable:

```text
src-tauri/target/release/bundle/nsis/MeshHop_0.2.7_x64-setup.exe
```

The MSI package is also available for managed or silent deployment:

```text
src-tauri/target/release/bundle/msi/MeshHop_0.2.7_x64_en-US.msi
```

Both packages include the proxy engine. Node.js and Rust are not required on the installed computer. Mozilla Firefox is required for the dedicated proxied browser profile (MeshHop installs the bundled uBlock Origin extension into an isolated Firefox profile).

These personal development builds are unsigned. Windows SmartScreen may therefore display an unknown-publisher warning. Production distribution should Authenticode-sign the sidecar, Tauri executable, and installer with a trusted code-signing certificate.

## Architecture

```text
Tauri WebView UI
    │ invoke/events
Rust lifecycle controller
    │ starts/stops and reads JSON logs
Bundled meshhop-engine.exe sidecar
    │ local HTTP CONNECT proxy
Verified public HTTP/HTTPS/SOCKS exit
    │
Destination website
```

The Rust layer uses fixed loopback ports (17877 for the browser proxy, 17878 for control) so an already-open Firefox profile stays valid across restarts, supervises the child process, requests status/rotate/refresh actions from its loopback control endpoint, and opens a dedicated Firefox profile. The WebView never receives shell permissions.

## Development

Prerequisites:

- Node.js 20 or newer
- Rust toolchain with the MSVC Windows target
- Microsoft WebView2 runtime

Install dependencies and start development mode:

```powershell
npm install
npm run desktop:dev
```

This command first builds a target-triple-suffixed sidecar and then starts Vite and Tauri development mode.

## Release build

```powershell
npm run desktop:build
```

The build performs the following operations:

1. Bundles `src/desktop-engine.js` and its dependencies with esbuild.
2. Generates a Node single-executable blob.
3. Copies the current Node executable and injects the blob with Postject.
4. Builds the Vite frontend.
5. Compiles the optimized Rust application.
6. Produces NSIS and MSI installers.

Build products appear under `src-tauri/target/release/bundle/`.

## Relevant source files

- `desktop-ui/` — application interface and icon source
- `src-tauri/src/main.rs` — engine lifecycle and Tauri commands
- `src-tauri/tauri.conf.json` — window, CSP, installer, and sidecar configuration
- `src/desktop-engine.js` — machine-readable sidecar entry point
- `scripts/build-sidecar.mjs` — standalone-engine build pipeline
