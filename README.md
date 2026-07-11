# MeshHop

MeshHop is a small, consent-based HTTPS relay for pairing one browser with one trusted internet exit in another region. It is designed around a hard networking constraint: software cannot create a US residential IP unless a US residential or mobile connection supplies the final hop.

## Desktop app — recommended

MeshHop now ships as a self-contained Tauri 2 desktop application. Installed users do not need Node.js, npm, Rust, a terminal, or manual browser proxy settings.

- Recommended Windows installer: [`MeshHop_0.2.7_x64-setup.exe`](release/MeshHop_0.2.7_x64-setup.exe)
- Enterprise-style MSI: [`MeshHop_0.2.7_x64_en-US.msi`](release/MeshHop_0.2.7_x64_en-US.msi)

Inside the app:

1. Choose the exit country and ranking preference.
2. Select **Start MeshHop** and wait while candidates are verified across independent HTTPS hosts and deduplicated by observed public IP.
3. Select **Open browser**. MeshHop launches an isolated Firefox profile with the local proxy, reduced WebRTC leakage, and the bundled signed uBlock Origin extension enabled.
4. Use **Rotate IP** or **Find fresh exits** whenever needed.

The app includes the 91 MB proxy engine as a Node single-executable sidecar, chooses unused loopback ports automatically, streams discovery progress into the UI, and stops the engine when the app exits. See [DESKTOP.md](DESKTOP.md) for development, packaging, and signing details.

MeshHop removes the server-administration part. Both the client and exit make outbound WebSocket connections to a lightweight coordinator, so the exit needs no public IP, inbound port, router configuration, static address, or SSH access.

## Fastest path: automatic public US mode

On Windows, double-click [`START-PUBLIC.cmd`](START-PUBLIC.cmd). Or run:

```powershell
npm install
npm run public
```

MeshHop then:

1. Downloads current published US HTTP, HTTPS, SOCKS4, and SOCKS5 candidates from [Proxifly](https://github.com/proxifly/free-proxy-list) and [IPLocate](https://github.com/iplocate/free-proxy-list).
2. Tests a randomized sample concurrently instead of trusting the lists.
3. Verifies the observed exit country and IP through an end-to-end HTTPS request.
4. Looks up the ASN/ISP, balances consumer-looking networks against latency, and confirms finalists twice.
5. Starts a sticky local proxy, keeps distinct verified fallbacks, refreshes every ten minutes, and launches a dedicated browser profile automatically. Browser connections remain on one authoritative exit until three consecutive tunnel failures, a manual rotation, or a pool refresh changes it.

The status page opens at `http://127.0.0.1:7778`. It shows the observed US IP and has **Rotate IP** and **Find fresh proxies** buttons. The local browser proxy is `http://127.0.0.1:7777`.

Ranking defaults to `balanced`. To choose the lowest measured latency regardless of network ownership:

```powershell
$env:RANK_MODE = "speed"
npm run public
```

Use `RANK_MODE=consumer` to prioritize consumer-ISP-looking networks more strongly. Change `COUNTRY=GB` or another two-letter country code to search another region. Set `AUTO_LAUNCH_BROWSER=0` if you do not want MeshHop to open a dedicated browser profile.

Check the currently published pool without starting a browser:

```powershell
npm run public:check
```

Public proxies are volatile and many are datacenter IPs. This mode automates testing and failover, but it cannot guarantee that a strict website has not already classified an address. Keep normal HTTPS certificate validation enabled and never accept a certificate warning from a public proxy.

```text
Browser -> local CONNECT proxy == encrypted frames ==> coordinator
                                                       || opaque forwarding
Website <- normal HTTPS/TCP <- consenting US exit <=====
```

The website sees the exit's ISP address. It never sees the coordinator's datacenter address.

## What the MVP provides

- A loopback-only HTTPS `CONNECT` proxy for a separate browser profile.
- A coordinator that forwards opaque encrypted frames and never performs website requests.
- A 256-bit pairing code shared by exactly one client and one exit.
- AES-256-GCM encryption between the paired programs, with HTTPS still intact inside it.
- Exit-side DNS resolution, domain allowlists, public-address validation, connection limits, and byte-rate limits.
- Outbound-only connectivity that can work through NAT or carrier-grade NAT.

This is not a full VPN. It intentionally supports HTTPS over TCP on port 443 only; there is no UDP, QUIC, raw IP tunnelling, LAN access, public exit discovery, or anonymous open-proxy mode.

## Quick local demonstration

Requires Node.js 20 or newer.

```powershell
npm install
npm run pair
```

Copy the generated `mh1_...` code. Open three PowerShell windows in this directory.

Coordinator:

```powershell
npm run coordinator
```

Exit agent:

```powershell
$env:PAIR_CODE = "mh1_replace_me"
$env:COORDINATOR_URL = "ws://127.0.0.1:8787/relay"
$env:ALLOW_DOMAINS = "example.com,ifconfig.me"
npm run exit
```

Client:

```powershell
$env:PAIR_CODE = "mh1_replace_me"
$env:COORDINATOR_URL = "ws://127.0.0.1:8787/relay"
npm run client
```

Test it:

```powershell
curl.exe --proxy http://127.0.0.1:7777 https://ifconfig.me/ip
```

For a real US exit, the exit command must run on a consenting computer connected through a US residential or mobile ISP. The client and coordinator may run elsewhere.

## Browser setup

Use a separate browser profile so proxy and non-proxy traffic are not mixed. For Chrome on Windows:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="$env:LOCALAPPDATA\MeshHop\Chrome" `
  --proxy-server="http://127.0.0.1:7777" `
  --disable-quic
```

`--disable-quic` keeps browser traffic on HTTPS/TCP, which the MVP supports. The desktop app upgrades initial plain-HTTP navigation to HTTPS locally.

## Bundled browser extension

The desktop package includes the unmodified, Mozilla-signed **uBlock Origin 1.72.2** XPI from the official [gorhill/uBlock release](https://github.com/gorhill/uBlock/releases/tag/1.72.2). It is installed only in MeshHop's dedicated Firefox profile as `uBlock0@raymondhill.net` and is licensed under GPL-3.0. The pinned XPI SHA-256 is `40C315B0DA7871868155ECFAE7A50A58DFA0920AEBD865E008214986F1B7C578`.

## Using a remote coordinator

Deploy `npm run coordinator` on any WebSocket-capable service and expose `/relay` through TLS. Set both agents to its `wss://` address:

```powershell
$env:COORDINATOR_URL = "wss://relay.your-domain.example/relay"
```

The coordinator can have a datacenter IP because it is transport only. The destination website's TCP connection originates from the exit agent. MeshHop refuses an insecure `ws://` coordinator unless it is on localhost.

Free hosting plans and WebSocket limits change frequently, so the project does not hard-code a particular provider. A coordinator transfers all relayed bytes; at meaningful scale, somebody must pay for that bandwidth. A future peer-to-peer transport can reduce coordinator bandwidth when direct NAT traversal succeeds.

## Exit operator controls

By default the exit starts only when at least one domain is explicitly allowed:

```powershell
$env:ALLOW_DOMAINS = "example.com,*.example.org"
```

An operator can explicitly permit every public HTTPS hostname, although this increases their abuse and liability risk:

```powershell
$env:ALLOW_ALL_PUBLIC_HTTPS = "1"
```

Additional limits:

```powershell
$env:MAX_CONNECTIONS = "8"
$env:MAX_BYTES_PER_MINUTE = "262144000"
```

The exit always rejects IP-literal targets, private/reserved DNS answers, and ports other than 443.

## Tests

Unit and coordinator tests do not require internet access:

```powershell
npm test
```

The live test creates a coordinator, client, and exit locally and tunnels an HTTPS request to `example.com`:

```powershell
npm run test:live
```

## Turning this into a product

The practical product is a small cooperative, not a public anonymous proxy list:

1. Package the client and exit as signed desktop apps with QR pairing.
2. Let exit operators choose domains, time windows, bandwidth, and who may pair.
3. Add direct WebRTC/ICE transport, using the coordinator only for rendezvous and relay fallback.
4. Add consent receipts, abuse reporting, automatic updates, revocation, and independent security review.
5. Recruit US participants through reciprocal credits: contributing an exit earns private use of another region.

A completely public pool eventually becomes identifiable as a residential-proxy network. Small authenticated circles, stable pairings, explicit consent, and ordinary legitimate traffic are the part that makes this model sustainable.

Read [SECURITY.md](SECURITY.md) before exposing a coordinator or operating an exit.
