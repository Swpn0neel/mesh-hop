#!/usr/bin/env node
import http from "node:http";
import { pathToFileURL } from "node:url";
import { redirectHttpRequestToHttps } from "./http-upgrade.js";
import { parseConnectAuthority } from "./net-policy.js";
import { PublicProxyPool } from "./public/pool.js";
import { DEFAULT_SOURCE_URLS, proxyKey } from "./public/sources.js";
import { connectViaProxy } from "./public/tunnel.js";

function proxyError(socket, status, message) {
  if (socket.destroyed) return;
  const body = String(message).replace(/[\r\n]/g, " ").slice(0, 300);
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

const dashboardHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MeshHop Public</title>
<style>
body{font:15px system-ui;max-width:760px;margin:48px auto;padding:0 20px;color:#18202a;background:#f6f7f9}
.card{background:white;border:1px solid #dfe3e8;border-radius:14px;padding:22px;box-shadow:0 6px 24px #0000000a}
h1{margin-top:0}button{border:0;border-radius:8px;padding:10px 15px;margin-right:8px;background:#1565c0;color:#fff;cursor:pointer}
button.secondary{background:#5f6b76}code{background:#eef1f4;padding:2px 5px;border-radius:4px}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{text-align:left;padding:8px;border-bottom:1px solid #eee}.muted{color:#697582}
</style>
<div class="card"><h1>MeshHop Public</h1><div id="summary">Loading…</div><p><button onclick="act('rotate')">Rotate IP</button><button class="secondary" onclick="act('refresh')">Find fresh proxies</button></p><div id="pool"></div></div>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){const s=await fetch('/api/status').then(r=>r.json());const c=s.current;document.querySelector('#summary').innerHTML=c?'<b>Active '+esc(s.country)+' exit:</b> <code>'+esc(c.exitIp)+'</code><br><span class="muted">'+esc(c.protocol)+'://'+esc(c.host)+':'+esc(c.port)+' · '+esc(c.latencyMs)+' ms · '+esc(c.throughputMbps)+' Mbps · '+esc(c.network?.kind)+' · refreshed '+esc(s.lastRefresh)+'</span>':'No working proxy selected';document.querySelector('#pool').innerHTML='<table><tr><th>Exit</th><th>Network</th><th>Speed</th><th>Failures</th></tr>'+s.proxies.map(p=>'<tr><td>'+esc(p.exitIp)+'</td><td>'+esc(p.network?.kind)+'<br><span class="muted">'+esc(p.network?.isp)+'</span></td><td>'+esc(p.throughputMbps)+' Mbps<br><span class="muted">'+esc(p.latencyMs)+' ms</span></td><td>'+esc(p.failures)+'</td></tr>').join('')+'</table>'}
async function act(name){document.querySelector('#summary').textContent=name==='refresh'?'Testing fresh public proxies…':'Rotating…';await fetch('/api/'+name,{method:'POST'});await load()}
load();setInterval(load,5000);
</script>`;

function createControlServer(pool) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(dashboardHtml);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(pool.status()));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/rotate") {
      pool.rotate();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(pool.status()));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      try {
        await pool.refresh();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(pool.status()));
      } catch (error) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error.message, ...pool.status() }));
      }
      return;
    }
    response.writeHead(404).end();
  });
}

async function listen(server, host, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return typeof address === "object" && address ? address.port : port;
}

export async function startPublicMode({
  country = "US",
  sourceUrls = DEFAULT_SOURCE_URLS,
  listenHost = "127.0.0.1",
  listenPort = 7777,
  controlPort = 7778,
  maxCandidates = 160,
  probeConcurrency = 40,
  probeTimeoutMs = 7_000,
  poolSize = 8,
  rankMode = "balanced",
  connectTimeoutMs = 5_000,
  maxAttempts = 3,
  autoFallback = true,
  refreshMinutes = 10,
  logger = console,
} = {}) {
  const pool = new PublicProxyPool({
    country,
    sourceUrls,
    maxCandidates,
    concurrency: probeConcurrency,
    probeTimeoutMs,
    poolSize,
    rankMode,
    autoFallback,
    logger,
  });
  await pool.refresh();
  const openSockets = new Set();

  const proxyServer = http.createServer((request, response) => {
    redirectHttpRequestToHttps(request, response, "MeshHop Public");
  });
  proxyServer.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });

  proxyServer.on("connect", async (request, clientSocket, head) => {
    let destination;
    try {
      destination = parseConnectAuthority(request.url);
      if (destination.port !== 443) throw new Error("Only HTTPS port 443 is supported");
    } catch (error) {
      proxyError(clientSocket, "400 Bad Request", error.message);
      return;
    }

    let proxy = pool.current;
    const attempted = new Set();
    const failures = [];
    while (proxy && attempted.size < Math.max(1, maxAttempts)) {
      const attemptedKey = proxyKey(proxy);
      if (attempted.has(attemptedKey)) break;
      attempted.add(attemptedKey);
      let upstream;
      try {
        upstream = await connectViaProxy(proxy, destination.host, destination.port, connectTimeoutMs);
      } catch (error) {
        failures.push(`${proxyKey(proxy)}: ${error.message}`);
        pool.reportFailure(proxy);
        const authoritative = pool.current;
        // Retry only when the pool itself crossed the failure threshold and
        // rotated. Individual requests no longer walk the fallback pool or
        // silently assign a different browser IP.
        if (
          autoFallback &&
          authoritative &&
          proxyKey(authoritative) !== attemptedKey
        ) {
          proxy = authoritative;
          continue;
        }
        break;
      }
      if (clientSocket.destroyed) {
        upstream.destroy();
        return;
      }
      const authoritative = pool.current;
      if (
        autoFallback &&
        authoritative &&
        proxyKey(authoritative) !== attemptedKey &&
        attempted.size < Math.max(1, maxAttempts)
      ) {
        // Another browser connection rotated the pool while this tunnel was
        // handshaking. Discard the stale tunnel so a page cannot span two IPs.
        upstream.destroy();
        proxy = authoritative;
        continue;
      }
      openSockets.add(upstream);
      upstream.once("close", () => openSockets.delete(upstream));
      pool.reportSuccess(proxy);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: MeshHop-Public\r\n\r\n");
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
      return;
    }
    if (autoFallback && (pool.current?.consecutiveFailures || 0) >= 3) {
      void pool.refresh().catch((error) => logger.warn?.(`Automatic recovery refresh failed: ${error.message}`));
    }
    const failureMessage = autoFallback
      ? `The active public exit could not open this tunnel. MeshHop keeps one IP until the failure threshold is reached. ${failures.join(" | ")}`
      : `The selected exit failed and automatic failover is disabled. Rotate IP or refresh manually. ${failures.join(" | ")}`;
    proxyError(clientSocket, "502 Bad Gateway", failureMessage);
  });

  const controlServer = createControlServer(pool);
  const actualProxyPort = await listen(proxyServer, listenHost, listenPort);
  const actualControlPort = await listen(controlServer, listenHost, controlPort);
  const refreshTimer = setInterval(() => {
    pool.refresh().catch((error) => logger.warn?.(`Background refresh failed: ${error.message}`));
  }, Math.max(1, refreshMinutes) * 60_000);
  refreshTimer.unref?.();

  logger.info?.(`Local browser proxy: http://${listenHost}:${actualProxyPort}`);
  logger.info?.(`Status and rotation: http://${listenHost}:${actualControlPort}`);

  return {
    pool,
    proxyServer,
    controlServer,
    proxyPort: actualProxyPort,
    controlPort: actualControlPort,
    async close() {
      clearInterval(refreshTimer);
      const proxyClosed = new Promise((resolve) => proxyServer.close(() => resolve()));
      const controlClosed = new Promise((resolve) => controlServer.close(() => resolve()));
      for (const socket of openSockets) socket.destroy();
      openSockets.clear();
      proxyServer.closeAllConnections?.();
      controlServer.closeAllConnections?.();
      await Promise.all([proxyClosed, controlClosed]);
    },
  };
}

function integerEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

async function main() {
  const sourceUrls = process.env.SOURCE_URLS
    ? process.env.SOURCE_URLS.split(",").map((value) => value.trim()).filter(Boolean)
    : DEFAULT_SOURCE_URLS;
  const options = {
    country: process.env.COUNTRY ?? "US",
    sourceUrls,
    listenPort: integerEnv("LISTEN_PORT", 7777),
    controlPort: integerEnv("CONTROL_PORT", 7778),
    maxCandidates: integerEnv("MAX_CANDIDATES", 160),
    probeConcurrency: integerEnv("PROBE_CONCURRENCY", 40),
    probeTimeoutMs: integerEnv("PROBE_TIMEOUT_MS", 7000),
    poolSize: integerEnv("POOL_SIZE", 8),
    rankMode: process.env.RANK_MODE ?? "balanced",
    connectTimeoutMs: integerEnv("CONNECT_TIMEOUT_MS", 5000),
    maxAttempts: integerEnv("MAX_ATTEMPTS", 3),
    autoFallback: !new Set(["0", "false", "no", "off"]).has(String(process.env.AUTO_FALLBACK ?? "1").toLowerCase()),
    refreshMinutes: integerEnv("REFRESH_MINUTES", 10),
  };

  if (process.argv.includes("--check")) {
    const pool = new PublicProxyPool({
      country: options.country,
      sourceUrls,
      maxCandidates: options.maxCandidates,
      concurrency: options.probeConcurrency,
      probeTimeoutMs: options.probeTimeoutMs,
      poolSize: options.poolSize,
      rankMode: options.rankMode,
      autoFallback: options.autoFallback,
    });
    await pool.refresh();
    console.log(JSON.stringify(pool.status(), null, 2));
    return;
  }
  const app = await startPublicMode(options);
  if (process.env.AUTO_LAUNCH_BROWSER !== "0") {
    console.log("Browser auto-launch is disabled in CLI mode. Please configure your browser manually.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
