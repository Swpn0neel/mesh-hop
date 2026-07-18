# MeshHop desktop application

The desktop package uses Tauri 2, a vanilla Vite frontend, and the existing JavaScript proxy engine bundled as a Node single-executable sidecar. **Windows is the supported production target.**

## End-user installation

For ordinary Windows installation, use the NSIS setup executable:

```text
src-tauri/target/release/bundle/nsis/MeshHop_0.4.1_x64-setup.exe
```

The MSI package is also available for managed or silent deployment:

```text
src-tauri/target/release/bundle/msi/MeshHop_0.4.1_x64_en-US.msi
```

Stable download aliases are published on GitHub Releases as `MeshHop-windows-x64-setup.exe` and `MeshHop-windows-x64.msi`.

Both packages include the proxy engine. Node.js and Rust are not required on the installed computer. Mozilla Firefox is recommended for the dedicated proxied browser profile (MeshHop installs the bundled uBlock Origin extension into an isolated Firefox profile with WebRTC disabled). If Firefox is not present, MeshHop falls back to Chrome, Chromium, or Edge with a proxied, isolated profile (without uBlock Origin).

Local development builds are unsigned. The GitHub release workflow is configured to Authenticode-sign the sidecar, desktop executable, NSIS installer, and MSI when its signing credentials are available; tagged releases fail rather than publish unsigned if the credentials are absent.

## Architecture

```text
Tauri WebView UI
    │ invoke/events
Rust lifecycle controller
    │ starts/stops and reads JSON logs + progress events
Bundled meshhop-engine.exe sidecar
    │ local HTTP CONNECT proxy + active-exit heartbeat
Verified public HTTP/HTTPS/SOCKS exit
    │
Destination website
```

The Rust layer uses fixed loopback ports (**17877** for the browser proxy, **17878** for control) so an already-open Firefox profile stays valid across restarts. It preflights those ports before spawning the engine, supervises the child process, requests status/rotate/select/refresh actions from its loopback control endpoint, and opens a dedicated Firefox profile. The WebView never receives shell permissions.

Closing the window **hides MeshHop to the system tray** so an active route can keep running. Use the tray menu **Quit** to stop the engine and exit fully. Windows toast notifications surface auto-rotation, empty pools, and engine failures while the window is hidden.

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

## Windows release signing

The installer workflow (`.github/workflows/ci.yml`) signs the sidecar before Tauri packages it, supplies Tauri's Windows signing configuration for the desktop executable and both installers, then validates every signature before staging the release assets. It uses SHA-256 signatures and the certificate issuer's RFC 3161 timestamp endpoint.

Configure the repository before creating a release tag:

1. Add the base64-encoded, exportable PFX as the `WINDOWS_CERTIFICATE` GitHub Actions secret. In PowerShell, create the value with `[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\certificate.pfx"))`.
2. Add its password as the `WINDOWS_CERTIFICATE_PASSWORD` GitHub Actions secret.
3. Add the issuer's timestamp endpoint as the `WINDOWS_TIMESTAMP_URL` GitHub Actions repository variable.

The imported certificate is stored only in the ephemeral runner's CurrentUser certificate store; the temporary PFX is removed immediately after import. Non-release CI artifacts stay unsigned if the secrets are unavailable (for example, forked pull requests). For an EV, hardware-backed, or cloud-managed certificate that cannot be exported as PFX, replace this PFX import path with the issuer's supported signing command; Tauri documents the supported Windows signing configuration in its [code-signing guide](https://v2.tauri.app/distribute/sign/windows/).

## Relevant source files

- `desktop-ui/` — application interface and icon source
- `src-tauri/src/main.rs` — engine lifecycle and Tauri commands
- `src-tauri/tauri.conf.json` — window, CSP, installer, and sidecar configuration
- `src/desktop-engine.js` — machine-readable sidecar entry point
- `scripts/build-sidecar.mjs` — standalone-engine build pipeline
- `scripts/enable-windows-signing.ps1` — imports release certificate and supplies Tauri signing config
- `scripts/sign-windows.ps1` / `scripts/verify-windows-signatures.ps1` — sign and verify the bundled sidecar/release set
