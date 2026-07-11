const hostingPattern = new RegExp(
  [
    "amazon", "aws", "google", "microsoft", "azure", "oracle", "digitalocean", "hetzner",
    "ovh", "vultr", "linode", "akamai", "alibaba", "tencent", "contabo", "leaseweb",
    "gigenet", "readydedis", "hivelocity", "m247", "choopa", "server", "hosting",
    "datacenter", "data center", "cloud", "colo", "vps", "dedicated", "liquid web",
    "liquidweb", "godaddy",
  ].join("|"),
  "i",
);

const consumerPattern = new RegExp(
  [
    "comcast", "xfinity", "charter", "spectrum", "verizon", "at&t", "att internet",
    "cox", "t-mobile", "tmobile", "centurylink", "lumen", "frontier", "mediacom",
    "optimum", "cable", "broadband", "wireless", "fiber", "telecom", "residential",
  ].join("|"),
  "i",
);

export function classifyConnection(connection = {}) {
  const description = [connection.org, connection.isp, connection.domain].filter(Boolean).join(" ");
  if (hostingPattern.test(description)) return "hosting-likely";
  if (consumerPattern.test(description)) return "consumer-likely";
  return "unknown";
}

export async function lookupNetwork(exitIp, timeoutMs = 5_000) {
  const response = await fetch(`https://ipwho.is/${encodeURIComponent(exitIp)}`, {
    headers: { "user-agent": "MeshHop-Public/0.2 (+personal proxy ranker)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Network lookup returned HTTP ${response.status}`);
  const body = await response.json();
  if (!body.success || !body.connection) throw new Error(body.message || "Network lookup failed");
  return {
    asn: body.connection.asn,
    org: body.connection.org,
    isp: body.connection.isp,
    domain: body.connection.domain,
    kind: classifyConnection(body.connection),
  };
}

export async function enrichProxyNetworks(proxies, logger = console) {
  const lookups = new Map();
  await Promise.all(
    [...new Set(proxies.map((proxy) => proxy.exitIp))].map(async (exitIp) => {
      try {
        lookups.set(exitIp, await lookupNetwork(exitIp));
      } catch (error) {
        logger.warn?.(`Network classification failed for ${exitIp}: ${error.message}`);
      }
    }),
  );
  return proxies.map((proxy) => ({
    ...proxy,
    network: lookups.get(proxy.exitIp) ?? { kind: "unknown" },
  }));
}

export function compareProxyQuality(left, right, mode = "balanced") {
  const transferCost = (proxy, transferMegabits) => {
    const throughput = Number(proxy.throughputMbps);
    if (!Number.isFinite(throughput) || throughput <= 0) return 60_000;
    return (transferMegabits / throughput) * 1_000;
  };
  // Penalize exits whose two throughput samples disagree (erratic speed). The
  // score is in millisecond-equivalent units; a fully inconsistent exit adds
  // `weight` ms. Absent consistency (before the confirmation stage) is neutral.
  const instabilityPenalty = (proxy, weight) => {
    const consistency = Number.isFinite(proxy.speedConsistency) ? proxy.speedConsistency : 1;
    return (1 - Math.min(1, Math.max(0, consistency))) * weight;
  };
  const performanceScore = (proxy, transferMegabits, instabilityWeight) =>
    Number(proxy.latencyMs || 0) + transferCost(proxy, transferMegabits) + instabilityPenalty(proxy, instabilityWeight);

  // Approximate the time to establish the route and transfer a representative page-sized payload.
  if (mode === "speed") return performanceScore(left, 8, 700) - performanceScore(right, 8, 700);
  if (mode === "consumer") {
    const tier = { "consumer-likely": 0, unknown: 1, "hosting-likely": 2 };
    const difference = (tier[left.network?.kind] ?? 1) - (tier[right.network?.kind] ?? 1);
    return difference || performanceScore(left, 2, 400) - performanceScore(right, 2, 400);
  }
  const penalty = { "consumer-likely": 0, unknown: 600, "hosting-likely": 1600 };
  const leftScore = performanceScore(left, 3, 800) + (penalty[left.network?.kind] ?? penalty.unknown);
  const rightScore = performanceScore(right, 3, 800) + (penalty[right.network?.kind] ?? penalty.unknown);
  return leftScore - rightScore;
}
