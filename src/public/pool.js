import { EventEmitter } from "node:events";
import { compareProxyQuality, enrichProxyNetworks } from "./network.js";
import { benchmarkProxyThroughput, mapConcurrent, probeBrowserReadiness, probeProxy } from "./probe.js";
import {
  DEFAULT_SOURCE_URLS,
  fetchPublicProxyCandidates,
  proxyKey,
  shuffledSample,
} from "./sources.js";

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
    logger = console,
  } = {}) {
    super();
    this.country = String(country).toUpperCase();
    this.sourceUrls = sourceUrls;
    this.maxCandidates = maxCandidates;
    this.concurrency = concurrency;
    this.probeTimeoutMs = probeTimeoutMs;
    this.poolSize = poolSize;
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
      const all = await fetchPublicProxyCandidates({
        country: this.country,
        sourceUrls: this.sourceUrls,
        logger: this.logger,
      });
      this.sourceCount = all.length;
      const candidates = shuffledSample(all, this.maxCandidates);
      this.logger.info?.(`Testing ${candidates.length} of ${all.length} published ${this.country} candidates...`);

      const working = await mapConcurrent(
        candidates,
        this.concurrency,
        (proxy) => probeProxy(proxy, { country: this.country, timeoutMs: this.probeTimeoutMs }),
        (proxy, count) => this.logger.info?.(`  ${count}. ${proxyKey(proxy)} -> ${proxy.exitIp} (${proxy.latencyMs} ms)`),
      );
      if (working.length === 0) {
        throw new Error(
          `None of ${candidates.length} sampled public proxies produced a verified ${this.country} HTTPS exit`,
        );
      }

      const firstPass = await enrichProxyNetworks(working, this.logger);
      // Throughput is expensive to measure, so first discard clearly slow or unsuitable candidates.
      firstPass.sort((left, right) => compareProxyQuality(left, right, this.rankMode));
      // Published lists frequently contain many ports that all lead to the same
      // egress address. Measure diverse exits, not duplicate front doors.
      const speedCandidates = uniqueExitIps(firstPass).slice(0, Math.max(this.poolSize * 4, 24));
      const payloadBytes = this.rankMode === "speed" ? 256 * 1024 : 128 * 1024;
      this.logger.info?.(
        `Measuring sustained throughput on the ${speedCandidates.length} strongest candidates (${Math.round(payloadBytes / 1024)} KiB each)...`,
      );
      const benchmarked = await mapConcurrent(
        speedCandidates,
        Math.min(this.concurrency, 8),
        (proxy) => benchmarkProxyThroughput(proxy, {
          bytes: payloadBytes,
          timeoutMs: Math.max(8_000, this.probeTimeoutMs),
        }),
        (proxy, count) => this.logger.info?.(
          `  speed ${count}. ${proxyKey(proxy)} -> ${proxy.throughputMbps} Mbps`,
        ),
      );
      if (benchmarked.length === 0) {
        throw new Error("Responsive proxies failed the sustained throughput test; refresh to sample another set");
      }
      benchmarked.sort((left, right) => compareProxyQuality(left, right, this.rankMode));
      const confirmationCandidates = benchmarked.slice(0, Math.max(this.poolSize * 3, this.poolSize));
      this.logger.info?.(`Confirming the ${confirmationCandidates.length} best candidates across independent HTTPS hosts...`);
      const firstByKey = new Map(confirmationCandidates.map((proxy) => [proxyKey(proxy), proxy]));
      const confirmed = await mapConcurrent(
        confirmationCandidates,
        Math.min(this.concurrency, 12),
        async (proxy) => {
          // A browser opens several unrelated TLS tunnels at once. Require that behavior here,
          // rather than admitting exits which only work against the location-test host.
          const [second, readiness] = await Promise.all([
            probeProxy(proxy, {
              country: this.country,
              timeoutMs: this.probeTimeoutMs,
            }),
            probeBrowserReadiness(proxy, { timeoutMs: this.probeTimeoutMs }),
          ]);
          return {
            ...second,
            ...readiness,
            latencyMs: Math.round((proxy.latencyMs + second.latencyMs) / 2),
            firstLatencyMs: firstByKey.get(proxyKey(proxy)).latencyMs,
          };
        },
      );
      if (confirmed.length === 0) {
        throw new Error("Working proxies failed their second stability check; refresh to sample another set");
      }
      const enriched = await enrichProxyNetworks(confirmed, this.logger);
      enriched.sort((left, right) => compareProxyQuality(left, right, this.rankMode));

      // A refresh can overlap live browser traffic. Preserve the exit that is
      // authoritative at commit time, not the one that happened to be current
      // when the refresh began.
      const activeBeforeCommit = this.current ?? previousCurrent;
      const activeKey = activeBeforeCommit ? proxyKey(activeBeforeCommit) : null;
      this.proxies = uniqueExitIps(enriched).slice(0, this.poolSize);
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
      this.logger.info?.(
        `Selected ${proxyKey(this.current)} (${this.current.exitIp}, ${this.current.latencyMs} ms, ${this.current.throughputMbps} Mbps); ${this.proxies.length} verified exits retained`,
      );
      this.emit("updated", this.status());
      return this.proxies;
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
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    this.emit("updated", this.status());
    this.logger.info?.(`Rotated to ${proxyKey(this.current)} (${this.current.exitIp})`);
    return this.current;
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

  status() {
    return {
      country: this.country,
      rankMode: this.rankMode,
      sourceCount: this.sourceCount,
      lastRefresh: this.lastRefresh,
      refreshing: Boolean(this.refreshing),
      autoFallback: this.autoFallback,
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
