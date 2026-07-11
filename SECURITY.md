# MeshHop security model

MeshHop is a private, consent-based relay. It is intentionally not an open proxy.

The separate **Public mode** intentionally consumes published unauthenticated HTTP, HTTPS, SOCKS4, and SOCKS5 proxies. It keeps the local listener on loopback, accepts HTTPS `CONNECT` traffic only, and never disables the browser's destination-certificate validation. The public proxy can observe destination domains, IPs, timing, and traffic volume. Never accept a browser certificate warning: that would allow interception of the HTTPS session.

- A 256-bit pair code authenticates exactly one client and one exit. Treat it like a password.
- The coordinator receives only a derived room identifier, a derived authentication token, and encrypted binary frames. The pair secret is never sent to it.
- Frame contents use AES-256-GCM. The browser's HTTPS session remains encrypted end-to-end between the browser and destination website inside that encrypted relay.
- The local proxy listens on loopback by default.
- The exit accepts DNS hostnames on port 443 only. It rejects IP literals and any DNS response containing a private, loopback, link-local, carrier-grade NAT, multicast, or reserved address.
- The exit requires an operator-defined domain allowlist unless the operator explicitly enables all public HTTPS destinations.
- Connection and byte-rate limits protect the exit operator from accidental overuse.

## Important boundaries

The exit operator controls the public IP and remains responsible for traffic leaving it. Run an exit only for a person you trust and only with the network owner's informed consent. HTTPS protects page contents, but the exit operator can still observe destination domains, timing, and traffic volume.

This MVP does not provide forward secrecy beyond HTTPS itself, coordinator federation, anonymous discovery, payments, reputation scoring, or formal protocol review. Do not use it for secrets or high-risk activity until the protocol has received independent security review.

Report vulnerabilities privately to the project owner; do not test against exits or networks you do not own or have permission to use.
