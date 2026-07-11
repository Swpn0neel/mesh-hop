import { domainToASCII } from "node:url";
import net from "node:net";
import ipaddr from "ipaddr.js";

function validateDnsHost(value, { minLabels }) {
  if (typeof value !== "string") throw new Error("Destination host is missing");
  const withoutDot = value.trim().replace(/\.$/, "");
  const ascii = domainToASCII(withoutDot).toLowerCase();
  if (!ascii || ascii.length > 253 || net.isIP(ascii)) {
    throw new Error("Only DNS hostnames are accepted");
  }

  const labels = ascii.split(".");
  if (
    labels.length < minLabels ||
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

// Registrable DNS hostnames only (at least two labels); rejects IP literals.
// Used for the plain-HTTP -> HTTPS upgrade path.
export function normalizeDomain(value) {
  return validateDnsHost(value, { minLabels: 2 });
}

// A browser may CONNECT to an IP literal or a single-label intranet host as well
// as an ordinary hostname. IP literals pass through unchanged; everything else is
// validated as a DNS hostname, allowing a single label.
export function normalizeConnectHost(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (net.isIP(trimmed)) return trimmed.toLowerCase();
  }
  return validateDnsHost(value, { minLabels: 1 });
}

export function isPublicAddress(address) {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  return parsed.range() === "unicast";
}

export function parseConnectAuthority(authority) {
  if (typeof authority !== "string" || authority.length > 300) {
    throw new Error("CONNECT destination is malformed");
  }
  let host;
  let portText;
  if (authority.startsWith("[")) {
    // Bracketed IPv6 literal: [addr]:port
    const end = authority.indexOf("]");
    if (end <= 1) throw new Error("CONNECT destination is malformed");
    host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (!rest.startsWith(":")) throw new Error("CONNECT destination must include a port");
    portText = rest.slice(1);
  } else {
    const lastColon = authority.lastIndexOf(":");
    if (lastColon <= 0) throw new Error("CONNECT destination must include a port");
    host = authority.slice(0, lastColon);
    portText = authority.slice(lastColon + 1);
  }
  if (!/^\d+$/.test(portText)) throw new Error("CONNECT port is invalid");
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error("CONNECT port is invalid");
  return { host: normalizeConnectHost(host), port };
}
