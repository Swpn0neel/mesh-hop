# MeshHop — Product context

## What it is
A Windows desktop app (Tauri 2) that discovers working **public proxies** in a chosen country, verifies and ranks them for **speed and stability**, and routes a dedicated hardened Firefox/Chromium profile through the best one. It is not a VPN and offers no anonymity — it automates the tedious work of finding, measuring, and rotating public exits so a browser can appear to originate from another region.

## Who uses it
A single, non-enterprise individual on Windows who wants a residential-looking IP in another region for browsing/geo-unblocking. They are privacy-curious but not experts. They run it occasionally, leave it in the background, and care about one outcome: *is my browser routed through a fast, working exit right now?*

## Register
Product UI (design serves the task). Earned familiarity of a great connection client (Mullvad, Tailscale, Cloudflare WARP) — the tool should disappear into the task. **Not** a generic admin dashboard.

## The core job & flow
1. Pick an exit region (the one real decision).
2. Connect → the app fetches candidates, tests them, measures steady-state speed, and confirms exits. **This takes 30–90s** and is the thing that makes MeshHop different from a dumb proxy list — the wait must feel like legible, intelligent work, not a hang.
3. See the chosen exit's identity (country, public IP, ISP) and quality (speed, latency, consistency).
4. **Open the routed browser** — the payoff action.
5. Rotate to another verified exit or refresh the pool as needed.

## Differentiator to express in the UI
Not an on/off toggle. A **route that is discovered, measured, and earned.** Surface the verification/measurement intelligence (steady-state speed, consistency score, count of verified exits) — that confidence is the product.

## Design system
- **Theme:** dark. It runs in the background while you browse; a calm dark surface is correct, and it matches the existing brand.
- **Palette (committed — keep):** blue-violet accent `#6C7CFF`-family for brand/action/primary; green `#52D99E` reserved **semantically** for the live/connected state; amber/red for warning/error. Canvas near-black `#0C0E12`. Icon gradient (violet→green) is the brand's "route" motif.
- **Type:** one family (Segoe UI Variable / system-ui). Mono (Cascadia Mono/Consolas) for IPs and measured numbers. Fixed, readable scale — the old UI's 7–9px labels are a defect to fix.
- **Motion:** conveys state (connecting pipeline, live pulse), 150–250ms, reduced-motion fallback. No decoration-only motion.

## Hard constraints
- Tauri commands (unchanged): `start_engine({country, rankMode, maxCandidates, poolSize, autoFallback})`, `stop_engine`, `engine_status`, `rotate_exit`, `refresh_exits`, `open_browser`.
- Events (unchanged): `engine-log {level,message}`, `engine-state {phase,message,proxyPort,controlPort,pool}`, `pool-updated {pool}`. Phases: `stopped | starting | running | error`.
- Custom titlebar (window has no OS decorations): must provide minimize/maximize/close + drag region.
- Strict CSP: no external fonts, CDNs, or network assets. System fonts, inline SVG, `data:` URIs only.
- Vanilla JS + Vite build to `desktop-dist/`. No framework.
