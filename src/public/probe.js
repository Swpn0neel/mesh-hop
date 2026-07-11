import { isPublicAddress } from "../net-policy.js";
import { httpsGetViaProxy } from "./tunnel.js";

export function parseCloudflareTrace(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

export function megabitsPerSecond(bytes, elapsedMs) {
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.round(((bytes * 8) / (elapsedMs / 1_000) / 1_000_000) * 100) / 100;
}

export async function benchmarkProxyThroughput(
  proxy,
  { bytes = 256 * 1024, timeoutMs = 8_000 } = {},
) {
  const response = await httpsGetViaProxy(proxy, {
    host: "speed.cloudflare.com",
    path: `/__down?bytes=${bytes}`,
    timeoutMs,
    maximumBytes: bytes + 64 * 1024,
  });
  if (response.statusCode !== 200) throw new Error(`Speed probe returned HTTP ${response.statusCode}`);
  if (response.body.length !== bytes) {
    throw new Error(`Speed probe returned ${response.body.length} of ${bytes} bytes`);
  }
  const throughputMbps = megabitsPerSecond(response.body.length, response.elapsedMs);
  if (throughputMbps <= 0) throw new Error("Speed probe did not produce a usable measurement");
  return {
    ...proxy,
    throughputMbps,
    speedTestBytes: response.body.length,
    speedTestMs: response.elapsedMs,
  };
}

export async function probeProxy(proxy, { country = "US", timeoutMs = 7_000 } = {}) {
  const response = await httpsGetViaProxy(proxy, {
    host: "www.cloudflare.com",
    path: "/cdn-cgi/trace",
    timeoutMs,
  });
  if (response.statusCode !== 200) throw new Error(`Location probe returned HTTP ${response.statusCode}`);
  const trace = parseCloudflareTrace(response.body.toString("utf8"));
  if (trace.loc !== String(country).toUpperCase()) {
    throw new Error(`Observed country was ${trace.loc || "unknown"}`);
  }
  if (!trace.ip || !isPublicAddress(trace.ip)) throw new Error("Location probe returned an invalid exit IP");
  return {
    ...proxy,
    country: trace.loc,
    exitIp: trace.ip,
    latencyMs: response.elapsedMs,
    checkedAt: new Date().toISOString(),
    failures: 0,
    consecutiveFailures: 0,
    successes: 0,
  };
}

export async function probeBrowserReadiness(proxy, { timeoutMs = 7_000 } = {}) {
  const [google, example] = await Promise.all([
    httpsGetViaProxy(proxy, {
      host: "www.google.com",
      path: "/generate_204",
      timeoutMs,
      maximumBytes: 32 * 1024,
    }),
    httpsGetViaProxy(proxy, {
      host: "example.com",
      path: "/",
      timeoutMs,
      maximumBytes: 64 * 1024,
    }),
  ]);
  if (google.statusCode !== 204) throw new Error(`Google readiness probe returned HTTP ${google.statusCode}`);
  if (example.statusCode !== 200) throw new Error(`Independent readiness probe returned HTTP ${example.statusCode}`);
  return {
    browserReady: true,
    browserProbeMs: Math.max(google.elapsedMs, example.elapsedMs),
  };
}

export async function mapConcurrent(items, concurrency, worker, onSuccess) {
  const results = [];
  let nextIndex = 0;
  async function run() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        const value = await worker(items[index], index);
        results.push(value);
        onSuccess?.(value, results.length);
      } catch {
        // Public proxies are expected to fail frequently.
      }
    }
  }
  const count = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: count }, () => run()));
  return results;
}
