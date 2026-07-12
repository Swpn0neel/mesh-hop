import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* ------------------------------------------------------------------ *
 * Country metadata
 * ------------------------------------------------------------------ */
const COUNTRIES = {
  US: { name: "United States", the: "the United States" },
  GB: { name: "United Kingdom", the: "the United Kingdom" },
  CA: { name: "Canada", the: "Canada" },
  DE: { name: "Germany", the: "Germany" },
  NL: { name: "Netherlands", the: "the Netherlands" },
  SG: { name: "Singapore", the: "Singapore" },
  JP: { name: "Japan", the: "Japan" },
  AU: { name: "Australia", the: "Australia" },
};
const flag = (code) =>
  code && code.length === 2
    ? [...code.toUpperCase()].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("")
    : "🏳️";
const countryName = (code) => COUNTRIES[code]?.name ?? code ?? "—";

const RANK_HELP = {
  speed: "Selects the fastest measured route by sustained throughput and latency.",
  balanced: "Balances measured speed, latency, and consumer-ISP likelihood.",
  consumer: "Prefers consumer-ISP-looking exits, even if a little slower.",
};

const NETWORK_LABEL = {
  "consumer-likely": "Consumer ISP",
  "hosting-likely": "Hosting network",
  unknown: "Unclassified",
};

/* ------------------------------------------------------------------ *
 * Elements
 * ------------------------------------------------------------------ */
const el = (id) => document.getElementById(id);
const els = {};
for (const id of [
  "tbState", "tbStateText", "minButton", "maxButton", "closeButton",
  "idleRegion", "idleFlag", "country", "startButton", "options", "rankMode", "rankHelp",
  "sampleSize", "sampleValue", "poolSize", "autoFallback",
  "connectingRegion", "pipeline", "pipelineLive", "cancelButton",
  "exitFlag", "exitCountry", "liveBadge", "exitIp", "exitIsp", "exitNet",
  "statSpeed", "statLatency", "statConsistency", "openBrowser", "rotateButton", "refreshButton", "stopButton",
  "errorMessage", "retryButton", "errorStopButton",
  "drawer", "drawerHandle", "drawerBody", "tabExits", "tabActivity", "clearLogs",
  "exitsPanel", "activityPanel", "poolList", "logs", "exitsCount", "version", "toast",
]) {
  els[id] = el(id);
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
let status = { phase: "stopped", message: "Ready to connect", pool: null };
let selectedRank = "balanced";
let logEntries = [];
let actionBusy = false;
let toastTimer;
let maxStep = -1;
const STEPS = ["fetch", "test", "speed", "confirm"];

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
const stateText = { stopped: "Disconnected", starting: "Connecting…", running: "Connected", error: "Attention" };

function render() {
  const phase = status.phase ?? "stopped";
  const pool = status.pool;
  const current = pool?.current;
  document.body.dataset.phase = phase;
  els.tbStateText.textContent = stateText[phase] ?? phase;

  // Idle region echo
  const code = els.country.value;
  els.idleRegion.textContent = COUNTRIES[code]?.the ?? countryName(code);
  els.idleFlag.textContent = flag(code);
  els.connectingRegion.textContent = code;

  // Lock config while running/starting
  const locked = phase === "running" || phase === "starting";
  els.country.disabled = locked;
  els.sampleSize.disabled = locked;
  els.poolSize.disabled = locked;
  els.autoFallback.disabled = locked;
  for (const b of els.rankMode.querySelectorAll("button")) b.disabled = locked;
  els.startButton.disabled = actionBusy;
  els.cancelButton.disabled = actionBusy;

  if (phase === "error") {
    els.errorMessage.textContent = status.message || "The engine stopped unexpectedly.";
  }

  if (current) {
    const unhealthy = pool.autoFallback === false && (current.consecutiveFailures || 0) >= 3;
    els.exitFlag.textContent = flag(pool.country);
    els.exitCountry.textContent = countryName(pool.country);
    els.liveBadge.classList.toggle("warn", unhealthy);
    els.liveBadge.lastChild.textContent = unhealthy ? "Unstable" : "Live";
    els.exitIp.textContent = current.exitIp || "—";
    els.exitIsp.textContent = current.network?.isp || current.network?.org || "Unknown network";
    const kind = current.network?.kind ?? "unknown";
    els.exitNet.textContent = NETWORK_LABEL[kind] ?? NETWORK_LABEL.unknown;
    els.exitNet.className = `exit-net ${kind}`;
    els.statSpeed.textContent = current.throughputMbps ? `${current.throughputMbps} Mbps` : "—";
    els.statLatency.textContent = current.latencyMs != null ? `${current.latencyMs} ms` : "—";
    setConsistency(current.speedConsistency);
  }

  const canAct = phase === "running" && !actionBusy;
  els.openBrowser.disabled = !canAct;
  els.rotateButton.disabled = !canAct;
  els.refreshButton.disabled = !canAct;

  renderPool(pool);
}

function setConsistency(value) {
  if (value == null || Number.isNaN(value)) {
    els.statConsistency.textContent = "—";
    els.statConsistency.className = "stat-value";
    return;
  }
  const pct = Math.round(value * 100);
  els.statConsistency.textContent = `${pct}%`;
  els.statConsistency.className = `stat-value ${pct >= 80 ? "good" : pct < 55 ? "warn" : ""}`;
}

function renderPool(pool) {
  const proxies = pool?.proxies ?? [];
  const current = pool?.current;
  els.exitsCount.textContent = String(proxies.length);
  els.poolList.replaceChildren();

  if (!proxies.length) {
    const empty = document.createElement("div");
    empty.className = "pool-empty";
    empty.textContent = status.phase === "starting" ? "Testing candidates…" : "No verified exits yet.";
    els.poolList.append(empty);
    return;
  }

  for (const proxy of proxies) {
    const active = current && proxy.protocol === current.protocol && proxy.host === current.host && proxy.port === current.port;
    const row = document.createElement("div");
    row.className = `pool-row${active ? " active" : ""}`;

    const state = document.createElement("span");
    state.className = "pool-status";
    state.textContent = active ? "LIVE" : "STBY";

    const id = document.createElement("div");
    id.className = "pool-id";
    const ip = document.createElement("div");
    ip.className = "pool-ip";
    ip.textContent = proxy.exitIp || `${proxy.host}`;
    const net = document.createElement("div");
    net.className = "pool-net";
    net.textContent = proxy.network?.isp || NETWORK_LABEL[proxy.network?.kind] || "Unclassified";
    id.append(ip, net);

    const speed = document.createElement("div");
    speed.className = "pool-speed";
    const mbps = document.createElement("strong");
    mbps.textContent = proxy.throughputMbps ? `${proxy.throughputMbps} Mbps` : "—";
    const lat = document.createElement("span");
    lat.textContent = proxy.latencyMs != null ? `${proxy.latencyMs} ms` : "";
    speed.append(mbps, lat);

    row.append(state, id, speed);
    els.poolList.append(row);
  }
}

/* ------------------------------------------------------------------ *
 * Pipeline (connecting progress)
 * ------------------------------------------------------------------ */
function resetPipeline() {
  maxStep = 0;
  paintPipeline();
}

function stepFromMessage(message) {
  const s = message.toLowerCase();
  if (s.includes("confirm")) return 3;
  if (s.includes("throughput") || s.includes("measuring")) return 2;
  if (s.includes("testing") || s.includes("candidate") || s.includes("sampled")) return 1;
  if (s.includes("fetch") || s.includes("download") || s.includes("source") || s.includes("published")) return 0;
  return -1;
}

function advancePipeline(message) {
  const idx = stepFromMessage(message);
  if (idx > maxStep) {
    maxStep = idx;
    paintPipeline();
  }
}

function paintPipeline() {
  for (const li of els.pipeline.querySelectorAll(".step")) {
    const idx = STEPS.indexOf(li.dataset.step);
    li.classList.toggle("done", idx < maxStep);
    li.classList.toggle("active", idx === maxStep);
  }
}

/* ------------------------------------------------------------------ *
 * Logs & toast
 * ------------------------------------------------------------------ */
function addLog(level, message) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  logEntries.push({ time, level, message });
  logEntries = logEntries.slice(-160);
  const row = document.createElement("div");
  row.className = `log ${level}`;
  const t = document.createElement("span");
  t.textContent = time;
  const p = document.createElement("p");
  p.textContent = message;
  row.append(t, p);
  els.logs.append(row);
  while (els.logs.childElementCount > 160) els.logs.removeChild(els.logs.firstChild);
  els.logs.scrollTop = els.logs.scrollHeight;
}

function showToast(message, tone = "") {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast show ${tone}`;
  toastTimer = setTimeout(() => (els.toast.className = "toast"), 3600);
}

/* ------------------------------------------------------------------ *
 * Backend adapter (real Tauri, or mock for browser preview)
 * ------------------------------------------------------------------ */
const backend = isTauri ? realBackend() : mockBackend();

function realBackend() {
  const appWindow = getCurrentWindow();
  return {
    invoke: tauriInvoke,
    listen: tauriListen,
    minimize: () => appWindow.minimize(),
    toggleMaximize: () => appWindow.toggleMaximize(),
    close: () => appWindow.close(),
  };
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */
async function withAction(successMessage, fn) {
  if (actionBusy) return;
  actionBusy = true;
  render();
  try {
    const result = await fn();
    if (successMessage) showToast(successMessage, "success");
    return result;
  } catch (error) {
    showToast(String(error?.message ?? error), "error");
    addLog("error", String(error?.message ?? error));
  } finally {
    actionBusy = false;
    await updateStatus();
  }
}

function startConfig() {
  return {
    country: els.country.value,
    rankMode: selectedRank,
    maxCandidates: Number(els.sampleSize.value),
    poolSize: Number(els.poolSize.value),
    autoFallback: els.autoFallback.checked,
  };
}

async function connect() {
  logEntries = [];
  els.logs.replaceChildren();
  resetPipeline();
  els.pipelineLive.textContent = "Starting the proxy engine…";
  addLog("info", `Connecting to a ${els.country.value} exit in ${selectedRank} mode`);
  await withAction(null, async () => {
    status = await backend.invoke("start_engine", { config: startConfig() });
    render();
  });
}

async function updateStatus() {
  try {
    const next = await backend.invoke("engine_status");
    status = next.pool || !status.pool ? next : { ...next, pool: status.pool };
    render();
  } catch (error) {
    addLog("warn", `Status check failed: ${error?.message ?? error}`);
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function wire() {
  els.minButton.addEventListener("click", () => backend.minimize?.());
  els.maxButton.addEventListener("click", () => backend.toggleMaximize?.());
  els.closeButton.addEventListener("click", () => backend.close?.());

  els.country.addEventListener("change", render);

  els.rankMode.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-rank]");
    if (!button || button.disabled) return;
    selectedRank = button.dataset.rank;
    for (const b of els.rankMode.querySelectorAll("button")) b.classList.toggle("active", b === button);
    els.rankHelp.textContent = RANK_HELP[selectedRank];
  });

  els.sampleSize.addEventListener("input", () => {
    els.sampleValue.textContent = els.sampleSize.value;
  });

  els.startButton.addEventListener("click", connect);
  els.retryButton.addEventListener("click", connect);
  els.cancelButton.addEventListener("click", () => withAction("Disconnected", async () => {
    status = await backend.invoke("stop_engine");
    render();
  }));
  const disconnect = () => withAction("Disconnected", async () => {
    status = await backend.invoke("stop_engine");
    render();
  });
  els.stopButton.addEventListener("click", disconnect);
  els.errorStopButton.addEventListener("click", disconnect);

  els.openBrowser.addEventListener("click", () =>
    withAction("Opened routed browser", () => backend.invoke("open_browser")));

  els.rotateButton.addEventListener("click", () =>
    withAction("Rotated to the next verified exit", async () => {
      status.pool = await backend.invoke("rotate_exit");
      render();
    }));

  els.refreshButton.addEventListener("click", () => {
    addLog("info", "Refreshing published proxy sources");
    withAction("Fresh exit pool ready", async () => {
      status.pool = await backend.invoke("refresh_exits");
      render();
    });
  });

  // Drawer
  els.drawerHandle.addEventListener("click", () => {
    const open = els.drawer.classList.toggle("open");
    els.drawerHandle.setAttribute("aria-expanded", String(open));
  });
  const selectTab = (tab) => {
    const exits = tab === "exits";
    els.tabExits.classList.toggle("active", exits);
    els.tabActivity.classList.toggle("active", !exits);
    els.exitsPanel.classList.toggle("hidden", !exits);
    els.activityPanel.classList.toggle("hidden", exits);
    els.clearLogs.classList.toggle("hidden", exits);
    if (!els.drawer.classList.contains("open")) {
      els.drawer.classList.add("open");
      els.drawerHandle.setAttribute("aria-expanded", "true");
    }
  };
  els.tabExits.addEventListener("click", () => selectTab("exits"));
  els.tabActivity.addEventListener("click", () => selectTab("activity"));
  els.clearLogs.addEventListener("click", () => {
    logEntries = [];
    els.logs.replaceChildren();
  });
}

/* ------------------------------------------------------------------ *
 * Init
 * ------------------------------------------------------------------ */
async function init() {
  els.version.textContent = `v${__APP_VERSION__}`;
  els.rankHelp.textContent = RANK_HELP[selectedRank];
  wire();
  render();

  await backend.listen("engine-log", ({ payload }) => {
    const level = payload.level || "info";
    const message = payload.message || "";
    addLog(level, message);
    if (status.phase === "starting" && level !== "error") {
      els.pipelineLive.textContent = message;
      advancePipeline(message);
    }
  });
  await backend.listen("engine-state", ({ payload }) => {
    if (payload.phase === "starting" && status.phase !== "starting") resetPipeline();
    status = payload.pool || !status.pool ? payload : { ...payload, pool: status.pool };
    render();
  });
  await backend.listen("pool-updated", ({ payload }) => {
    status.pool = payload;
    render();
  });

  await updateStatus();
  setInterval(updateStatus, 2500);
}

/* ------------------------------------------------------------------ *
 * Mock backend — only used when running outside Tauri (browser preview)
 * ------------------------------------------------------------------ */
function mockBackend() {
  const listeners = new Map();
  const emit = (event, payload) => (listeners.get(event) || []).forEach((cb) => cb({ payload }));
  const state = { phase: "stopped", message: "Ready to connect", proxyPort: 17877, controlPort: 17878, pool: null };
  const ISPS = ["Comcast Cable", "Verizon Fios", "Charter Spectrum", "AT&T Internet", "Cox Communications", "Amazon AWS", "DigitalOcean", "Hetzner"];

  const makePool = (country) => {
    const proxies = Array.from({ length: 8 }, (_, i) => {
      const hosting = i > 4;
      return {
        protocol: ["http", "socks5", "https"][i % 3],
        host: `${45 + i}.${120 + i}.${8 + i}.${(i * 37) % 250}`,
        port: [8080, 3128, 1080, 443][i % 4],
        exitIp: `${23 + i}.${55 + i * 3}.${(i * 29) % 250}.${(i * 51) % 250}`,
        latencyMs: 90 + i * 22,
        throughputMbps: Math.round((72 - i * 7.5) * 10) / 10,
        speedConsistency: Math.round((0.95 - i * 0.06) * 100) / 100,
        consecutiveFailures: 0,
        network: {
          isp: ISPS[i],
          org: ISPS[i],
          kind: hosting ? "hosting-likely" : i % 2 ? "consumer-likely" : "unknown",
        },
      };
    });
    return { country, rankMode: selectedRank, sourceCount: 128, lastRefresh: new Date().toISOString(), refreshing: false, autoFallback: true, current: proxies[0], proxies };
  };

  const script = (country) => {
    const lines = [
      [400, "info", `Testing 40 of 128 published ${country} candidates…`],
      [500, "info", "  1. http://45.120.8.10:8080 -> 23.55.0.51 (180 ms)"],
      [500, "info", "  2. socks5://46.121.9.47:1080 -> 24.58.29.101 (210 ms)"],
      [700, "info", "Measuring sustained throughput on the 24 strongest candidates (steady-state window)…"],
      [600, "info", "  speed 1. http://45.120.8.10:8080 -> 62.4 Mbps"],
      [500, "info", "  speed 2. https://48.123.11.7:443 -> 54.1 Mbps"],
      [700, "info", "Confirming the 12 best candidates across independent HTTPS hosts…"],
      [800, "info", `Selected http://45.120.8.10:8080 (23.55.0.51, 140 ms, 58.2 Mbps); 8 verified exits retained`],
    ];
    let delay = 300;
    for (const [gap, level, message] of lines) {
      delay += gap;
      setTimeout(() => { if (state.phase === "starting") emit("engine-log", { level, message }); }, delay);
    }
    setTimeout(() => {
      if (state.phase !== "starting") return;
      state.pool = makePool(country);
      state.phase = "running";
      state.message = `${country} exit is active`;
      emit("pool-updated", state.pool);
      emit("engine-state", { ...state });
    }, delay + 700);
  };

  const snapshot = () => ({ phase: state.phase, message: state.message, proxyPort: state.proxyPort, controlPort: state.controlPort, pool: state.pool });

  return {
    minimize() {}, toggleMaximize() {}, close() {},
    listen(event, cb) {
      listeners.set(event, [...(listeners.get(event) || []), cb]);
      return Promise.resolve(() => {});
    },
    invoke(cmd, args) {
      if (cmd === "start_engine") {
        const country = args.config.country;
        state.phase = "starting";
        state.message = `Testing published ${country} exits…`;
        state.pool = null;
        emit("engine-state", { ...state });
        script(country);
        return Promise.resolve(snapshot());
      }
      if (cmd === "stop_engine") {
        state.phase = "stopped";
        state.message = "Disconnected";
        state.pool = null;
        emit("engine-state", { ...state });
        return Promise.resolve(snapshot());
      }
      if (cmd === "engine_status") return Promise.resolve(snapshot());
      if (cmd === "rotate_exit") {
        if (state.pool) {
          const p = state.pool.proxies;
          const i = (p.indexOf(state.pool.current) + 1) % p.length;
          state.pool.current = p[i];
          emit("pool-updated", state.pool);
        }
        return Promise.resolve(state.pool);
      }
      if (cmd === "refresh_exits") {
        state.pool = makePool(state.pool?.country || "US");
        emit("pool-updated", state.pool);
        return Promise.resolve(state.pool);
      }
      if (cmd === "open_browser") return Promise.resolve("Opened dedicated browser");
      return Promise.resolve(null);
    },
  };
}

init().catch((error) => {
  addLog("error", `Interface failed to start: ${error?.message ?? error}`);
  showToast(String(error?.message ?? error), "error");
});
