import net from "node:net";
import { isPublicAddress } from "../net-policy.js";

export const DEFAULT_SOURCE_URLS = Object.freeze([
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/{COUNTRY}/data.txt",
  "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/countries/{COUNTRY}/proxies.txt",
]);

const supportedProtocols = new Set(["http:", "https:", "socks4:", "socks5:"]);

export function proxyKey(proxy) {
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
}

export function parseProxyLines(text) {
  const proxies = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let url;
    try {
      url = new URL(line.includes("://") ? line : `http://${line}`);
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

async function fetchSource(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { "user-agent": "MeshHop-Public/0.2 (+personal proxy validator)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return parseProxyLines(await response.text());
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

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "rejected") {
      logger.warn?.(`Proxy source failed (${urls[index]}): ${result.reason.message}`);
      continue;
    }
    for (const proxy of result.value) deduplicated.set(proxyKey(proxy), proxy);
  }

  const candidates = [...deduplicated.values()];
  if (candidates.length === 0) throw new Error("No supported proxies were returned by the configured sources");
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
