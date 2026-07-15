# MeshHop security model

MeshHop routes a dedicated browser profile through **free, unauthenticated public proxies** that it discovers, verifies, and ranks automatically. Understand the trust model before using it.

## What MeshHop does and does not protect

- All local services listen on **loopback only** (`127.0.0.1`). CLI mode uses browser-proxy port **7777** and control port **7778**; the desktop app uses **17877** and **17878** respectively. The proxy accepts `CONNECT` requests only when the requested destination port is **443**. Plain-HTTP requests are answered with a `308` upgrade to HTTPS rather than being proxied in cleartext.
- The desktop sidecar's control API requires a fresh bearer token generated when the engine starts. CLI mode leaves its loopback control dashboard unauthenticated for direct browser use; other processes running as the same user can therefore inspect status or request rotation/refresh in CLI mode.
- MeshHop **never disables the browser's destination-certificate validation.** Your browser's HTTPS session stays encrypted end-to-end between the browser and the destination website, even as it passes through the public proxy. When MeshHop connects to a proxy's own TLS front door it does not validate that front-door certificate, but this never affects the inner, browser-to-website TLS session.
- **The public proxy is an untrusted intermediary.** Its operator can observe destination domains (via SNI and the `CONNECT` target), connection timing, and traffic volume. HTTPS hides page *contents*, not *who you talk to*.
- **Never accept a certificate warning** in the proxied browser. Doing so would let a malicious proxy intercept the HTTPS session. A correctly working public proxy never triggers such a warning.

## Verification and rotation

MeshHop reduces (but cannot eliminate) exposure to broken or hostile proxies by:

- Testing a randomized sample of published candidates rather than trusting the lists.
- Confirming the observed exit country and public IP through an end-to-end HTTPS request before use.
- Requiring finalists to work against multiple independent HTTPS hosts, and deduplicating by observed exit IP.
- Keeping a browser on one authoritative exit until three consecutive tunnel failures, a manual rotation, or a pool refresh — so a single page load does not silently span two different IPs.

## Bundled extension integrity

The dedicated Firefox profile installs the Mozilla-signed uBlock Origin 1.72.2 XPI. Its SHA-256 is pinned and verified at build time (`npm run browser-assets:verify`); a mismatch fails the build.

## Limitations

- Many public exits are datacenter IPs that strict websites already classify as proxies. MeshHop automates testing and failover but **cannot guarantee** a given address is unflagged.
- This tool provides **no anonymity**, no forward secrecy beyond HTTPS itself, and has not had independent security review. Do not use it for secrets or high-risk activity.
- Only your browser's traffic is routed, and only if that browser is configured (or launched by MeshHop) to use the loopback proxy. Other applications are unaffected and may leak your real IP.

## Reporting

Report vulnerabilities privately to the project owner. Do not test against proxies or networks you do not own or have permission to use.
