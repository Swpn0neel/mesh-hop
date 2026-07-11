import { domainToASCII } from "node:url";
import dns from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";

export function normalizeDomain(value) {
  if (typeof value !== "string") throw new Error("Destination host is missing");
  const withoutDot = value.trim().replace(/\.$/, "");
  const ascii = domainToASCII(withoutDot).toLowerCase();
  if (!ascii || ascii.length > 253 || net.isIP(ascii)) {
    throw new Error("Only DNS hostnames are accepted");
  }

  const labels = ascii.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    throw new Error("Destination hostname is invalid");
  }
  return ascii;
}

export function parseAllowlist(value = "") {
  const rules = [];
  for (const rawRule of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const suffixRule = rawRule.startsWith("*.");
    const domain = normalizeDomain(suffixRule ? rawRule.slice(2) : rawRule);
    rules.push({ type: suffixRule ? "suffix" : "exact", domain });
  }
  return rules;
}

export function isDomainAllowed(host, rules, allowAllPublicHttps = false) {
  const domain = normalizeDomain(host);
  if (allowAllPublicHttps) return true;

  return rules.some((rule) => {
    if (rule.type === "exact") return domain === rule.domain;
    return domain === rule.domain || domain.endsWith(`.${rule.domain}`);
  });
}

export function validateDestination(
  host,
  port,
  { rules = [], allowAllPublicHttps = false } = {},
) {
  const domain = normalizeDomain(host);
  if (Number(port) !== 443) {
    throw new Error("Only HTTPS destinations on port 443 are allowed");
  }
  if (!isDomainAllowed(domain, rules, allowAllPublicHttps)) {
    throw new Error(`The exit operator has not allowed ${domain}`);
  }
  return { host: domain, port: 443 };
}

export function isPublicAddress(address) {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  return parsed.range() === "unicast";
}

export async function resolvePublicAddresses(host, lookup = dns.lookup) {
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error("Destination did not resolve to an address");
  }
  if (addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Destination resolved to a private or reserved address");
  }

  return [
    ...new Map(
      addresses.map(({ address, family }) => [address, { address, family: Number(family) }]),
    ).values(),
  ];
}

export function parseConnectAuthority(authority) {
  if (typeof authority !== "string" || authority.length > 300) {
    throw new Error("CONNECT destination is malformed");
  }
  const lastColon = authority.lastIndexOf(":");
  if (lastColon <= 0) throw new Error("CONNECT destination must include a port");
  const host = authority.slice(0, lastColon);
  const portText = authority.slice(lastColon + 1);
  if (!/^\d+$/.test(portText)) throw new Error("CONNECT port is invalid");
  return { host: normalizeDomain(host), port: Number(portText) };
}
