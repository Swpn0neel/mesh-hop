import { EventEmitter } from "node:events";
import { compareProxyQuality, enrichProxyNetworks } from "./network.js";
import {
  benchmarkProxyThroughput,
  classifyProbeError,
  formatFailureSummary,
  mapConcurrent,
  probeBrowserReadiness,
  probeProxy,
  tallyFailure,
} from "./probe.js";
import { measureDownloadThroughput } from "./tunnel.js";
import {
  DEFAULT_SOURCE_URLS,
  adaptiveMaxCandidates,
  fetchPublicProxyCandidates,
  proxyKey,
  shuffledSample,
} from "./sources.js";

// The steady-state throughput probe needs room for the handshake plus the full
// warm-up and measurement window, independent of the shorter per-request probe
// timeout used for lightweight checks.
const SPEED_TIMEOUT_MS = 12_000;

// Combine one or more throughput samples (Mbps) into a single conservative
// figure plus a consistency score in [0, 1] (min/max of the samples). A single
// sample is reported as-is with a neutral 1 consistency. Pure and testable.
export function combineThroughputSamples(samples) {
  const valid = (Array.isArray(samples) ? samples : []).filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  if (valid.length === 0) return { throughputMbps: 0, consistency: 0 };
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  return {
    throughputMbps: Math.round(mean * 100) / 100,
    consistency: valid.length < 2 ? 1 : Math.round((min / max) * 100) / 100,
  };
}

export class PublicProxyPool extends EventEmitter {
  constructor({
    country = "US",
    sourceUrls = DEFAULT_SOURCE_URLS,
    maxCandidates = 160,
    concurrency = 40,
    probeTimeoutMs = 7_000,
    poolSize = 8,
    rankMode = "balanced",
    autoFallback = true,
    minThroughputMbps = 2,
    blockedExitIps = [],
    logger = console,
  } = {}) {
    super();
    this.country = String(country).toUpperCase();
    this.sourceUrls = sourceUrls;
    this.maxCandidates = maxCandidates;
    this.concurrency = concurrency;
    this.probeTimeoutMs = probeTimeoutMs;
    this.poolSize = poolSize;
    this.minThroughputMbps = Number(minThroughputMbps) || 0;
    if (!new Set(["speed", "balanced", "consumer"]).has(rankMode)) {
      throw new Error("RANK_MODE must be speed, balanced, or consumer");
    }
    this.rankMode = rankMode;
    this.autoFallback = Boolean(autoFallback);
    this.logger = logger;
    this.proxies = [];
    this.currentIndex = 0;
    this.refreshing = null;
    this.lastRefresh = null;
    this.sourceCount = 0;
    this.lastDiscoveryError = null;
    this.lastFailureSummary = null;
    this.sourceStats = null;
    this._heartbeatRunning = false;
    this.blockedExitIps = new Set(
      (Array.isArray(blockedExitIps) ? blockedExitIps : [])
        .map((ip) => String(ip || "").trim().toLowerCase())
        .filter(Boolean),
    );
  }

  #normalizeExitIp(exitIp) {
    return String(exitIp || "").trim().toLowerCase();
  }

  isBlocked(exitIp) {
    return this.blockedExitIps.has(this.#normalizeExitIp(exitIp));
  }

  #speedTimeoutMs() {
    // Allow for the proxy handshake on top of the fixed warm-up + measurement window.
    return Math.max(SPEED_TIMEOUT_MS, this.probeTimeoutMs + 5_000);
  }

  #emitProgress(stage, { done = 0, total = 0, message } = {}) {
    const payload = {
      stage,
      done,
      total,
      message: message || stage,
    };
    this.emit("progress", payload);
    if (message) this.logger.info?.(message);
  }

  async refresh() {
    if (this.refreshing) return await this.refreshing;
    this.refreshing = this.#performRefresh();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  async #performRefresh() {
    this.emit("refresh-state", true);
    try {
      const previousCurrent = this.current;
      this.#emitProgress("fetch", {
        done: 0,
        total: this.sourceUrls?.length || 0,
        message: `Downloading published ${this.country} proxy lists…`,
      });
      const all = await fetchPublicProxyCandidates({
        country: this.country,
        sourceUrls: this.sourceUrls,
        logger: this.logger,
      });
      this.sourceCount = all.length;
      this.sourceStats = all.sourceStats || null;
      const sampleSize = adaptiveMaxCandidates(all.length, this.maxCandidates, this.country);
      const candidates = shuffledSample(all, sampleSize);
      this.#emitProgress("fetch", {
        done: this.sourceUrls?.length || 1,
        total: this.sourceUrls?.length || 1,
        message: `Fetched ${all.length} published ${this.country} candidates; sampling ${candidates.length}…`,
      });

      this.#emitProgress("probe", {
        done: 0,
        total: candidates.length,
        message: `Testing ${candidates.length} of ${all.length} published ${this.country} candidates…`,
      });

      const probeFailures = new Map();
      let probeHits = 0;
      const working = await mapConcurrent(
        candidates,
        this.concurrency,
        (proxy) => probeProxy(proxy, { country: this.country, timeoutMs: this.probeTimeoutMs }),
        (proxy, count) => {
          probeHits = count;
          this.logger.info?.(`  ${count}. ${proxyKey(proxy)} -> ${proxy.exitIp} (${proxy.latencyMs} ms)`);
          // Throttle structured progress so the UI is not flooded with 160 events.
          if (count === 1 || count === candidates.length || count % 5 === 0) {
            this.#emitProgress("probe", {
              done: count,
              total: candidates.length,
              message: `Verified ${count} working exit${count === 1 ? "" : "s"} of ${candidates.length} tested…`,
            });
          }
        },
        {
          onFailure: (error) => {
            tallyFailure(probeFailures, error);
          },
        },
      );
      if (working.length === 0) {
        const summary = formatFailureSummary(probeFailures, candidates.length);
        this.lastFailureSummary = summary;
        this.lastDiscoveryError = `None of ${candidates.length} sampled public proxies produced a verified ${this.country} HTTPS exit. ${summary}`.trim();
        throw new Error(this.lastDiscoveryError);
      }

      const firstPass = await enrichProxyNetworks(working, this.logger);
      // Throughput is expensive to measure, so first discard clearly slow or unsuitable candidates.
      firstPass.sort((left, right) => compareProxyQuality(left, right, this.rankMode));
      // Published lists frequently contain many ports that all lead to the same
      // egress address. Measure diverse exits, not duplicate front doors.
      const speedCandidates = uniqueExitIps(firstPass).slice(0, Math.max(this.poolSize * 4, 24));
      this.#emitProgress("speed", {
        done: 0,
        total: speedCandidates.length,
        message: `Measuring sustained throughput on the ${speedCandidates.length} strongest candidates (steady-state window)…`,
      });
      let speedHits = 0;
      const speedFailures = new Map();
      const benchmarked = await mapConcurrent(
        speedCandidates,
        Math.min(this.concurrency, 8),
        (proxy) => benchmarkProxyThroughput(proxy, { timeoutMs: this.#speedTimeoutMs() }),
        (proxy, count) => {
          speedHits = count;
          this.logger.info?.(
            `  speed ${count}. ${proxyKey(proxy)} -> ${proxy.throughputMbps} Mbps`,
          );
          this.#emitProgress("speed", {
            done: count,
            total: speedCandidates.length,
            message: `Speed-tested ${count}/${speedCandidates.length} exits…`,
          });
        },
        {
          onFailure: (error) => {
            tallyFailure(speedFailures, error);
          },
        },
      );
      if (benchmarked.length === 0) {
        const summary = formatFailureSummary(speedFailures, speedCandidates.length);
        this.lastFailureSummary = summary;
        this.lastDiscoveryError = `Responsive proxies failed the sustained throughput test; refresh to sample another set. ${summary}`.trim();
        throw new Error(this.lastDiscoveryError);
      }
      // Enforce a usable-speed floor. Prioritizing speed means dropping exits
      // measured below the floor, but never emptying the pool over it: if no exit
      // clears the bar we keep the fastest available and warn.
      const fastEnough = benchmarked.filter((proxy) => proxy.throughputMbps >= this.minThroughputMbps);
      const ranked = fastEnough.length > 0 ? fastEnough : benchmarked;
      if (this.minThroughputMbps > 0 && fastEnough.length < benchmarked.length) {
        this.logger.info?.(
          `${fastEnough.length}/${benchmarked.length} exits cleared the ${this.minThroughputMbps} Mbps floor`,
        );
      }
      ranked.sort((left, right) => compareProxyQuality(left, right, this.rankMode));
      const confirmationCandidates = ranked.slice(0, Math.max(this.poolSize * 3, this.poolSize));
      this.#emitProgress("confirm", {
        done: 0,
        total: confirmationCandidates.length,
        message: `Confirming the ${confirmationCandidates.length} best candidates across independent HTTPS hosts…`,
      });
      const firstByKey = new Map(confirmationCandidates.map((proxy) => [proxyKey(proxy), proxy]));
      const confirmFailures = new Map();
      const confirmed = await mapConcurrent(
        confirmationCandidates,
        Math.min(this.concurrency, 12),
        async (proxy) => {
          // A browser opens several unrelated TLS tunnels at once. Require that behavior here,
          // rather than admitting exits which only work against the location-test host.
          // A second throughput sample lets us report a stable, conservative
          // bandwidth number and flag exits whose speed is erratic.
          const [second, readiness, reSample] = await Promise.all([
            probeProxy(proxy, {
              country: this.country,
              timeoutMs: this.probeTimeoutMs,
            }),
            probeBrowserReadiness(proxy, { timeoutMs: this.probeTimeoutMs }),
            measureDownloadThroughput(proxy, { timeoutMs: this.#speedTimeoutMs() }).catch(() => null),
          ]);
          const samples = [proxy.throughputMbps, reSample?.throughputMbps].filter(
            (value) => Number.isFinite(value) && value > 0,
          );
          const combined = combineThroughputSamples(samples);
          return {
            ...second,
            ...readiness,
            throughputMbps: combined.throughputMbps,
            speedConsistency: combined.consistency,
            throughputSamples: samples.length,
            latencyMs: Math.round((proxy.latencyMs + second.latencyMs) / 2),
            firstLatencyMs: firstByKey.get(proxyKey(proxy)).latencyMs,
          };
        },
        (proxy, count) => {
          this.#emitProgress("confirm", {
            done: count,
            total: confirmationCandidates.length,
            message: `Confirmed ${count}/${confirmationCandidates.length} exits…`,
          });
        },
        {
          onFailure: (error) => {
            tallyFailure(confirmFailures, error);
          },
        },
      );
      if (confirmed.length === 0) {
        const summary = formatFailureSummary(confirmFailures, confirmationCandidates.length);
        this.lastFailureSummary = summary;
        this.lastDiscoveryError = `Working proxies failed their second stability check; refresh to sample another set. ${summary}`.trim();
        throw new Error(this.lastDiscoveryError);
      }
      const enriched = await enrichProxyNetworks(confirmed, this.logger);
      enriched.sort((left, right) => compareProxyQuality(left, right, this.rankMode));

      // A refresh can overlap live browser traffic. Preserve the exit that is
      // authoritative at commit time, not the one that happened to be current
      // when the refresh began.
      this.#emitProgress("commit", {
        done: 0,
        total: 1,
        message: "Selecting the best verified exit…",
      });
      const activeBeforeCommit = this.current ?? previousCurrent;
      const activeKey = activeBeforeCommit ? proxyKey(activeBeforeCommit) : null;
      const distinct = uniqueExitIps(enriched);
      const unblocked = distinct.filter((proxy) => !this.isBlocked(proxy.exitIp));
      // Prefer ASN diversity so the fallback pool is not eight ports on one ASN.
      this.proxies = diversifyByAsn(unblocked, this.poolSize);
      if (this.proxies.length === 0) {
        this.lastDiscoveryError = this.blockedExitIps.size > 0
          ? "Confirmed proxies were all on the blocklist or lacked a usable distinct exit IP"
          : "Confirmed proxies did not contain a usable distinct exit IP";
        throw new Error(this.lastDiscoveryError);
      }
      let preservedIndex = this.proxies.findIndex((proxy) => proxyKey(proxy) === activeKey);
      if (activeBeforeCommit && preservedIndex < 0 && !this.autoFallback) {
        this.proxies = [
          activeBeforeCommit,
          ...this.proxies.filter((proxy) => proxyKey(proxy) !== activeKey),
        ].slice(0, this.poolSize);
        preservedIndex = 0;
        this.logger.info?.(`Strict IP mode retained ${activeBeforeCommit.exitIp} as the active exit`);
      }
      this.currentIndex = preservedIndex >= 0 ? preservedIndex : 0;
      this.lastRefresh = new Date().toISOString();
      this.lastDiscoveryError = null;
      this.lastFailureSummary = probeHits > 0
        ? `Probe hits ${probeHits}/${candidates.length}; speed hits ${speedHits}/${speedCandidates.length}.`
        : null;
      this.#emitProgress("commit", {
        done: 1,
        total: 1,
        message: `Selected ${proxyKey(this.current)} (${this.current.exitIp}, ${this.current.latencyMs} ms, ${this.current.throughputMbps} Mbps); ${this.proxies.length} verified exits retained`,
      });
      this.emit("updated", this.status());
      return this.proxies;
    } catch (error) {
      if (!this.lastDiscoveryError) {
        this.lastDiscoveryError = error?.message || String(error);
      }
      throw error;
    } finally {
      this.emit("refresh-state", false);
    }
  }

  get current() {
    return this.proxies[this.currentIndex] ?? null;
  }

  ordered() {
    if (this.proxies.length === 0) return [];
    return [
      ...this.proxies.slice(this.currentIndex),
      ...this.proxies.slice(0, this.currentIndex),
    ];
  }

  rotate() {
    if (this.proxies.length === 0) return null;
    const start = this.currentIndex;
    for (let step = 1; step <= this.proxies.length; step += 1) {
      const index = (start + step) % this.proxies.length;
      if (!this.isBlocked(this.proxies[index].exitIp)) {
        this.currentIndex = index;
        this.emit("updated", this.status());
        this.logger.info?.(`Rotated to ${proxyKey(this.current)} (${this.current.exitIp})`);
        return this.current;
      }
    }
    this.emit("updated", this.status());
    return this.current;
  }

  // Switch directly to a specific verified exit, e.g. one the user picked from
  // the pool list, rather than stepping through the ordered rotation.
  selectExit({ protocol, host, port }) {
    const targetKey = proxyKey({ protocol, host, port: Number(port) });
    const index = this.proxies.findIndex((item) => proxyKey(item) === targetKey);
    if (index === -1) return null;
    if (this.isBlocked(this.proxies[index].exitIp)) return null;
    this.currentIndex = index;
    this.emit("updated", this.status());
    this.logger.info?.(`Selected ${proxyKey(this.current)} (${this.current.exitIp})`);
    return this.current;
  }

  // Permanently exclude an exit IP from this session's pool (and future refreshes
  // until the blocklist is cleared). If the active exit is blocked, rotate away.
  blockExit(exitIp) {
    const key = this.#normalizeExitIp(exitIp);
    if (!key) return this.status();
    this.blockedExitIps.add(key);
    const wasCurrent = this.current && this.#normalizeExitIp(this.current.exitIp) === key;
    this.proxies = this.proxies.filter((proxy) => this.#normalizeExitIp(proxy.exitIp) !== key);
    if (this.proxies.length === 0) {
      this.currentIndex = 0;
    } else if (wasCurrent || this.currentIndex >= this.proxies.length) {
      this.currentIndex = 0;
    }
    this.logger.info?.(`Blocked exit IP ${key}; ${this.proxies.length} exits remain in the pool`);
    this.emit("updated", this.status());
    return this.status();
  }

  unblockExit(exitIp) {
    const key = this.#normalizeExitIp(exitIp);
    if (!key) return this.status();
    this.blockedExitIps.delete(key);
    this.emit("updated", this.status());
    return this.status();
  }

  reportSuccess(proxy) {
    const index = this.proxies.findIndex((item) => proxyKey(item) === proxyKey(proxy));
    if (index === -1) return;
    this.proxies[index].successes += 1;
    this.proxies[index].consecutiveFailures = 0;
    this.proxies[index].lastUsed = new Date().toISOString();
    // A connection that started before a rotation can finish afterwards. Its
    // late success must never switch the entire browser back to the stale exit.
  }

  reportFailure(proxy) {
    const index = this.proxies.findIndex((item) => proxyKey(item) === proxyKey(proxy));
    if (index === -1) return;
    this.proxies[index].failures += 1;
    this.proxies[index].consecutiveFailures = (this.proxies[index].consecutiveFailures || 0) + 1;
    this.proxies[index].lastFailure = new Date().toISOString();
    if (
      this.autoFallback &&
      index === this.currentIndex &&
      this.proxies[index].consecutiveFailures >= 3 &&
      this.proxies.length > 1
    ) {
      this.logger.warn?.(`Active exit failed 3 consecutive tunnels; switching to a verified fallback`);
      this.rotate();
    } else {
      this.emit("updated", this.status());
    }
  }

  // Lightweight liveness check for the active exit. Used by the background
  // heartbeat so a "live" route is re-verified without waiting for browser traffic.
  async heartbeat() {
    if (this.refreshing || this._heartbeatRunning) return null;
    const proxy = this.current;
    if (!proxy) return null;
    this._heartbeatRunning = true;
    try {
      await probeProxy(proxy, {
        country: this.country,
        timeoutMs: this.probeTimeoutMs,
      });
      this.reportSuccess(proxy);
      return { ok: true, proxy };
    } catch (error) {
      this.logger.warn?.(
        `Heartbeat failed for ${proxyKey(proxy)} (${classifyProbeError(error)}): ${error.message}`,
      );
      this.reportFailure(proxy);
      return { ok: false, proxy, error: error.message };
    } finally {
      this._heartbeatRunning = false;
    }
  }

  status() {
    return {
      country: this.country,
      rankMode: this.rankMode,
      sourceCount: this.sourceCount,
      lastRefresh: this.lastRefresh,
      refreshing: Boolean(this.refreshing),
      autoFallback: this.autoFallback,
      lastDiscoveryError: this.lastDiscoveryError,
      lastFailureSummary: this.lastFailureSummary,
      sourceStats: this.sourceStats,
      blockedExitIps: [...this.blockedExitIps],
      current: this.current,
      proxies: this.proxies,
    };
  }
}

export function uniqueExitIps(proxies) {
  const seen = new Set();
  return proxies.filter((proxy) => {
    const key = String(proxy.exitIp || "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Fill a pool preferring distinct ASNs first (round-robin by network quality
 * order), then backfill with remaining exits. Input should already be sorted
 * best-first and deduplicated by exit IP.
 */
export function diversifyByAsn(proxies, limit) {
  const size = Math.max(0, Number(limit) || 0);
  if (size === 0 || !Array.isArray(proxies) || proxies.length === 0) return [];
  if (proxies.length <= size) return proxies.slice(0, size);

  const buckets = new Map();
  const order = [];
  for (const proxy of proxies) {
    const asnKey = proxy.network?.asn != null ? `asn:${proxy.network.asn}` : `ip:${proxy.exitIp}`;
    if (!buckets.has(asnKey)) {
      buckets.set(asnKey, []);
      order.push(asnKey);
    }
    buckets.get(asnKey).push(proxy);
  }

  const selected = [];
  let progress = true;
  while (selected.length < size && progress) {
    progress = false;
    for (const key of order) {
      const bucket = buckets.get(key);
      if (!bucket?.length) continue;
      selected.push(bucket.shift());
      progress = true;
      if (selected.length >= size) break;
    }
  }
  return selected;
}
