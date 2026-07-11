import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

const elements = Object.fromEntries(
  [
    "phaseChip", "phaseText", "country", "rankMode", "rankHelp", "sampleSize", "sampleValue",
    "poolSize", "autoFallback", "startButton", "stopButton", "statusLabel", "countryBadge", "idleState",
    "activeState", "exitIp", "networkKind", "ispName", "proxyEndpoint", "latency", "bandwidth",
    "fallbackCount", "openBrowser", "rotateButton", "refreshButton", "poolCount", "poolList",
    "logs", "clearLogs", "toast", "navPoolCount", "compactPhase", "minButton", "maxButton",
    "closeButton", "connectionPanel", "poolPanel", "activityPanel",
  ].map((id) => [id, document.getElementById(id)]),
);

const rankDescriptions = {
  speed: "Measures real transfer throughput and connection latency, then selects the fastest route.",
  balanced: "Balances measured throughput, latency, and consumer-ISP likelihood.",
  consumer: "Prioritizes consumer-ISP-looking exits, even when they are slower.",
};

let status = { phase: "stopped", message: "Ready to find an exit", pool: null };
let selectedRank = "balanced";
let logs = [];
let actionBusy = false;
let toastTimer;

function flagEmoji(code) {
  if (!code || code.length !== 2) return "◎";
  return [...code.toUpperCase()].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt())).join("");
}

function phaseLabel(phase) {
  return { stopped: "Stopped", starting: "Discovering", running: "Connected", error: "Needs attention" }[phase] ?? phase;
}

function friendlyNetwork(kind) {
  return { "consumer-likely": "Consumer ISP likely", "hosting-likely": "Hosting network", unknown: "Unclassified network" }[kind] ?? "Unclassified network";
}

function showToast(message, tone = "normal") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast visible ${tone}`;
  toastTimer = setTimeout(() => (elements.toast.className = "toast"), 3600);
}

function addLog(level, message) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  logs.push({ time, level, message });
  logs = logs.slice(-120);
  elements.logs.replaceChildren(
    ...logs.map((entry) => {
      const row = document.createElement("div");
      row.className = `log-line ${entry.level}`;
      const timestamp = document.createElement("span");
      timestamp.textContent = entry.time;
      const text = document.createElement("div");
      text.textContent = entry.message;
      row.append(timestamp, text);
      return row;
    }),
  );
  elements.logs.scrollTop = elements.logs.scrollHeight;
}

function renderPool(pool) {
  const proxies = pool?.proxies ?? [];
  const current = pool?.current;
  elements.poolCount.textContent = `${proxies.length} ${proxies.length === 1 ? "exit" : "exits"}`;
  elements.navPoolCount.textContent = String(proxies.length);
  elements.poolList.replaceChildren();
  if (!proxies.length) {
    const empty = document.createElement("div");
    empty.className = "empty-row";
    empty.textContent = status.phase === "starting" ? "Testing candidates…" : "No verified exits yet.";
    elements.poolList.append(empty);
    return;
  }

  for (const proxy of proxies) {
    const row = document.createElement("div");
    const active = current && proxy.protocol === current.protocol && proxy.host === current.host && proxy.port === current.port;
    row.className = `pool-row${active ? " active" : ""}`;

    const marker = document.createElement("span");
    marker.className = "pool-marker";
    marker.textContent = active ? "●" : "○";
    const address = document.createElement("div");
    address.className = "pool-address";
    const ip = document.createElement("strong");
    ip.textContent = proxy.exitIp;
    const isp = document.createElement("span");
    isp.textContent = proxy.network?.isp || friendlyNetwork(proxy.network?.kind);
    address.append(ip, isp);
    const latency = document.createElement("div");
    latency.className = "pool-latency";
    latency.textContent = proxy.throughputMbps ? `${proxy.throughputMbps} Mbps` : `${proxy.latencyMs} ms`;
    row.append(marker, address, latency);
    elements.poolList.append(row);
  }
}

function render() {
  const phase = status.phase ?? "stopped";
  const pool = status.pool;
  const current = pool?.current;
  const running = phase === "running";
  const starting = phase === "starting";

  elements.phaseChip.className = `phase-chip ${phase}`;
  elements.phaseText.textContent = phaseLabel(phase);
  elements.compactPhase.className = `compact-phase ${phase}`;
  elements.compactPhase.querySelector("b").textContent = phaseLabel(phase);
  elements.statusLabel.textContent = status.message || phaseLabel(phase);

  elements.startButton.classList.toggle("hidden", running || starting);
  elements.stopButton.classList.toggle("hidden", phase === "stopped");
  elements.startButton.disabled = actionBusy;
  elements.stopButton.disabled = actionBusy;
  for (const control of [elements.country, elements.sampleSize, elements.poolSize, elements.autoFallback]) control.disabled = running || starting;
  for (const button of elements.rankMode.querySelectorAll("button")) button.disabled = running || starting;

  elements.idleState.classList.toggle("hidden", Boolean(current));
  elements.activeState.classList.toggle("hidden", !current);
  if (current) {
    const unhealthyStrictExit = pool.autoFallback === false && (current.consecutiveFailures || 0) >= 3;
    if (unhealthyStrictExit) elements.statusLabel.textContent = "Exit unhealthy — rotate IP manually";
    elements.countryBadge.className = "country-badge";
    elements.countryBadge.textContent = unhealthyStrictExit ? "Action required" : `${flagEmoji(pool.country)} ${pool.country}`;
    if (unhealthyStrictExit) elements.countryBadge.classList.add("warning-badge");
    elements.exitIp.textContent = current.exitIp || "—";
    elements.networkKind.textContent = friendlyNetwork(current.network?.kind);
    elements.networkKind.className = `network-pill ${current.network?.kind ?? "unknown"}`;
    elements.ispName.textContent = current.network?.isp || current.network?.org || "Unknown ISP";
    elements.proxyEndpoint.textContent = `${current.protocol}://${current.host}:${current.port}`;
    elements.latency.textContent = `${current.latencyMs} ms`;
    elements.bandwidth.textContent = current.throughputMbps ? `${current.throughputMbps} Mbps` : "Not measured";
    elements.fallbackCount.textContent = pool.autoFallback === false ? "Manual" : String(pool.proxies?.length ?? 0);
  } else {
    elements.countryBadge.className = "country-badge muted-badge";
    elements.countryBadge.textContent = starting ? `${flagEmoji(elements.country.value)} ${elements.country.value}` : "—";
  }

  for (const button of [elements.openBrowser, elements.rotateButton, elements.refreshButton]) {
    button.disabled = !running || actionBusy;
  }
  renderPool(pool);
}

async function updateStatus() {
  try {
    const next = await invoke("engine_status");
    status = next.pool || !status.pool ? next : { ...next, pool: status.pool };
    render();
  } catch (error) {
    addLog("warn", `Status check failed: ${error}`);
  }
}

async function withAction(label, action) {
  if (actionBusy) return;
  actionBusy = true;
  render();
  try {
    const result = await action();
    if (label) showToast(label);
    return result;
  } catch (error) {
    showToast(String(error), "error");
    addLog("error", String(error));
    throw error;
  } finally {
    actionBusy = false;
    await updateStatus();
  }
}

elements.rankMode.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-rank]");
  if (!button || button.disabled) return;
  selectedRank = button.dataset.rank;
  for (const item of elements.rankMode.querySelectorAll("button")) item.classList.toggle("active", item === button);
  elements.rankHelp.textContent = rankDescriptions[selectedRank];
});

elements.sampleSize.addEventListener("input", () => {
  elements.sampleValue.textContent = elements.sampleSize.value;
});

for (const navItem of document.querySelectorAll(".nav-item[data-view]")) {
  navItem.addEventListener("click", () => {
    const view = navItem.dataset.view;
    for (const item of document.querySelectorAll(".nav-item[data-view]")) item.classList.toggle("active", item === navItem);
    for (const panel of document.querySelectorAll(".panel")) panel.classList.toggle("spotlight", panel.dataset.panel === view);
  });
}

async function syncMaximizeIcon() {
  const maximized = await appWindow.isMaximized();
  elements.maxButton.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
  elements.maxButton.innerHTML = maximized
    ? '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 3.5V2.5h5.5V8H8.5M2.5 4h5.5v5.5H2.5Z" /></svg>'
    : '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx=".5" /></svg>';
}

elements.minButton.addEventListener("click", () => appWindow.minimize());
elements.maxButton.addEventListener("click", async () => {
  await appWindow.toggleMaximize();
  await syncMaximizeIcon();
});
elements.closeButton.addEventListener("click", () => appWindow.close());
document.querySelector(".titlebar").addEventListener("dblclick", async (event) => {
  if (event.target.closest(".window-controls")) return;
  await appWindow.toggleMaximize();
  await syncMaximizeIcon();
});

elements.startButton.addEventListener("click", () =>
  withAction("Discovery started", async () => {
    logs = [];
    addLog("info", `Starting ${elements.country.value} discovery in ${selectedRank} mode`);
    status = await invoke("start_engine", {
      config: {
        country: elements.country.value,
        rankMode: selectedRank,
        maxCandidates: Number(elements.sampleSize.value),
        poolSize: Number(elements.poolSize.value),
        autoFallback: elements.autoFallback.checked,
      },
    });
    render();
  }).catch(() => {}),
);

elements.stopButton.addEventListener("click", () =>
  withAction("Proxy stopped", async () => {
    status = await invoke("stop_engine");
    render();
  }).catch(() => {}),
);

elements.openBrowser.addEventListener("click", () =>
  withAction("Dedicated browser opened", () => invoke("open_browser")).catch(() => {}),
);

elements.rotateButton.addEventListener("click", () =>
  withAction("Rotated to the next verified exit", async () => {
    status.pool = await invoke("rotate_exit");
    render();
  }).catch(() => {}),
);

elements.refreshButton.addEventListener("click", () =>
  withAction("Fresh exit pool is ready", async () => {
    addLog("info", "Refreshing published proxy sources");
    status.pool = await invoke("refresh_exits");
    render();
  }).catch(() => {}),
);

elements.clearLogs.addEventListener("click", () => {
  logs = [];
  elements.logs.replaceChildren();
});

async function initialize() {
  await syncMaximizeIcon();
  await appWindow.onResized(syncMaximizeIcon);
  await listen("engine-log", ({ payload }) => addLog(payload.level || "info", payload.message));
  await listen("engine-state", ({ payload }) => {
    status = payload.pool || !status.pool ? payload : { ...payload, pool: status.pool };
    render();
  });
  await listen("pool-updated", ({ payload }) => {
    status.pool = payload;
    render();
  });

  render();
  await updateStatus();
  setInterval(updateStatus, 2500);
}

initialize().catch((error) => {
  addLog("error", `Desktop initialization failed: ${error}`);
  showToast(String(error), "error");
});
