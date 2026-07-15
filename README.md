# MeshHop

MeshHop is a desktop app that automatically discovers working **public proxies** for a chosen region, verifies them end-to-end, and routes a dedicated browser profile through the best one. It exists because software cannot manufacture a residential IP in another country: the final hop has to come from a real connection there. MeshHop automates the tedious part — finding, testing, ranking, and rotating public exits — and wires a hardened Firefox profile to the result.

> **This is not a VPN and not an anonymity tool.** It uses free, unauthenticated public proxies. The proxy operator can see the destination domains, timing, and traffic volume of every connection (HTTPS still protects page *contents*). Many public exits are datacenter IPs that strict sites already flag. Do not use it for secrets or high-risk activity.

## Desktop app — recommended

MeshHop ships as a self-contained Tauri 2 desktop application. Installed users do **not** need Node.js, npm, Rust, or a terminal.

- Windows installer (NSIS): [`MeshHop_0.3.2_x64-setup.exe`](release/MeshHop_0.3.2_x64-setup.exe)
- Windows MSI (managed/silent deploy): [`MeshHop_0.3.2_x64_en-US.msi`](release/MeshHop_0.3.2_x64_en-US.msi)

Firefox is recommended — MeshHop opens an isolated, proxied Firefox profile with the bundled uBlock Origin extension. If Firefox isn't installed, it falls back to Chrome, Chromium, or Edge with a proxied, isolated profile (without uBlock Origin).

Inside the app:

1. Choose the exit country and a ranking preference (**speed**, **balanced**, or **consumer**).
2. Select **Start** and wait while candidates are downloaded, probed, benchmarked, and confirmed across independent HTTPS hosts, then deduplicated by observed public IP.
3. Select **Open browser**. MeshHop launches a dedicated Firefox profile pointed at the local proxy, with reduced WebRTC/DNS-prefetch leakage and the signed uBlock Origin extension enabled.
4. Use **Rotate IP** or **Find fresh exits** whenever you need a different address.

The app bundles the proxy engine as a Node single-executable sidecar, streams discovery progress into the UI, and stops the engine when the app exits. The desktop build uses fixed loopback ports **17877** (browser proxy) and **17878** (control); if either is already in use it reports an error rather than silently picking another. See [DESKTOP.md](DESKTOP.md) for development, packaging, and signing details.

## Command-line mode

You can also run the discovery engine directly with Node.js 20+:

```powershell
npm install
npm run public
```

MeshHop then:

1. Downloads current published proxy candidates for the chosen country from [Proxifly](https://github.com/proxifly/free-proxy-list) and [IPLocate](https://github.com/iplocate/free-proxy-list) (HTTP, HTTPS, SOCKS4, SOCKS5).
2. Tests a randomized sample concurrently instead of trusting the lists.
3. Verifies the observed exit country and IP through an end-to-end HTTPS request to Cloudflare's trace endpoint.
4. Measures download speed over a steady-state window — skipping the initial warm-up so connect/handshake overhead and TCP slow-start don't skew the result — takes a second confirming sample per exit and scores its speed consistency, then looks up ASN/ISP (via `ipwho.is`), classifies consumer vs. hosting networks, and confirms finalists across independent HTTPS hosts.
5. Ranks candidates by sustained speed and consistency (erratic exits are penalized), starts a sticky local proxy, keeps distinct verified fallbacks, and refreshes every ten minutes. A browser stays on one authoritative exit until three consecutive tunnel failures, a manual rotation, or a pool refresh changes it.

The control/status page opens at `http://127.0.0.1:7778` with **Rotate IP** and **Find fresh proxies** buttons. The local browser proxy is `http://127.0.0.1:7777`.

> CLI mode does **not** launch a browser for you — point your browser's proxy at `http://127.0.0.1:7777` manually (see [Browser setup](#browser-setup)).

Check the currently published pool without starting the proxy:

```powershell
npm run public:check
```

### Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `COUNTRY` | `US` | Two-letter country code to search. |
| `RANK_MODE` | `balanced` | `speed`, `balanced`, or `consumer`. |
| `LISTEN_PORT` | `7777` | Local browser proxy port. |
| `CONTROL_PORT` | `7778` | Status/control HTTP port. |
| `MAX_CANDIDATES` | `160` | How many sampled proxies to probe. |
| `PROBE_CONCURRENCY` | `40` | Parallel probes. |
| `PROBE_TIMEOUT_MS` | `7000` | Per-probe timeout. |
| `POOL_SIZE` | `8` | Verified exits to retain. |
| `MIN_THROUGHPUT_MBPS` | `2` | Drop exits measured below this sustained speed (kept as best-effort if none clear it). `0` disables the floor. |
| `CONNECT_TIMEOUT_MS` | `5000` | Tunnel connect timeout. |
| `MAX_ATTEMPTS` | `3` | Tunnel attempts before failing a request. |
| `AUTO_FALLBACK` | `1` | Set to `0` to keep a single exit and never auto-rotate on failure. |
| `REFRESH_MINUTES` | `10` | Background refresh interval. |
| `SOURCE_URLS` | Proxifly + IPLocate | Comma-separated list templates; `{COUNTRY}` is substituted. |

```powershell
$env:RANK_MODE = "speed"; npm run public      # lowest measured latency/throughput cost
$env:COUNTRY = "GB"; npm run public           # search another region
```

## Scope

- A loopback-only HTTPS `CONNECT` proxy for a separate browser profile.
- HTTPS over TCP on port **443 only**. Plain-HTTP navigations are upgraded to HTTPS locally with a `308` redirect.
- No UDP, QUIC, raw IP tunnelling, or LAN access.

## Browser setup

The desktop app configures Firefox for you. For CLI mode, use a **separate** browser profile so proxied and normal traffic don't mix. For Chrome on Windows:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="$env:LOCALAPPDATA\MeshHop\Chrome" `
  --proxy-server="http://127.0.0.1:7777" `
  --disable-quic
```

`--disable-quic` keeps browser traffic on HTTPS/TCP, which is what MeshHop supports.

## Bundled browser extension

The desktop package includes the unmodified, Mozilla-signed **uBlock Origin 1.72.2** XPI from the official [gorhill/uBlock release](https://github.com/gorhill/uBlock/releases/tag/1.72.2). It is installed only in MeshHop's dedicated Firefox profile as `uBlock0@raymondhill.net` and is licensed under GPL-3.0. The pinned XPI SHA-256 is `40C315B0DA7871868155ECFAE7A50A58DFA0920AEBD865E008214986F1B7C578`, verified at build time by `npm run browser-assets:verify`.

## Tests

Unit tests (no internet required):

```powershell
npm test
```

Live test (requires internet; discovers a real US exit and tunnels an HTTPS request through it):

```powershell
npm run test:public
```

## Security

Read [SECURITY.md](SECURITY.md) before relying on MeshHop. In short: keep normal HTTPS certificate validation enabled, never accept a certificate warning from a public proxy, and treat public exits as untrusted intermediaries that can observe destination domains, timing, and volume.
