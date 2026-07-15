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
const countryCode = (code) => code?.length === 2 ? code.toUpperCase() : "--";
const countryName = (code) => COUNTRIES[code]?.name ?? code ?? "—";

const RANK_HELP = {
  speed: "Selects the fastest measured route by sustained throughput and latency.",
  balanced: "Balances measured speed, latency, and consumer-ISP likelihood.",
  consumer: "Prefers consumer-ISP-looking exits, even if a little slower.",
};

const RANK_LABEL = {
  speed: "Speed-first",
  balanced: "Balanced",
  consumer: "ISP-first",
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
  "idleRegion", "idleFlag", "regionField", "country", "countryButton", "countryButtonText", "countryPopover", "countryList",
  "startButton", "options", "rankMode", "rankHelp",
  "sampleSize", "sampleValue", "poolSize", "autoFallback",
  "connectingRegion", "pipeline", "pipelineLive", "elapsedTime", "cancelButton",
  "exitFlag", "exitCountry", "liveBadge", "exitIp", "exitIsp", "exitNet",
  "statSpeed", "statLatency", "statConsistency", "verifiedCount", "rankSummary",
  "openBrowser", "openBrowserLabel", "rotateButton", "rotateLabel", "refreshButton", "refreshLabel", "stopButton", "stopLabel",
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
let busyAction = "";
let toastTimer;
let maxStep = -1;
let connectionStartedAt = 0;
let elapsedTimer;
let countryOptionElements = [];
let countryTypeahead = "";
let countryTypeaheadTimer;
const STEPS = ["fetch", "test", "speed", "confirm"];

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
const stateText = { stopped: "Disconnected", starting: "Verifying route…", running: "Connected", error: "Needs attention" };

function updateElapsed() {
  const elapsedSeconds = connectionStartedAt ? Math.max(0, Math.floor((Date.now() - connectionStartedAt) / 1000)) : 0;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  els.elapsedTime.textContent = `${minutes}:${seconds} elapsed`;
}

function syncElapsedTimer(phase) {
  if (phase === "starting") {
    if (!connectionStartedAt) connectionStartedAt = Date.now();
    updateElapsed();
    if (!elapsedTimer) elapsedTimer = setInterval(updateElapsed, 1000);
    return;
  }
  clearInterval(elapsedTimer);
  elapsedTimer = undefined;
  connectionStartedAt = 0;
}

function setButtonBusy(button, busy) {
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

function buildCountryPicker() {
  const fragment = document.createDocumentFragment();
  countryOptionElements = Array.from(els.country.options, (option) => {
    const item = document.createElement("div");
    item.className = "country-option";
    item.id = `countryOption-${option.value}`;
    item.dataset.value = option.value;
    item.dataset.label = option.textContent;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    item.tabIndex = -1;

    const code = document.createElement("span");
    code.className = "country-option-code";
    code.textContent = countryCode(option.value);

    const name = document.createElement("span");
    name.className = "country-option-name";
    name.textContent = option.textContent;

    const check = document.createElement("span");
    check.className = "country-option-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";

    item.append(code, name, check);
    fragment.append(item);
    return item;
  });
  els.countryList.replaceChildren(fragment);
}

function countryPopoverIsOpen() {
  return els.countryPopover.matches(":popover-open");
}

function syncCountryPicker() {
  const selected = els.country.value;
  els.countryButtonText.textContent = countryName(selected);
  for (const item of countryOptionElements) {
    const active = item.dataset.value === selected;
    item.setAttribute("aria-selected", String(active));
  }
}

function focusCountryOption(index) {
  const nextIndex = Math.max(0, Math.min(countryOptionElements.length - 1, index));
  for (const item of countryOptionElements) item.tabIndex = -1;
  const option = countryOptionElements[nextIndex];
  if (!option) return;
  option.tabIndex = 0;
  option.focus({ preventScroll: true });
  option.scrollIntoView({ block: "nearest" });
}

function positionCountryPopover() {
  if (!countryPopoverIsOpen()) return;
  const anchor = els.regionField.getBoundingClientRect();
  const viewportPadding = 12;
  const gap = 8;
  const menuMaxHeight = 400;
  const width = Math.min(anchor.width, window.innerWidth - viewportPadding * 2);
  const left = Math.max(viewportPadding, Math.min(anchor.left, window.innerWidth - viewportPadding - width));

  els.countryPopover.style.width = `${width}px`;
  els.countryPopover.style.maxHeight = `${menuMaxHeight}px`;

  const naturalHeight = Math.min(els.countryList.scrollHeight + 14, menuMaxHeight);
  const roomAbove = anchor.top - viewportPadding - gap;
  const roomBelow = window.innerHeight - anchor.bottom - viewportPadding - gap;
  const placeBelow = roomBelow >= Math.min(naturalHeight, 240) || roomBelow >= roomAbove;
  const availableHeight = Math.max(96, placeBelow ? roomBelow : roomAbove);
  const height = Math.min(naturalHeight, availableHeight);
  const top = placeBelow ? anchor.bottom + gap : Math.max(viewportPadding, anchor.top - gap - height);

  els.countryPopover.dataset.side = placeBelow ? "below" : "above";
  els.countryPopover.style.left = `${left}px`;
  els.countryPopover.style.top = `${top}px`;
  els.countryPopover.style.maxHeight = `${height}px`;
}

function chooseCountry(value) {
  if (els.country.disabled) return;
  if (els.country.value !== value) {
    els.country.value = value;
    els.country.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (countryPopoverIsOpen()) els.countryPopover.hidePopover();
  els.countryButton.focus({ preventScroll: true });
}

function handleCountryTypeahead(event) {
  if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return false;
  clearTimeout(countryTypeaheadTimer);
  countryTypeahead += event.key.toLocaleLowerCase();
  countryTypeaheadTimer = setTimeout(() => { countryTypeahead = ""; }, 600);

  const activeIndex = Math.max(0, countryOptionElements.indexOf(document.activeElement));
  const ordered = [...countryOptionElements.slice(activeIndex + 1), ...countryOptionElements.slice(0, activeIndex + 1)];
  let match = ordered.find((item) => item.dataset.label.toLocaleLowerCase().startsWith(countryTypeahead));
  if (!match && countryTypeahead.length > 1) {
    countryTypeahead = event.key.toLocaleLowerCase();
    match = ordered.find((item) => item.dataset.label.toLocaleLowerCase().startsWith(countryTypeahead));
  }
  if (match) focusCountryOption(countryOptionElements.indexOf(match));
  return true;
}

function render() {
  const phase = status.phase ?? "stopped";
  const pool = status.pool;
  const current = pool?.current;
  document.body.dataset.phase = phase;
  els.tbStateText.textContent = stateText[phase] ?? phase;
  syncElapsedTimer(phase);

  // Idle region echo
  const code = els.country.value;
  els.idleRegion.textContent = COUNTRIES[code]?.the ?? countryName(code);
  els.idleFlag.textContent = countryCode(code);
  els.connectingRegion.textContent = code;
  syncCountryPicker();

  // Lock config while running/starting
  const locked = phase === "running" || phase === "starting";
  els.country.disabled = locked;
  els.countryButton.disabled = locked;
  if (locked && countryPopoverIsOpen()) els.countryPopover.hidePopover();
  els.sampleSize.disabled = locked;
  els.poolSize.disabled = locked;
  els.autoFallback.disabled = locked;
  for (const b of els.rankMode.querySelectorAll("button")) b.disabled = locked;
  els.startButton.disabled = actionBusy;
  els.cancelButton.disabled = actionBusy;
  els.retryButton.disabled = actionBusy;
  els.errorStopButton.disabled = actionBusy;
  els.stopButton.disabled = actionBusy;

  if (phase === "error") {
    els.errorMessage.textContent = status.message || "The engine stopped unexpectedly.";
  }

  if (current) {
    const unhealthy = pool.autoFallback === false && (current.consecutiveFailures || 0) >= 3;
    els.exitFlag.textContent = countryCode(pool.country);
    els.exitCountry.textContent = countryName(pool.country);
    els.liveBadge.classList.toggle("warn", unhealthy);
    els.liveBadge.lastElementChild.textContent = unhealthy ? "Unstable" : "Live";
    els.exitIp.textContent = current.exitIp || "—";
    els.exitIsp.textContent = current.network?.isp || current.network?.org || "Unknown network";
    const kind = current.network?.kind ?? "unknown";
    els.exitNet.textContent = NETWORK_LABEL[kind] ?? NETWORK_LABEL.unknown;
    els.exitNet.className = `exit-net ${kind}`;
    els.statSpeed.textContent = current.throughputMbps != null ? `${current.throughputMbps} Mbps` : "—";
    els.statLatency.textContent = current.latencyMs != null ? `${current.latencyMs} ms` : "—";
    setConsistency(current.speedConsistency);
    els.verifiedCount.textContent = String(pool.proxies?.length ?? 0);
    els.rankSummary.textContent = `${RANK_LABEL[pool.rankMode] ?? "Balanced"} ranking`;
  }

  const canAct = phase === "running" && !actionBusy;
  els.openBrowser.disabled = !canAct;
  els.rotateButton.disabled = !canAct;
  els.refreshButton.disabled = !canAct;
  els.openBrowserLabel.textContent = busyAction === "browser" ? "Opening browser…" : "Open routed browser";
  els.rotateLabel.textContent = busyAction === "rotate" ? "Rotating…" : "Rotate exit";
  els.refreshLabel.textContent = busyAction === "refresh" ? "Refreshing…" : "Refresh pool";
  els.stopLabel.textContent = busyAction === "disconnect" ? "Disconnecting…" : "Disconnect";
  setButtonBusy(els.openBrowser, busyAction === "browser");
  setButtonBusy(els.rotateButton, busyAction === "rotate");
  setButtonBusy(els.refreshButton, busyAction === "refresh");
  setButtonBusy(els.stopButton, busyAction === "disconnect");

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
    const title = document.createElement("strong");
    const description = document.createElement("span");
    if (status.phase === "starting") {
      title.textContent = "Verification in progress";
      description.textContent = "Measured exits will appear here as checks complete.";
    } else {
      title.textContent = "No verified exits yet";
      description.textContent = "Connect to build a measured fallback pool.";
    }
    empty.append(title, description);
    els.poolList.append(empty);
    return;
  }

  for (const proxy of proxies) {
    const active = current && proxy.protocol === current.protocol && proxy.host === current.host && proxy.port === current.port;
    const row = document.createElement("div");
    row.className = `pool-row${active ? " active" : ""}`;

    const state = document.createElement("span");
    state.className = "pool-status";
    state.textContent = active ? "LIVE" : "READY";

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
    mbps.textContent = proxy.throughputMbps != null ? `${proxy.throughputMbps} Mbps` : "—";
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

function friendlyProgressMessage(message) {
  const normalized = message.replace(/\s+/g, " ").trim();
  const speed = normalized.match(/->\s*([\d.]+\s*Mbps)/i)?.[1];
  if (/^speed\s+\d+\./i.test(normalized)) {
    return speed ? `A leading route sustained ${speed}.` : "A leading route passed sustained-speed testing.";
  }
  if (/^\d+\./.test(normalized) && /(?:https?|socks)/i.test(normalized)) {
    return "A candidate passed the reachability and exit-location checks.";
  }
  if (/^selected\s/i.test(normalized)) return "Route verified. Preparing the secure browser profile…";
  return normalized;
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
async function withAction(action, successMessage, fn) {
  if (actionBusy) return;
  actionBusy = true;
  busyAction = action;
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
    busyAction = "";
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
  await withAction("connect", null, async () => {
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

function wireCountryPicker() {
  els.countryButton.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!countryPopoverIsOpen()) els.countryPopover.showPopover();
    else focusCountryOption(countryOptionElements.findIndex((item) => item.dataset.value === els.country.value));
  });

  els.countryPopover.addEventListener("toggle", () => {
    const open = countryPopoverIsOpen();
    els.countryButton.setAttribute("aria-expanded", String(open));
    if (!open) {
      countryTypeahead = "";
      for (const item of countryOptionElements) item.tabIndex = -1;
      return;
    }
    positionCountryPopover();
    requestAnimationFrame(() => {
      const selectedIndex = countryOptionElements.findIndex((item) => item.dataset.value === els.country.value);
      focusCountryOption(selectedIndex);
    });
  });

  els.countryList.addEventListener("click", (event) => {
    const option = event.target.closest(".country-option");
    if (option) chooseCountry(option.dataset.value);
  });

  els.countryList.addEventListener("keydown", (event) => {
    const activeIndex = Math.max(0, countryOptionElements.indexOf(document.activeElement));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      focusCountryOption((activeIndex + direction + countryOptionElements.length) % countryOptionElements.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusCountryOption(event.key === "Home" ? 0 : countryOptionElements.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseCountry(countryOptionElements[activeIndex].dataset.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      els.countryPopover.hidePopover();
      els.countryButton.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      els.countryPopover.hidePopover();
      (event.shiftKey ? els.countryButton : els.startButton).focus({ preventScroll: true });
      return;
    }
    if (handleCountryTypeahead(event)) event.preventDefault();
  });

  window.addEventListener("resize", positionCountryPopover);
  document.querySelector(".hero").addEventListener("scroll", positionCountryPopover, { passive: true });
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function wire() {
  els.minButton.addEventListener("click", () => backend.minimize?.());
  els.maxButton.addEventListener("click", () => backend.toggleMaximize?.());
  els.closeButton.addEventListener("click", () => backend.close?.());

  els.country.addEventListener("change", render);
  wireCountryPicker();

  els.rankMode.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-rank]");
    if (!button || button.disabled) return;
    selectedRank = button.dataset.rank;
    for (const b of els.rankMode.querySelectorAll("button")) {
      const active = b === button;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    }
    els.rankHelp.textContent = RANK_HELP[selectedRank];
  });

  els.sampleSize.addEventListener("input", () => {
    els.sampleValue.textContent = els.sampleSize.value;
  });

  els.options.addEventListener("toggle", () => {
    if (!els.options.open) return;
    requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      els.options.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
    });
  });

  els.startButton.addEventListener("click", connect);
  els.retryButton.addEventListener("click", connect);
  els.cancelButton.addEventListener("click", () => withAction("disconnect", "Disconnected", async () => {
    status = await backend.invoke("stop_engine");
    render();
  }));
  const disconnect = () => withAction("disconnect", "Disconnected", async () => {
    status = await backend.invoke("stop_engine");
    render();
  });
  els.stopButton.addEventListener("click", disconnect);
  els.errorStopButton.addEventListener("click", disconnect);

  els.openBrowser.addEventListener("click", () =>
    withAction("browser", "Opened routed browser", () => backend.invoke("open_browser")));

  els.rotateButton.addEventListener("click", () =>
    withAction("rotate", "Rotated to the next verified exit", async () => {
      status.pool = await backend.invoke("rotate_exit");
      render();
    }));

  els.refreshButton.addEventListener("click", () => {
    addLog("info", "Refreshing published proxy sources");
    withAction("refresh", "Fresh exit pool ready", async () => {
      status.pool = await backend.invoke("refresh_exits");
      render();
    });
  });

  // Drawer
  els.drawerHandle.addEventListener("click", () => {
    const open = els.drawer.classList.toggle("open");
    els.drawerHandle.setAttribute("aria-expanded", String(open));
    els.drawerBody.setAttribute("aria-hidden", String(!open));
  });
  const selectTab = (tab) => {
    const exits = tab === "exits";
    els.tabExits.classList.toggle("active", exits);
    els.tabActivity.classList.toggle("active", !exits);
    els.exitsPanel.classList.toggle("hidden", !exits);
    els.activityPanel.classList.toggle("hidden", exits);
    els.exitsPanel.hidden = !exits;
    els.activityPanel.hidden = exits;
    els.tabExits.setAttribute("aria-selected", String(exits));
    els.tabActivity.setAttribute("aria-selected", String(!exits));
    els.tabExits.tabIndex = exits ? 0 : -1;
    els.tabActivity.tabIndex = exits ? -1 : 0;
    els.clearLogs.classList.toggle("hidden", exits);
    if (!els.drawer.classList.contains("open")) {
      els.drawer.classList.add("open");
      els.drawerHandle.setAttribute("aria-expanded", "true");
      els.drawerBody.setAttribute("aria-hidden", "false");
    }
  };
  els.tabExits.addEventListener("click", () => selectTab("exits"));
  els.tabActivity.addEventListener("click", () => selectTab("activity"));
  for (const tab of [els.tabExits, els.tabActivity]) {
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = tab === els.tabExits ? els.tabActivity : els.tabExits;
      selectTab(next === els.tabExits ? "exits" : "activity");
      next.focus();
    });
  }
  els.clearLogs.addEventListener("click", () => {
    logEntries = [];
    els.logs.replaceChildren();
    const row = document.createElement("div");
    row.className = "log dim";
    const time = document.createElement("span");
    time.textContent = "—";
    const message = document.createElement("p");
    message.textContent = "Activity cleared.";
    row.append(time, message);
    els.logs.append(row);
  });
}

/* ------------------------------------------------------------------ *
 * Init
 * ------------------------------------------------------------------ */
async function init() {
  els.version.textContent = `v${__APP_VERSION__}`;
  els.rankHelp.textContent = RANK_HELP[selectedRank];
  buildCountryPicker();
  wire();
  render();

  await backend.listen("engine-log", ({ payload }) => {
    const level = payload.level || "info";
    const message = payload.message || "";
    addLog(level, message);
    if (status.phase === "starting" && level !== "error") {
      els.pipelineLive.textContent = friendlyProgressMessage(message);
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
  setInterval(updateStatus, 5000);
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
