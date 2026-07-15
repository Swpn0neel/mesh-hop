import { booleanEnv, integerEnv } from "./env.js";
import { startPublicMode } from "./public.js";

function emit(event, payload = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...payload })}\n`);
}

const logger = {
  info(message) {
    emit("log", { level: "info", message: String(message) });
  },
  warn(message) {
    emit("log", { level: "warn", message: String(message) });
  },
  error(message) {
    emit("log", { level: "error", message: String(message) });
  },
};

let app = null;
let closing = false;

async function shutdown(reason) {
  if (closing) return;
  closing = true;
  emit("log", { level: "info", message: `Stopping proxy engine (${reason})` });
  try {
    await app?.close();
  } finally {
    emit("stopped", { reason });
    process.exit(0);
  }
}

async function main() {
  const options = {
    country: process.env.COUNTRY ?? "US",
    rankMode: process.env.RANK_MODE ?? "balanced",
    listenPort: integerEnv("LISTEN_PORT", 7777),
    controlPort: integerEnv("CONTROL_PORT", 7778),
    maxCandidates: integerEnv("MAX_CANDIDATES", 160),
    probeConcurrency: integerEnv("PROBE_CONCURRENCY", 40),
    probeTimeoutMs: integerEnv("PROBE_TIMEOUT_MS", 7000),
    poolSize: integerEnv("POOL_SIZE", 8),
    connectTimeoutMs: integerEnv("CONNECT_TIMEOUT_MS", 5000),
    maxAttempts: integerEnv("MAX_ATTEMPTS", 3),
    autoFallback: booleanEnv("AUTO_FALLBACK", true),
    minThroughputMbps: integerEnv("MIN_THROUGHPUT_MBPS", 2, { minimum: 0 }),
    refreshMinutes: integerEnv("REFRESH_MINUTES", 10),
    controlToken: process.env.CONTROL_TOKEN || null,
    logger,
  };

  emit("starting", {
    country: options.country,
    rankMode: options.rankMode,
    proxyPort: options.listenPort,
    controlPort: options.controlPort,
  });
  app = await startPublicMode(options);
  app.pool.on("updated", (status) => emit("pool-updated", { status }));
  emit("ready", {
    proxyPort: app.proxyPort,
    controlPort: app.controlPort,
    status: app.pool.status(),
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  emit("fatal", { message: error.stack || error.message });
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  emit("fatal", { message: error?.stack || String(error) });
  process.exit(1);
});

main().catch((error) => {
  emit("fatal", { message: error.stack || error.message });
  process.exit(1);
});
