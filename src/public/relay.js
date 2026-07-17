import { connectViaProxy } from "./tunnel.js";
import { proxyKey } from "./sources.js";

/**
 * Establish a tunnel to {host, port} through the pool's current exit, with the
 * same retry/fallback discipline as the local browser CONNECT proxy: only
 * re-attempt when the pool itself crossed its failure threshold and rotated
 * (never silently walk the fallback list per individual request), and discard
 * a tunnel that finished after a rotation happened mid-handshake so a single
 * connection can never span two different exit IPs.
 *
 * This is intentionally the one place that policy lives, so a second local
 * listener (e.g. a SOCKS proxy for non-browser apps) can reuse it exactly
 * rather than re-implementing — and slightly diverging from — the same rules.
 */
export async function tunnelThroughPool(
  pool,
  clientSocket,
  host,
  port,
  { connectTimeoutMs = 5_000, maxAttempts = 3, autoFallback = true } = {},
) {
  let proxy = pool.current;
  const attempted = new Set();
  const failures = [];
  while (proxy && attempted.size < Math.max(1, maxAttempts)) {
    const attemptedKey = proxyKey(proxy);
    if (attempted.has(attemptedKey)) break;
    attempted.add(attemptedKey);
    let upstream;
    try {
      upstream = await connectViaProxy(proxy, host, port, connectTimeoutMs);
    } catch (error) {
      failures.push(`${proxyKey(proxy)}: ${error.message}`);
      pool.reportFailure(proxy);
      const authoritative = pool.current;
      if (autoFallback && authoritative && proxyKey(authoritative) !== attemptedKey) {
        proxy = authoritative;
        continue;
      }
      break;
    }
    if (clientSocket.destroyed) {
      upstream.destroy();
      return { upstream: null, proxy: null, failures, clientClosed: true };
    }
    const authoritative = pool.current;
    if (
      autoFallback &&
      authoritative &&
      proxyKey(authoritative) !== attemptedKey &&
      attempted.size < Math.max(1, maxAttempts)
    ) {
      upstream.destroy();
      proxy = authoritative;
      continue;
    }
    pool.reportSuccess(proxy);
    return { upstream, proxy, failures, clientClosed: false };
  }
  return { upstream: null, proxy: null, failures, clientClosed: false };
}
