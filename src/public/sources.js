import net from "node:net";
import { isPublicAddress } from "../net-policy.js";
import { userAgent } from "./user-agent.js";

// Primary country-scoped free lists. ProxyScrape is a third source so a single
// outage does not empty discovery; all remain free and unauthenticated.
export const DEFAULT_SOURCE_URLS = Object.freeze([
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/{COUNTRY}/data.txt",
  "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/countries/{COUNTRY}/proxies.txt",
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country={COUNTRY}&ssl=all&anonymity=all",
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000&country={COUNTRY}",
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country={COUNTRY}",
]);

// Countries that usually publish large free-proxy inventories. Others get a
// larger sample budget so discovery is not starved by the default MAX_CANDIDATES.
const HIGH_SUPPLY_COUNTRIES = new Set(["US", "GB", "DE", "NL", "FR", "CA", "RU", "BR", "IN"]);

const supportedProtocols = new Set(["http:", "https:", "socks4:", "socks5:"]);

export function proxyKey(proxy) {
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
}

export function parseProxyLines(text, { defaultProtocol = "http" } = {}) {
  const proxies = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let url;
    try {
      // ProxyScrape returns bare host:port lines without a scheme.
      const withScheme = line.includes("://") ? line : `${defaultProtocol}://${line}`;
      url = new URL(withScheme);
    } catch {
      continue;
    }
    if (!supportedProtocols.has(url.protocol) || url.username || url.password) continue;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const defaultPort = url.protocol === "http:" ? 80 : url.protocol === "https:" ? 443 : 0;
    const port = Number(url.port || defaultPort);
    if (!net.isIP(host) || !isPublicAddress(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      continue;
    }
    proxies.push({ protocol: url.protocol.slice(0, -1), host, port });
  }
  return proxies;
}

function defaultProtocolForUrl(url) {
  if (/protocol=socks5/i.test(url)) return "socks5";
  if (/protocol=socks4/i.test(url)) return "socks4";
  if (/protocol=https/i.test(url)) return "https";
  return "http";
}

async function fetchSource(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { "user-agent": userAgent("+personal proxy validator") },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return parseProxyLines(await response.text(), { defaultProtocol: defaultProtocolForUrl(url) });
}

/**
 * Choose how many candidates to probe for a country given list size and the
 * user-requested sample. Rare countries sample more aggressively (up to 1.5×)
 * so a thin list still has a chance to produce verified exits.
 */
export function adaptiveMaxCandidates(availableCount, requestedMax, country = "US") {
  const available = Math.max(0, Number(availableCount) || 0);
  const requested = Math.max(1, Number(requestedMax) || 1);
  if (available === 0) return 0;
  const code = String(country).toUpperCase();
  const multiplier = HIGH_SUPPLY_COUNTRIES.has(code) ? 1 : 1.5;
  const target = Math.ceil(requested * multiplier);
  return Math.min(available, Math.max(requested, target));
}

export async function fetchPublicProxyCandidates({
  country = "US",
  sourceUrls = DEFAULT_SOURCE_URLS,
  timeoutMs = 15_000,
  logger = console,
} = {}) {
  const countryCode = String(country).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error("COUNTRY must be a two-letter code");
  const urls = sourceUrls.map((template) => template.replaceAll("{COUNTRY}", countryCode));
  const results = await Promise.allSettled(urls.map((url) => fetchSource(url, timeoutMs)));
  const deduplicated = new Map();
  const sourceStats = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "rejected") {
      logger.warn?.(`Proxy source failed (${urls[index]}): ${result.reason.message}`);
      sourceStats.push({ url: urls[index], ok: false, count: 0, error: result.reason.message });
      continue;
    }
    let added = 0;
    for (const proxy of result.value) {
      const key = proxyKey(proxy);
      if (!deduplicated.has(key)) {
        deduplicated.set(key, proxy);
        added += 1;
      }
    }
    sourceStats.push({ url: urls[index], ok: true, count: result.value.length, uniqueAdded: added });
    logger.info?.(
      `Source contributed ${result.value.length} rows (${added} new) from ${urls[index].slice(0, 72)}…`,
    );
  }

  const candidates = [...deduplicated.values()];
  if (candidates.length === 0) throw new Error("No supported proxies were returned by the configured sources");
  // Attach stats for diagnostics without changing the array shape used by callers.
  candidates.sourceStats = sourceStats;
  return candidates;
}

export function shuffledSample(items, maximum) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy.slice(0, Math.min(maximum, copy.length));
}
