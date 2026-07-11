import { normalizeDomain } from "./net-policy.js";

export function httpsUpgradeLocation(requestTarget, hostHeader = "") {
  if (typeof requestTarget !== "string" || requestTarget.length === 0 || requestTarget.length > 8_192) {
    throw new Error("HTTP proxy destination is malformed");
  }

  let target;
  try {
    target = requestTarget.startsWith("/")
      ? new URL(requestTarget, `http://${hostHeader}`)
      : new URL(requestTarget);
  } catch {
    throw new Error("HTTP proxy destination is malformed");
  }

  if (target.protocol !== "http:") throw new Error("Only HTTP requests can be upgraded");
  if (target.username || target.password) throw new Error("Credentials in proxy destinations are not accepted");
  if (target.port && target.port !== "80") throw new Error("Only the standard HTTP port can be upgraded");

  const host = normalizeDomain(target.hostname);
  return `https://${host}${target.pathname}${target.search}`;
}

export function redirectHttpRequestToHttps(request, response, productName = "MeshHop") {
  request.resume();
  let location;
  try {
    location = httpsUpgradeLocation(request.url, request.headers.host);
  } catch (error) {
    const body = `${error.message}\n`;
    response.writeHead(400, {
      "cache-control": "no-store",
      "connection": "close",
      "content-length": Buffer.byteLength(body),
      "content-type": "text/plain; charset=utf-8",
    });
    response.end(body);
    return;
  }

  const body = `${productName} is upgrading this request to HTTPS.\n`;
  response.writeHead(308, {
    "cache-control": "no-store",
    "connection": "close",
    "content-length": Buffer.byteLength(body),
    "content-type": "text/plain; charset=utf-8",
    location,
  });
  response.end(body);
}
