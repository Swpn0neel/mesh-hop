# MeshHop improvement plan

**Product:** MeshHop (public-proxy discovery + dedicated browser routing)
**Focus:** Make Windows work reliably first; macOS/Linux packaging is out of scope for this plan.
**Related log:** [IMPROVEMENTS.md](./IMPROVEMENTS.md) (what was actually shipped)

This plan is the roadmap derived from a full-repo audit. It prioritizes the core user question:

> *Is my browser routed through a fast, working exit right now?*

---

## 1. Product context

MeshHop is a Windows-first Tauri 2 desktop app plus a Node discovery engine that:

1. Pulls free public proxy lists for a chosen country
2. Probes for real HTTPS exit IP/country
3. Measures steady-state speed and consistency; classifies ISP vs hosting
4. Runs a loopback-only CONNECT proxy (port 443 only)
5. Opens a dedicated Firefox profile (uBlock) or Chromium fallback

It is **not** a VPN and is not marketed as anonymity.

### Architecture

```text
desktop-ui (Vite + vanilla JS)
    │ Tauri invoke / events
src-tauri (Rust lifecycle)
    │ sidecar spawn + control HTTP
meshhop-engine (Node SEA) → src/public.js + pool/probe/tunnel/sources
    │ CONNECT tunnels
Public HTTP/HTTPS/SOCKS exits → destination sites
```

### What was already solid (do not break)

- Sticky exit + fail-threshold rotation (avoids mid-page IP flips)
- Distinct exit-IP dedupe
- Steady-state throughput window
- Desktop control bearer token
- Loopback-only + CONNECT port 443 + HTTP→HTTPS upgrade
- Version sync + CI (lint, tests, website, clippy, Windows installers)
- Honest security docs

---

## 2. Audit findings (why this plan exists)

### High severity

| ID | Issue |
| --- | --- |
| H1 | Free-list supply is fragile (few sources, noisy lists) |
| H2 | Unsigned installers → SmartScreen friction |
| H3 | No in-app update path |
| H4 | Fixed ports 17877/17878 hard-fail if busy |
| H5 | No continuous health of the active exit after connect |
| H6 | Browser leak surface (WebRTC / weaker Chromium path) |

### Medium

- CLI control unauthenticated (documented)
- Consumer heuristics US-centric
- Small hard-coded country list in UI
- No preference persistence
- Progress UI tied to log string heuristics
- No tray / background-client notifications
- Docs drift

### Lower

- Large monoliths; no TS on core product
- Probe errors swallowed without aggregate reasons
- Windows-only release

---

## 3. Phased roadmap

### Phase A — “Route stays healthy” (priority 1)

**Goal:** Connect feels intentional; route stays truthful after first success.

1. **Structured progress events** — engine stages with counters; UI pipeline driven by events
2. **Active-exit heartbeat** — periodic lightweight re-probe; feed failure/rotate rules
3. **Empty-pool diagnostics** — classify probe failures; surface why discovery failed
4. **Port conflict recovery / preflight** — fail fast with actionable message (full dynamic-port recovery optional later)
5. **Persist last-used settings**
6. **Harder Firefox anti-leak prefs**
7. **Doc / product contract sync**

**Success metric:** Fewer “says connected but nothing works” reports; long connect wait feels legible.

### Phase B — “Trust & distribution” (priority 2)

**Goal:** Users install, update, and leave the app in the background safely.

1. **In-app update check** from `meshhop-release.json`
2. **Exit blocklist / favorites** (blocklist first)
3. **Richer measurement UI** in pool drawer
4. **System tray** — show/hide main window; quit
5. **OS notifications** — auto-rotate, dead pool, engine error
6. **Code signing** — certificate-backed CI is implemented; production signing still requires the repository certificate, password, and timestamp endpoint

**Success metric:** Higher install completion; users stay updated; quality signals visible.

### Phase C — “Supply quality” (priority 3)

**Goal:** Higher first-connect success, especially outside the US.

1. **More free sources** + per-source contribute stats
2. **Adaptive sampling** by country supply
3. **ASN diversity** in the verified pool (not only distinct IPs)
4. **International consumer ISP heuristics**
5. **Optional authenticated proxy seed** (advanced; free path remains default)

**Success metric:** Higher first-connect success rate per country.

### Phase D — “Platform growth” (later)

- macOS (then Linux) builds — **explicitly deferred** while Windows is perfected
- Local SOCKS option for other apps
- Module split / typing
- Nightly live discovery CI

---

## 4. Explicit non-goals

- Full VPN / UDP / QUIC / system-wide tunnel
- True anonymity / Tor-class threat model
- React rewrite of the desktop UI
- Promising residential IPs from free lists

---

## 5. Implementation order (execution)

```text
Phase A (engine + UI reliability)
    → Phase B (updates, blocklist, tray, notifications)
        → Phase C (sources, diversity, adaptive sample)
            → Phase D when Windows is stable
```

Windows desktop commands and CSP stay constrained:

- Vanilla JS UI, no external CDNs
- Network for update check happens in **Rust**, not the WebView
- Fixed proxy ports remain the default (profile stability)

---

## 6. Critical files by theme

| Theme | Primary paths |
| --- | --- |
| Discovery / ranking | `src/public/pool.js`, `probe.js`, `sources.js`, `network.js` |
| Local proxy + control | `src/public.js` |
| Sidecar | `src/desktop-engine.js` |
| Desktop host | `src-tauri/src/main.rs`, `capabilities/default.json` |
| UI | `desktop-ui/src/main.js`, `styles.css`, `index.html` |
| Tests | `test/*.js` |
| Docs | `README.md`, `PRODUCT.md`, `SECURITY.md`, `DESKTOP.md`, this plan, `IMPROVEMENTS.md` |

---

## 7. Verification checklist

For every phase slice:

1. `npm test`
2. `npm run lint`
3. `npm run version:check` when versions touch
4. Manual desktop: connect → progress stages → open browser → heartbeat/rotate → refresh → select/block exit
5. Port conflict: hold 17877, start app, confirm clear error
6. `cargo check --manifest-path src-tauri/Cargo.toml` after Rust changes

---

## 8. Current execution state

| Phase | State |
| --- | --- |
| A | **Complete** (see IMPROVEMENTS.md) |
| B | **Implemented** — release-signing pipeline is in place; provisioning the Authenticode certificate, password, and timestamp endpoint is the remaining release-operations step. |
| C | **Complete** for free-list supply work; paid seed deferred |
| D | **Partial** — local SOCKS proxy and nightly live CI probe shipped; macOS/Linux packaging and module split/TypeScript remain deferred (see IMPROVEMENTS.md) |
| E | **Complete** — review follow-up: UI bugs found against the shipped Phase A/B/C backend (duplicate progress logs, invalid nested buttons), plus the gaps it surfaced (missing `unblock_exit`, no blocklist UI, `sourceStats` unsurfaced, no heartbeat recency) — see IMPROVEMENTS.md |

Update [IMPROVEMENTS.md](./IMPROVEMENTS.md) whenever a slice lands.
