# MeshHop improvements log

This document records product and engineering improvements shipped against the [improvement plan](./IMPROVEMENT-PLAN.md). Windows is the supported production target unless noted otherwise.

**Status key:** Done · Partial · Deferred

---

## Phase A — Route stays healthy

| Item | Status | Summary |
| --- | --- | --- |
| Structured discovery progress | **Done** | Engine emits `progress` stages (`fetch` → `probe` → `speed` → `confirm` → `commit`) with `done`/`total`/`message`. Sidecar streams them; Rust forwards `engine-progress`; UI pipeline uses structured stages (log text is fallback only). |
| Active-exit heartbeat | **Done** | Pool re-probes the live exit every **45s** (`HEARTBEAT_SECONDS`, `0` disables). Failures count toward the same 3-strike rotation as tunnel failures. |
| Empty-pool diagnostics | **Done** | Probe failures classified (`timeout`, `wrong-country`, `connect`, `tls`, `http-error`, `invalid-ip`, `other`). Empty-pool errors include human summaries; UI empty state + toast show them. |
| Settings persistence | **Done** | Country, rank mode, sample size, pool size, auto-failover stored in `localStorage` (`meshhop.prefs.v1`). |
| Stronger Firefox anti-leak prefs | **Done** | WebRTC disabled; speculative connections off; TRR mode 5; ICE no-host / proxy-only. |
| Port preflight | **Done** | Desktop checks loopback **17877** / **17878** before spawning the engine; clear message if another MeshHop/engine holds them. |
| Doc sync | **Done** | `DESKTOP.md` → 0.4.0; `PRODUCT.md` / `SECURITY.md` / `README.md` updated; `DESKTOP.md` removed from `.gitignore`. |

### Phase A — files touched

- `src/public/probe.js` — `classifyProbeError`, `formatFailureSummary`, `tallyFailure`, `mapConcurrent` `onFailure`
- `src/public/pool.js` — progress events, heartbeat, discovery error fields, blocklist hooks (extended later)
- `src/public.js` — `onPool`, `heartbeatSeconds`, control wiring
- `src/desktop-engine.js` — progress + pool listeners before initial refresh; `HEARTBEAT_SECONDS` / `BLOCKED_EXIT_IPS`
- `src-tauri/src/main.rs` — `engine-progress`, port preflight, Firefox prefs, heartbeat env
- `desktop-ui/src/main.js` — structured progress, prefs, discovery toasts, copy IP
- `test/public.test.js` — progress, heartbeat, failure classification tests

---

## Phase B — Trust & distribution

| Item | Status | Summary |
| --- | --- | --- |
| In-app update check | **Done** | Rust `check_for_update` fetches `meshhop-release.json`; UI banner + Download via `open_external_url`. Dismiss remembered per version. |
| Exit IP blocklist | **Done** | Persist blocklist in `localStorage`; pass on start; `block_exit` / `/api/block`; pool drops blocked IPs; “Block IP” on pool rows. |
| Richer pool drawer | **Done** | Consistency %, protocol, failure counts on rows. |
| Copy exit IP | **Done** | Click IP on connected card. |
| ISP heuristics (non-US) | **Done** | Expanded EU/APAC consumer patterns in `network.js`. |
| System tray | **Done** | Close hides to tray; left-click / Show restores window; Quit kills engine and exits. |
| OS notifications | **Done** | Toasts on empty pool at ready, engine fatal, auto-rotate / heartbeat instability (`tauri-plugin-notification`). |
| Code signing | **Implemented — credentials pending** | GitHub Actions imports a base64 PFX, signs the sidecar before packaging, gives Tauri the certificate/timestamp configuration for the app and installers, and verifies all four signatures. Tagged releases fail closed until `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`, and `WINDOWS_TIMESTAMP_URL` are configured. |

### Phase B — files touched

- `src-tauri/src/main.rs` — `check_for_update`, `open_external_url`, `block_exit`, tray icon, close-to-tray, notifications
- `src-tauri/Cargo.toml` — `tray-icon` feature + `tauri-plugin-notification`
- `src-tauri/capabilities/default.json` — hide/show/focus + `notification:default`
- `src/public/pool.js` — `blockExit` / `unblockExit` / blocked set on commit
- `src/public.js` — `/api/block`, `/api/unblock`
- `desktop-ui` — update banner, blocklist, pool actions, styles
- `.github/workflows/ci.yml`, `scripts/enable-windows-signing.ps1`, `scripts/sign-windows.ps1`, `scripts/verify-windows-signatures.ps1` — certificate-backed release signing and verification

---

## Phase C — Supply quality

| Item | Status | Summary |
| --- | --- | --- |
| More proxy sources | **Done** | ProxyScrape HTTP/SOCKS4/SOCKS5 country templates added alongside Proxifly + IPLocate; bare `host:port` lines supported. |
| Adaptive sampling | **Done** | `adaptiveMaxCandidates` samples up to **1.5×** for lower-supply countries. |
| ASN diversity | **Done** | `diversifyByAsn` fills the verified pool round-robin by ASN. |
| Source health scoring | **Done** | Per-source contribution counts are stored as `sourceStats`, logged to Activity, and surfaced above the exit list with per-source details. |
| Optional paid/auth proxy seed | **Deferred** | Product decision; free path remains default. |

### Phase C — files touched (so far)

- `src/public/sources.js` — extra sources, `adaptiveMaxCandidates`, protocol-aware parse, source stats
- `src/public/pool.js` — adaptive sample size, `diversifyByAsn` on commit

---

## Phase D — Platform growth

| Item | Status | Summary |
| --- | --- | --- |
| macOS / Linux packaging | **Deferred** | Windows first by design; needs separate signing/notarization infra. |
| Local SOCKS for other apps | **Done** | Opt-in loopback SOCKS5 listener (`createSocksServer`), same policy as the CONNECT proxy (loopback, CONNECT only, port 443 only). Desktop toggle in Advanced options (fixed port 17879); CLI via `SOCKS_PORT`. Shares the pool's retry/rotation policy with the HTTP CONNECT path via a new `tunnelThroughPool` helper. |
| Module split / TypeScript | Deferred | Large refactor; not started without a dedicated design pass. |
| Nightly live CI probe | **Done** | `.github/workflows/nightly-live-probe.yml` runs `npm run test:public` on a daily cron (with one retry), separate from the push/PR pipeline so transient public-proxy flakiness never blocks a merge. |

### Phase D — files touched

- `src/public/socks-server.js` — SOCKS5 protocol implementation (RFC 1928, CONNECT only)
- `src/public/relay.js` — `tunnelThroughPool`, extracted so the SOCKS server reuses the CONNECT proxy's exact retry/rotation policy without duplicating or diverging from it
- `src/public.js` — `socksPort` option, SOCKS server lifecycle (listen/close)
- `src/desktop-engine.js` — `SOCKS_PORT` env, `socksPort` in the `ready` event
- `src-tauri/src/main.rs` — `socks_port` runtime state, `socksEnabled` start config, port preflight
- `desktop-ui` — Advanced-options toggle, connected-card SOCKS address (click to copy)
- `test/socks-server.test.js` — protocol + retry-policy tests
- `.github/workflows/nightly-live-probe.yml` — new scheduled workflow

---

## Phase E — Review follow-up (UI gaps + fixes)

A focused pass reviewing the desktop UI against what Phases A–C actually shipped in the backend, since the interface had lagged some of it.

| Item | Status | Summary |
| --- | --- | --- |
| Duplicate Activity-log lines | **Fixed** | Every discovery-progress message was logged twice (once via the raw `engine-log` stream, again via the structured `engine-progress` handler). Reproduced live (6/16 lines duplicated); fixed by having `applyStructuredProgress` only drive the pipeline text, never the log. |
| Nested `<button>` in pool rows | **Fixed** | The "Block IP" button was a descendant of the row's own `<button>` — invalid HTML, unreliable focus/click handling. Rows are now a `<div>` with two sibling buttons (`.pool-row-select` + `.pool-block`). |
| Missing `unblock_exit` Tauri command | **Fixed** | `pool.unblockExit()` and `/api/unblock` already existed; the desktop command that calls them did not. Added `unblock_exit`, registered in `invoke_handler`. |
| Blocklist management UI | **Added** | New "Blocked" tab in the details drawer listing every blocked IP with an "Unblock" action; the three drawer tabs now share one generalized tab-switching implementation instead of a hardcoded two-tab toggle. |
| `sourceStats` never surfaced | **Added** | A compact "N/M sources healthy · X candidates found" line above the exit list, with a per-source hover tooltip. The numbers already existed on `pool.status()` and were logged as text; this aggregates them into one glanceable signal. |
| No heartbeat recency indicator | **Added** | "verified Xs/Xm ago" caption under the Live badge, driven by `current.lastUsed` (stamped by both real traffic and a passing heartbeat probe) on a 1s ticker while connected. |
| Engine/UI stage-name mismatch | **Fixed** | The engine's `probe` stage was internally called `test` in the UI pipeline; renamed for consistency (cosmetic only, no behavior change). |

### Phase E — files touched

- `desktop-ui/src/main.js` — dedup fix, pool-row restructure, generalized tab switching, blocklist/source-health/heartbeat render functions, `unblockExitIp`
- `desktop-ui/src/styles.css` — `.pool-row-select`/`.pool-block` restructure, `.source-health`, `.blocked-list`, `.exit-live-wrap`/`.live-checked`
- `desktop-ui/index.html` — Blocked tab + panel, source-health line, heartbeat caption
- `src-tauri/src/main.rs` — `unblock_exit` command

---

## Verification (as of last green run)

- Unit tests: **51** passing (`npm test`)
- ESLint: clean (`npm run lint`)
- Rust: `cargo fmt --check` and `cargo clippy -- -D warnings` clean

```powershell
npm test
npm run lint
npm run version:check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

---

## Config / API additions (quick reference)

| Name | Where | Meaning |
| --- | --- | --- |
| `HEARTBEAT_SECONDS` | Env (default `45`) | Active-exit re-probe interval; `0` off |
| `BLOCKED_EXIT_IPS` | Env (comma list) | Seed blocklist for engine |
| `SOCKS_PORT` | Env (default `0`) | Opt-in local SOCKS5 listener port; `0` off |
| `engine-progress` | Tauri event | `{ stage, done, total, message }` |
| `check_for_update` | Tauri command | Manifest compare + download URL |
| `open_external_url` | Tauri command | Open https URL (installer) |
| `block_exit` / `unblock_exit` | Tauri command | Add/remove an exit IP from the blocklist |
| `/api/block`, `/api/unblock` | Control HTTP | Same as block/unblock for CLI/desktop |
| `socksPort` | `DesktopStatus` / engine `ready` event | Active SOCKS5 port, or absent if disabled |

See also: [IMPROVEMENT-PLAN.md](./IMPROVEMENT-PLAN.md), [PRODUCT.md](./PRODUCT.md), [SECURITY.md](./SECURITY.md).
