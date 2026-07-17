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
  "startButton", "options", "rankMode", "rankHelp", "rankInfoButton", "rankInfoTooltip",
  "sampleSize", "sampleValue", "poolSize", "poolSizeButton", "poolSizeButtonText", "poolSizePopover", "poolSizeList", "autoFallback",
  "socksEnabled", "socksInfo", "socksAddress", "socksInfoButton", "socksInfoTooltip",
  "connectingRegion", "pipeline", "pipelineLive", "elapsedTime", "cancelButton",
  "exitFlag", "exitCountry", "liveBadge", "lastVerified", "exitIp", "exitIsp", "exitNet",
  "statSpeed", "statLatency", "statConsistency", "verifiedCount", "rankSummary",
  "openBrowser", "openBrowserLabel", "rotateButton", "rotateLabel", "refreshButton", "refreshLabel", "stopButton", "stopLabel",
  "errorMessage", "retryButton", "errorStopButton",
  "drawer", "drawerHandle", "drawerBody", "tabExits", "tabBlocked", "tabActivity", "clearLogs",
  "exitsPanel", "blockedPanel", "activityPanel", "sourceHealth", "sourceHealthSummary", "sourceHealthInfoButton", "sourceHealthTooltip", "sourceHealthDetails", "poolList", "blockedList", "logs",
  "exitsCount", "blockedCount", "version", "toast",
  "updateBanner", "updateBannerText", "updateDownload", "updateDismiss",
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
let lastVerifiedTimer;
let countryPicker;
let poolSizePicker;
let lastToastedDiscoveryError = null;
const STEPS = ["fetch", "probe", "speed", "confirm"];
// Engine progress stages map onto the four visible pipeline steps ("commit" is
// the brief final-selection step and shares the "confirm" dot).
const STAGE_TO_STEP = { fetch: 0, probe: 1, speed: 2, confirm: 3, commit: 3 };
const PREFS_KEY = "meshhop.prefs.v1";
const BLOCKLIST_KEY = "meshhop.blocklist.v1";
const UPDATE_DISMISS_KEY = "meshhop.update.dismissed";
let pendingUpdate = null;

function loadBlocklist() {
  try {
    const raw = localStorage.getItem(BLOCKLIST_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? [...new Set(list.map((ip) => String(ip || "").trim().toLowerCase()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

function saveBlocklist(ips) {
  try {
    localStorage.setItem(BLOCKLIST_KEY, JSON.stringify([...new Set(ips)]));
  } catch {
    // ignore
  }
}

function maybeToastDiscoveryError(pool) {
  const error = pool?.lastDiscoveryError;
  if (!error || pool?.current) return;
  if (error === lastToastedDiscoveryError) return;
  lastToastedDiscoveryError = error;
  showToast(error, "error");
}

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

// Heartbeat-driven "last verified" caption on the connected card. reportSuccess()
// stamps proxy.lastUsed on both real browser traffic AND a passing heartbeat
// probe, so it doubles as "the engine actually re-checked this exit at time X".
function formatAgo(isoString) {
  const at = isoString ? new Date(isoString).getTime() : NaN;
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function updateLastVerified() {
  const current = status.pool?.current;
  const at = current?.lastUsed || current?.checkedAt;
  const ago = at ? formatAgo(at) : null;
  els.lastVerified.textContent = ago ? `verified ${ago}` : "not yet re-verified";
}

function syncLastVerifiedTimer(phase) {
  if (phase === "running") {
    updateLastVerified();
    if (!lastVerifiedTimer) lastVerifiedTimer = setInterval(updateLastVerified, 1000);
    return;
  }
  clearInterval(lastVerifiedTimer);
  lastVerifiedTimer = undefined;
}

function setButtonBusy(button, busy) {
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

/* ------------------------------------------------------------------ *
 * Generic themed listbox picker
 *
 * Drives a hidden native <select> from a button trigger + popover listbox,
 * so the exit-region and fallback-pool-size fields share one implementation
 * (positioning, keyboard nav, typeahead) instead of two copies of the same
 * dropdown logic.
 * ------------------------------------------------------------------ */
function createListboxPicker({
  nativeSelect,
  trigger,
  popover,
  list,
  buildOption,
  onSync,
  topInset = 12,
  estimatedRowHeight = 40,
  tabForward,
  tabBack,
}) {
  let optionElements = [];
  let typeahead = "";
  let typeaheadTimer;

  function build() {
    const fragment = document.createDocumentFragment();
    optionElements = Array.from(nativeSelect.options, (option) => {
      const item = document.createElement("div");
      item.className = "select-option";
      item.dataset.value = option.value;
      item.dataset.label = option.textContent;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.tabIndex = -1;
      buildOption(item, option);
      fragment.append(item);
      return item;
    });
    list.replaceChildren(fragment);
  }

  function isOpen() {
    return popover.matches(":popover-open");
  }

  function sync() {
    const selected = nativeSelect.value;
    for (const item of optionElements) item.setAttribute("aria-selected", String(item.dataset.value === selected));
    onSync?.(selected);
  }

  function focusOption(index) {
    const nextIndex = Math.max(0, Math.min(optionElements.length - 1, index));
    for (const item of optionElements) item.tabIndex = -1;
    const option = optionElements[nextIndex];
    if (!option) return;
    option.tabIndex = 0;
    option.focus({ preventScroll: true });
    option.scrollIntoView({ block: "nearest" });
  }

  function position() {
    const anchor = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 8;
    const menuMaxHeight = 420;
    const width = Math.min(anchor.width, window.innerWidth - viewportPadding * 2);
    const left = Math.max(viewportPadding, Math.min(anchor.left, window.innerWidth - viewportPadding - width));
    popover.style.width = `${width}px`;

    // Before the popover is shown it is display:none, so scrollHeight reads 0 —
    // fall back to a per-row estimate so the first frame lands in the right
    // place and the entrance animation knows which way to open.
    const measured = list.scrollHeight || optionElements.length * estimatedRowHeight;
    const naturalHeight = Math.min(measured + 14, menuMaxHeight);
    const roomAbove = anchor.top - topInset - gap;
    const roomBelow = window.innerHeight - anchor.bottom - viewportPadding - gap;

    // Open where the whole list fits without scrolling; only scroll as a last resort.
    const placeBelow = roomBelow >= naturalHeight ? true : roomAbove >= naturalHeight ? false : roomBelow >= roomAbove;
    const availableHeight = Math.max(120, placeBelow ? roomBelow : roomAbove);
    const height = Math.min(naturalHeight, availableHeight);
    const top = placeBelow ? anchor.bottom + gap : Math.max(topInset, anchor.top - gap - height);

    popover.dataset.side = placeBelow ? "below" : "above";
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.style.maxHeight = `${height}px`;
  }

  function choose(value) {
    if (nativeSelect.disabled) return;
    if (nativeSelect.value !== value) {
      nativeSelect.value = value;
      nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (isOpen()) popover.hidePopover();
    trigger.focus({ preventScroll: true });
  }

  function handleTypeahead(event) {
    if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return false;
    clearTimeout(typeaheadTimer);
    typeahead += event.key.toLocaleLowerCase();
    typeaheadTimer = setTimeout(() => { typeahead = ""; }, 600);

    const activeIndex = Math.max(0, optionElements.indexOf(document.activeElement));
    const ordered = [...optionElements.slice(activeIndex + 1), ...optionElements.slice(0, activeIndex + 1)];
    let match = ordered.find((item) => item.dataset.label.toLocaleLowerCase().startsWith(typeahead));
    if (!match && typeahead.length > 1) {
      typeahead = event.key.toLocaleLowerCase();
      match = ordered.find((item) => item.dataset.label.toLocaleLowerCase().startsWith(typeahead));
    }
    if (match) focusOption(optionElements.indexOf(match));
    return true;
  }

  function setDisabled(disabled) {
    trigger.disabled = disabled;
    if (disabled && isOpen()) popover.hidePopover();
  }

  function wire() {
    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      if (!isOpen()) popover.showPopover();
      else focusOption(optionElements.findIndex((item) => item.dataset.value === nativeSelect.value));
    });

    // Place it before it paints so it opens in the right spot and direction —
    // no flash, and the entrance animation matches the chosen side.
    popover.addEventListener("beforetoggle", (event) => {
      if (event.newState === "open") position();
    });

    popover.addEventListener("toggle", () => {
      const open = isOpen();
      trigger.setAttribute("aria-expanded", String(open));
      if (!open) {
        typeahead = "";
        for (const item of optionElements) item.tabIndex = -1;
        return;
      }
      position();
      requestAnimationFrame(() => {
        const selectedIndex = optionElements.findIndex((item) => item.dataset.value === nativeSelect.value);
        focusOption(selectedIndex);
      });
    });

    list.addEventListener("click", (event) => {
      const option = event.target.closest(".select-option");
      if (option) choose(option.dataset.value);
    });

    list.addEventListener("keydown", (event) => {
      const activeIndex = Math.max(0, optionElements.indexOf(document.activeElement));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        focusOption((activeIndex + direction + optionElements.length) % optionElements.length);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        focusOption(event.key === "Home" ? 0 : optionElements.length - 1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose(optionElements[activeIndex].dataset.value);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        popover.hidePopover();
        trigger.focus({ preventScroll: true });
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        popover.hidePopover();
        const target = (event.shiftKey ? tabBack : tabForward) ?? trigger;
        target.focus({ preventScroll: true });
        return;
      }
      if (handleTypeahead(event)) event.preventDefault();
    });

    const repositionIfOpen = () => { if (isOpen()) position(); };
    window.addEventListener("resize", repositionIfOpen);
    document.querySelector(".hero").addEventListener("scroll", repositionIfOpen, { passive: true });
  }

  build();
  return { sync, setDisabled, wire, isOpen };
}

function render() {
  const phase = status.phase ?? "stopped";
  const pool = status.pool;
  const current = pool?.current;
  document.body.dataset.phase = phase;
  els.tbStateText.textContent = stateText[phase] ?? phase;
  syncElapsedTimer(phase);
  syncLastVerifiedTimer(phase);

  // Idle region echo
  const code = els.country.value;
  els.idleRegion.textContent = COUNTRIES[code]?.the ?? countryName(code);
  els.idleFlag.textContent = countryCode(code);
  els.connectingRegion.textContent = code;
  countryPicker.sync();
  poolSizePicker.sync();

  // Lock config while running/starting
  const locked = phase === "running" || phase === "starting";
  els.country.disabled = locked;
  countryPicker.setDisabled(locked);
  els.sampleSize.disabled = locked;
  els.poolSize.disabled = locked;
  poolSizePicker.setDisabled(locked);
  els.autoFallback.disabled = locked;
  els.socksEnabled.disabled = locked;
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
    const failures = current.consecutiveFailures || 0;
    const unhealthy = failures >= 2 || (pool.autoFallback === false && failures >= 1);
    els.exitFlag.textContent = countryCode(pool.country);
    els.exitCountry.textContent = countryName(pool.country);
    els.liveBadge.classList.toggle("warn", unhealthy);
    els.liveBadge.lastElementChild.textContent = unhealthy ? "Unstable" : "Live";
    els.exitIp.textContent = current.exitIp || "—";
    els.exitIp.title = "Click to copy exit IP";
    els.exitIsp.textContent = current.network?.isp || current.network?.org || "Unknown network";
    const kind = current.network?.kind ?? "unknown";
    els.exitNet.textContent = NETWORK_LABEL[kind] ?? NETWORK_LABEL.unknown;
    els.exitNet.className = `exit-net ${kind}`;
    els.statSpeed.textContent = current.throughputMbps != null ? `${current.throughputMbps} Mbps` : "—";
    els.statLatency.textContent = current.latencyMs != null ? `${current.latencyMs} ms` : "—";
    setConsistency(current.speedConsistency);
    els.verifiedCount.textContent = String(pool.proxies?.length ?? 0);
    els.rankSummary.textContent = `${RANK_LABEL[pool.rankMode] ?? "Balanced"} ranking`;
  } else if (phase === "running" && pool?.lastDiscoveryError) {
    // Running with an empty pool after a failed discovery — surface the reason.
    els.verifiedCount.textContent = "0";
    els.rankSummary.textContent = pool.lastFailureSummary || "No verified exits";
  }

  if (phase === "running" && status.socksPort) {
    els.socksAddress.textContent = `socks5://127.0.0.1:${status.socksPort}`;
    els.socksInfo.classList.remove("hidden");
  } else {
    els.socksInfo.classList.add("hidden");
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

  renderSourceHealth(pool);
  renderPool(pool);
  renderBlocklist();
}

function sourceLabel(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host.includes("proxifly")) return "Proxifly";
    if (host.includes("iplocate")) return "IPLocate";
    if (host.includes("proxyscrape")) {
      const protocol = parsed.searchParams.get("protocol");
      return protocol ? `ProxyScrape ${protocol.toUpperCase()}` : "ProxyScrape";
    }
    return host;
  } catch {
    return "Route list";
  }
}

function renderSourceHealth(pool) {
  const stats = Array.isArray(pool?.sourceStats) ? pool.sourceStats : [];
  const hasStats = stats.length > 0;
  els.sourceHealth.classList.toggle("hidden", !hasStats);
  if (!hasStats) {
    els.sourceHealthTooltip.classList.add("hidden");
    els.sourceHealthDetails.replaceChildren();
    return;
  }

  const healthy = stats.filter((source) => source.ok).length;
  const candidates = stats.reduce((sum, source) => sum + (source.ok ? Number(source.count) || 0 : 0), 0);
  const verified = Array.isArray(pool?.proxies) ? pool.proxies.length : 0;
  const allHealthy = healthy === stats.length;
  els.sourceHealth.classList.toggle("degraded", !allHealthy);
  if (status.phase === "starting") {
    els.sourceHealthSummary.textContent = allHealthy
      ? `${candidates.toLocaleString()} possible routes found · verification in progress`
      : `${candidates.toLocaleString()} possible routes found from a limited search · verification in progress`;
  } else if (verified > 0) {
    els.sourceHealthSummary.textContent = allHealthy
      ? `${verified} verified exits ready from ${candidates.toLocaleString()} possible routes`
      : `${verified} verified exits ready · some route lists were unavailable`;
  } else {
    els.sourceHealthSummary.textContent = allHealthy
      ? `${candidates.toLocaleString()} possible routes found · none passed verification`
      : "Search was limited · no verified exits found";
  }
  els.sourceHealthInfoButton.setAttribute("aria-label", "View route search details");
  els.sourceHealthDetails.replaceChildren();

  for (const source of stats) {
    const item = document.createElement("li");
    item.className = "source-health-detail";

    const label = document.createElement("span");
    label.className = "source-health-detail-name";
    label.textContent = sourceLabel(source.url);

    const result = document.createElement("span");
    result.className = `source-health-detail-result ${source.ok ? "healthy" : "unavailable"}`;
    if (source.ok) {
      const count = Number(source.count) || 0;
      const hasUniqueCount = source.uniqueAdded != null && Number.isFinite(Number(source.uniqueAdded));
      const added = hasUniqueCount ? Number(source.uniqueAdded) : 0;
      result.textContent = !hasUniqueCount || added === count
        ? `${count.toLocaleString()} routes found`
        : `${count.toLocaleString()} found · ${added.toLocaleString()} new`;
    } else {
      result.textContent = source.error ? `Unavailable: ${source.error}` : "Unavailable";
      result.title = source.error || "";
    }

    item.append(label, result);
    els.sourceHealthDetails.append(item);
  }
}

// Logs pool.sourceStats (per-source fetch health from sources.js) as a single
// Activity line per refresh. The drawer also presents the same aggregate as a
// persistent, glanceable source-health signal.
let lastLoggedSourceStats = null;
function logSourceHealth(pool) {
  const stats = Array.isArray(pool?.sourceStats) ? pool.sourceStats : [];
  if (stats.length === 0) return;
  const key = JSON.stringify(stats);
  if (key === lastLoggedSourceStats) return;
  lastLoggedSourceStats = key;
  const healthy = stats.filter((source) => source.ok).length;
  const candidates = stats.reduce((sum, source) => sum + (source.ok ? Number(source.count) || 0 : 0), 0);
  const allHealthy = healthy === stats.length;
  const summary = allHealthy
    ? `All ${stats.length} route lists reached`
    : `${healthy}/${stats.length} route lists reached`;
  addLog(allHealthy ? "info" : "warn", `${summary} · ${candidates.toLocaleString()} possible routes found before testing`);
}

function renderBlocklist() {
  const blocked = loadBlocklist();
  els.blockedCount.textContent = String(blocked.length);
  els.blockedList.replaceChildren();

  if (blocked.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pool-empty";
    const title = document.createElement("strong");
    title.textContent = "No blocked exits";
    const description = document.createElement("span");
    description.textContent = "IPs you block are kept out of future pools until you unblock them.";
    empty.append(title, description);
    els.blockedList.append(empty);
    return;
  }

  for (const ip of blocked) {
    const row = document.createElement("div");
    row.className = "blocked-row";
    const label = document.createElement("span");
    label.className = "blocked-ip";
    label.textContent = ip;
    const unblock = document.createElement("button");
    unblock.type = "button";
    unblock.className = "pool-block";
    unblock.textContent = "Unblock";
    unblock.title = `Allow ${ip} back into future pools`;
    unblock.addEventListener("click", () => void unblockExitIp(ip));
    row.append(label, unblock);
    els.blockedList.append(row);
  }
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
    } else if (pool?.lastDiscoveryError) {
      title.textContent = "No verified exits";
      description.textContent = pool.lastDiscoveryError;
    } else {
      title.textContent = "No verified exits yet";
      description.textContent = "Connect to build a measured fallback pool.";
    }
    empty.append(title, description);
    els.poolList.append(empty);
    return;
  }

  // Each row holds two SIBLING buttons — a large "select" button (switches to
  // that exit) and a small block button — never one button nested inside
  // another, which is invalid HTML and unreliable for click/focus handling.
  const rowInteractive = status.phase === "running" && !actionBusy;
  for (const [index, proxy] of proxies.entries()) {
    const active = current && proxy.protocol === current.protocol && proxy.host === current.host && proxy.port === current.port;
    const label = proxy.exitIp || proxy.host;

    const row = document.createElement("div");
    row.className = `pool-row${active ? " active" : ""}${!rowInteractive && !active ? " row-disabled" : ""}`;

    const select = document.createElement("button");
    select.type = "button";
    select.className = "pool-row-select";
    select.disabled = active || !rowInteractive;
    if (active) select.setAttribute("aria-current", "true");
    select.title = active ? `${label} is the active exit` : `Switch to ${label}`;
    select.addEventListener("click", () => selectExit(proxy));

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
    const meta = document.createElement("span");
    const bits = [];
    if (proxy.latencyMs != null) bits.push(`${proxy.latencyMs} ms`);
    if (proxy.speedConsistency != null) bits.push(`${Math.round(proxy.speedConsistency * 100)}% steady`);
    if (proxy.protocol) bits.push(proxy.protocol.toUpperCase());
    if (proxy.failures) bits.push(`${proxy.failures} fail${proxy.failures === 1 ? "" : "s"}`);
    meta.textContent = bits.join(" · ");
    speed.append(mbps, meta);

    select.append(state, id, speed);

    const block = document.createElement("button");
    block.type = "button";
    block.className = "pool-block-icon";
    block.setAttribute("aria-label", `Block IP address ${label}`);

    // Lucide "ban" icon (ISC license), https://lucide.dev/icons/ban
    const blockIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    blockIcon.classList.add("pool-block-icon-svg");
    blockIcon.setAttribute("viewBox", "0 0 24 24");
    blockIcon.setAttribute("fill", "none");
    blockIcon.setAttribute("stroke", "currentColor");
    blockIcon.setAttribute("stroke-width", "2");
    blockIcon.setAttribute("stroke-linecap", "round");
    blockIcon.setAttribute("stroke-linejoin", "round");
    blockIcon.setAttribute("aria-hidden", "true");
    const blockCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    blockCircle.setAttribute("cx", "12");
    blockCircle.setAttribute("cy", "12");
    blockCircle.setAttribute("r", "10");
    const blockSlash = document.createElementNS("http://www.w3.org/2000/svg", "path");
    blockSlash.setAttribute("d", "m4.9 4.9 14.2 14.2");
    blockIcon.append(blockCircle, blockSlash);

    const blockTooltip = document.createElement("span");
    blockTooltip.className = "pool-action-tooltip";
    blockTooltip.id = `block-tooltip-${index}`;
    blockTooltip.setAttribute("role", "tooltip");
    blockTooltip.textContent = "Block IP";
    block.setAttribute("aria-describedby", blockTooltip.id);
    block.append(blockIcon, blockTooltip);
    // Independent of "active": you can block the exit you're currently on,
    // just not while another action (rotate/refresh/select) is in flight.
    block.disabled = !rowInteractive;
    block.addEventListener("click", (event) => {
      event.stopPropagation();
      void blockExitIp(proxy.exitIp || proxy.host);
    });

    row.append(select, block);
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
  if (s.includes("confirm") || s.includes("selected")) return 3;
  if (s.includes("throughput") || s.includes("measuring") || s.includes("speed-tested")) return 2;
  if (s.includes("testing") || s.includes("candidate") || s.includes("sampled") || s.includes("verified")) return 1;
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

function applyStructuredProgress(progress) {
  if (!progress || status.phase !== "starting") return;
  const stage = String(progress.stage || "").toLowerCase();
  const idx = STAGE_TO_STEP[stage];
  if (typeof idx === "number" && idx > maxStep) {
    maxStep = idx;
    paintPipeline();
  }
  // Only update the live pipeline text here. Every progress message is already
  // mirrored to the engine's regular log stream (pool.js's #emitProgress calls
  // logger.info for each one), which the "engine-log" listener adds to the
  // Activity feed unconditionally — logging it again here would duplicate
  // every stage-boundary line.
  if (progress.message) {
    els.pipelineLive.textContent = progress.message;
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
 * Preference persistence (last-used connect options)
 * ------------------------------------------------------------------ */
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      country: els.country.value,
      rankMode: selectedRank,
      maxCandidates: Number(els.sampleSize.value),
      poolSize: Number(els.poolSize.value),
      autoFallback: els.autoFallback.checked,
      socksEnabled: els.socksEnabled.checked,
    }));
  } catch {
    // Private mode / storage full — non-fatal.
  }
}

function applyPrefs(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  if (prefs.country && COUNTRIES[prefs.country]) {
    els.country.value = prefs.country;
  }
  if (prefs.rankMode && RANK_HELP[prefs.rankMode]) {
    selectedRank = prefs.rankMode;
    for (const button of els.rankMode.querySelectorAll("button")) {
      const active = button.dataset.rank === selectedRank;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    els.rankHelp.textContent = RANK_HELP[selectedRank];
  }
  if (Number.isFinite(prefs.maxCandidates)) {
    const clamped = Math.min(500, Math.max(40, Number(prefs.maxCandidates)));
    els.sampleSize.value = String(clamped);
    els.sampleValue.textContent = String(clamped);
  }
  if (prefs.poolSize != null) {
    const value = String(prefs.poolSize);
    if ([...els.poolSize.options].some((option) => option.value === value)) {
      els.poolSize.value = value;
    }
  }
  if (typeof prefs.autoFallback === "boolean") {
    els.autoFallback.checked = prefs.autoFallback;
  }
  if (typeof prefs.socksEnabled === "boolean") {
    els.socksEnabled.checked = prefs.socksEnabled;
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
    isMaximized: () => appWindow.isMaximized(),
    onResized: (handler) => appWindow.onResized(handler),
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
    blockedExitIps: loadBlocklist(),
    socksEnabled: els.socksEnabled.checked,
  };
}

async function connect() {
  logEntries = [];
  els.logs.replaceChildren();
  resetPipeline();
  els.pipelineLive.textContent = "Starting the proxy engine…";
  savePrefs();
  addLog("info", `Connecting to a ${els.country.value} exit in ${selectedRank} mode`);
  await withAction("connect", null, async () => {
    status = await backend.invoke("start_engine", { config: startConfig() });
    render();
  });
}

async function copyExitIp() {
  const ip = status.pool?.current?.exitIp;
  if (!ip) return;
  try {
    await navigator.clipboard.writeText(ip);
    showToast(`Copied ${ip}`, "success");
  } catch {
    showToast("Could not copy exit IP", "error");
  }
}

async function copySocksAddress() {
  const address = els.socksAddress.textContent;
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    showToast(`Copied ${address}`, "success");
  } catch {
    showToast("Could not copy the SOCKS address", "error");
  }
}

async function blockExitIp(exitIp) {
  if (!exitIp) return;
  const key = String(exitIp).trim().toLowerCase();
  const list = loadBlocklist();
  if (!list.includes(key)) {
    list.push(key);
    saveBlocklist(list);
  }
  await withAction("block", `Blocked ${exitIp}`, async () => {
    if (status.phase === "running") {
      status.pool = await backend.invoke("block_exit", { exitIp });
    }
    render();
  });
}

async function unblockExitIp(exitIp) {
  if (!exitIp) return;
  const key = String(exitIp).trim().toLowerCase();
  saveBlocklist(loadBlocklist().filter((ip) => ip !== key));
  // Unblocking only lifts the exclusion for future discovery passes — it does
  // not retroactively re-add the IP to an already-committed pool — so the
  // engine call (when connected) is best-effort and the toast says so.
  if (status.phase === "running") {
    await withAction("unblock", `Unblocked ${exitIp} — takes effect on the next refresh`, async () => {
      status.pool = await backend.invoke("unblock_exit", { exitIp });
      render();
    });
    return;
  }
  showToast(`Unblocked ${exitIp}`, "success");
  render();
}

function showUpdateBanner(update) {
  pendingUpdate = update;
  els.updateBannerText.textContent = `MeshHop ${update.latestVersion} is available (you have ${update.currentVersion}).`;
  els.updateBanner.classList.remove("hidden");
}

async function checkForUpdate() {
  if (!isTauri) return;
  try {
    const update = await backend.invoke("check_for_update");
    if (!update?.updateAvailable) return;
    const dismissed = localStorage.getItem(UPDATE_DISMISS_KEY);
    if (dismissed === update.latestVersion) return;
    showUpdateBanner(update);
  } catch (error) {
    addLog("warn", `Update check skipped: ${error?.message ?? error}`);
  }
}

async function selectExit(proxy) {
  await withAction("select", `Switched to ${proxy.exitIp || proxy.host}`, async () => {
    status.pool = await backend.invoke("select_exit", {
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
    });
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

// A tooltip is transient by definition. It never enters a pinned state and it
// never uses the browser's top-layer popover API. Any movement that separates
// it from its trigger (pointer exit, scroll, resize, or window deactivation)
// hides it immediately.
function wireInfoTooltip(button, tooltip) {
  if (!button || !tooltip) return;

  function hide() {
    tooltip.classList.add("hidden");
  }

  function position() {
    const anchor = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 8;
    const roomRight = window.innerWidth - anchor.right - viewportPadding - gap;
    const roomLeft = anchor.left - viewportPadding - gap;
    const placeRight = roomRight >= tooltipRect.width || roomRight >= roomLeft;
    const idealLeft = placeRight
      ? anchor.right + gap
      : anchor.left - gap - tooltipRect.width;
    const idealTop = anchor.top + (anchor.height - tooltipRect.height) / 2;
    const left = Math.max(viewportPadding, Math.min(idealLeft, window.innerWidth - viewportPadding - tooltipRect.width));
    const top = Math.max(viewportPadding, Math.min(idealTop, window.innerHeight - viewportPadding - tooltipRect.height));
    tooltip.dataset.side = placeRight ? "right" : "left";
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function show() {
    if (button.getClientRects().length === 0) return;
    tooltip.classList.remove("hidden");
    position();
  }

  button.addEventListener("pointerenter", show);
  button.addEventListener("pointerleave", () => {
    if (!button.matches(":focus-visible")) hide();
  });
  button.addEventListener("focus", () => {
    if (button.matches(":focus-visible")) show();
  });
  button.addEventListener("blur", hide);
  button.addEventListener("click", (event) => {
    // The button sits inside a <label>; cancelling the default also prevents
    // an info click from toggling the associated SOCKS setting.
    event.preventDefault();
    event.stopPropagation();
    if (tooltip.classList.contains("hidden")) show();
  });

  document.addEventListener("pointerdown", (event) => {
    if (button.contains(event.target)) return;
    hide();
    if (document.activeElement === button) button.blur();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    hide();
    if (document.activeElement === button) button.blur();
  });
  const scrollContainer = button.closest(".themed-scroll");
  scrollContainer?.addEventListener("scroll", hide, { passive: true });
  document.addEventListener("scroll", hide, true);
  document.addEventListener("wheel", hide, { capture: true, passive: true });
  document.addEventListener("visibilitychange", hide);
  window.addEventListener("resize", hide);
  window.addEventListener("blur", hide);

  const visibilityObserver = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) hide();
  });
  visibilityObserver.observe(button);
}

async function syncMaximizeButton() {
  if (!backend.isMaximized) return;
  try {
    const isMaximized = await backend.isMaximized();
    els.maxButton.classList.toggle("is-maximized", isMaximized);
    const label = isMaximized ? "Restore" : "Maximize";
    els.maxButton.setAttribute("aria-label", label);
    els.maxButton.title = label;
  } catch {
    // Window state is cosmetic; leave the current icon intact if it cannot be read.
  }
}

function createCountryPicker() {
  return createListboxPicker({
    nativeSelect: els.country,
    trigger: els.countryButton,
    popover: els.countryPopover,
    list: els.countryList,
    topInset: 52, // keep clear of the custom titlebar
    estimatedRowHeight: 42,
    tabForward: els.startButton,
    buildOption(item, option) {
      const code = document.createElement("span");
      code.className = "country-option-code";
      code.textContent = countryCode(option.value);

      const name = document.createElement("span");
      name.className = "country-option-name select-option-name";
      name.textContent = option.textContent;

      const check = document.createElement("span");
      check.className = "country-option-check select-option-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";

      item.classList.add("country-option");
      item.append(code, name, check);
    },
    onSync(selected) {
      els.countryButtonText.textContent = countryName(selected);
    },
  });
}

function createPoolSizePicker() {
  return createListboxPicker({
    nativeSelect: els.poolSize,
    trigger: els.poolSizeButton,
    popover: els.poolSizePopover,
    list: els.poolSizeList,
    topInset: 12,
    estimatedRowHeight: 36,
    tabForward: els.autoFallback,
    buildOption(item, option) {
      const name = document.createElement("span");
      name.className = "select-option-name";
      name.textContent = option.textContent;

      const check = document.createElement("span");
      check.className = "select-option-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";

      item.append(name, check);
    },
    onSync() {
      els.poolSizeButtonText.textContent = els.poolSize.selectedOptions[0]?.textContent ?? els.poolSize.value;
    },
  });
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function wire() {
  els.minButton.addEventListener("click", () => backend.minimize?.());
  els.maxButton.addEventListener("click", async () => {
    try {
      await backend.toggleMaximize?.();
    } catch (error) {
      showToast(`Could not resize the window: ${error?.message ?? error}`, "error");
    } finally {
      await syncMaximizeButton();
    }
  });
  els.closeButton.addEventListener("click", () => backend.close?.());

  countryPicker = createCountryPicker();
  poolSizePicker = createPoolSizePicker();
  els.country.addEventListener("change", () => { savePrefs(); render(); });
  els.poolSize.addEventListener("change", () => { savePrefs(); render(); });
  els.autoFallback.addEventListener("change", savePrefs);
  els.socksEnabled.addEventListener("change", savePrefs);
  countryPicker.wire();
  poolSizePicker.wire();
  wireInfoTooltip(els.socksInfoButton, els.socksInfoTooltip);
  wireInfoTooltip(els.sourceHealthInfoButton, els.sourceHealthTooltip);
  wireInfoTooltip(els.rankInfoButton, els.rankInfoTooltip);

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
    savePrefs();
  });

  els.sampleSize.addEventListener("input", () => {
    els.sampleValue.textContent = els.sampleSize.value;
    savePrefs();
  });

  els.exitIp.addEventListener("click", () => void copyExitIp());
  els.socksInfo.addEventListener("click", () => void copySocksAddress());
  els.exitIp.style.cursor = "pointer";

  els.updateDownload?.addEventListener("click", () => {
    if (!pendingUpdate?.downloadUrl) return;
    void backend.invoke("open_external_url", { url: pendingUpdate.downloadUrl }).catch((error) => {
      showToast(String(error?.message ?? error), "error");
    });
  });
  els.updateDismiss?.addEventListener("click", () => {
    if (pendingUpdate?.latestVersion) {
      try { localStorage.setItem(UPDATE_DISMISS_KEY, pendingUpdate.latestVersion); } catch { /* ignore */ }
    }
    els.updateBanner.classList.add("hidden");
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

  // Drawer — the tab buttons themselves double as the collapsed handle: click
  // a closed or inactive tab to open/switch to it, click the already-open
  // active tab again to collapse. The trailing caret button is a plain
  // open/close toggle that doesn't touch which tab is selected.
  const setDrawerOpen = (open) => {
    els.drawer.classList.toggle("open", open);
    els.drawerHandle.setAttribute("aria-expanded", String(open));
    els.drawerBody.setAttribute("aria-hidden", String(!open));
    els.clearLogs.classList.toggle("hidden", !(open && els.tabActivity.classList.contains("active")));
  };
  els.drawerHandle.addEventListener("click", () => {
    setDrawerOpen(!els.drawer.classList.contains("open"));
  });
  const TABS = [
    { id: "exits", tab: els.tabExits, panel: els.exitsPanel },
    { id: "blocked", tab: els.tabBlocked, panel: els.blockedPanel },
    { id: "activity", tab: els.tabActivity, panel: els.activityPanel },
  ];
  const selectTab = (id) => {
    for (const entry of TABS) {
      const active = entry.id === id;
      entry.tab.classList.toggle("active", active);
      entry.tab.setAttribute("aria-selected", String(active));
      entry.tab.tabIndex = active ? 0 : -1;
      entry.panel.classList.toggle("hidden", !active);
      entry.panel.hidden = !active;
    }
    setDrawerOpen(true);
  };
  const activateTab = (id, tabButton) => {
    if (els.drawer.classList.contains("open") && tabButton.classList.contains("active")) {
      setDrawerOpen(false);
      return;
    }
    selectTab(id);
  };
  for (const entry of TABS) {
    entry.tab.addEventListener("click", () => activateTab(entry.id, entry.tab));
    entry.tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = TABS.indexOf(entry);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = TABS[(index + direction + TABS.length) % TABS.length];
      selectTab(next.id);
      next.tab.focus();
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
  applyPrefs(loadPrefs());
  els.rankHelp.textContent = RANK_HELP[selectedRank];
  wire();
  countryPicker?.sync();
  poolSizePicker?.sync();
  render();

  await syncMaximizeButton();
  await backend.onResized?.(() => void syncMaximizeButton());

  await backend.listen("engine-log", ({ payload }) => {
    const level = payload.level || "info";
    const message = payload.message || "";
    // Structured progress owns the pipeline live text when available; logs still
    // fill the activity feed and act as a fallback for older engine builds.
    addLog(level, message);
    if (status.phase === "starting" && level !== "error") {
      if (!els.pipelineLive.dataset.structured) {
        els.pipelineLive.textContent = friendlyProgressMessage(message);
        advancePipeline(message);
      }
    }
  });
  await backend.listen("engine-progress", ({ payload }) => {
    els.pipelineLive.dataset.structured = "1";
    applyStructuredProgress(payload);
  });
  await backend.listen("engine-state", ({ payload }) => {
    if (payload.phase === "starting" && status.phase !== "starting") {
      resetPipeline();
      delete els.pipelineLive.dataset.structured;
      lastToastedDiscoveryError = null;
      lastLoggedSourceStats = null;
    }
    if (payload.phase !== "starting") delete els.pipelineLive.dataset.structured;
    status = payload.pool || !status.pool ? payload : { ...payload, pool: status.pool };
    if (status.phase === "running") maybeToastDiscoveryError(status.pool);
    logSourceHealth(status.pool);
    render();
  });
  await backend.listen("pool-updated", ({ payload }) => {
    status.pool = payload;
    if (status.phase === "running" || status.phase === "starting") {
      maybeToastDiscoveryError(payload);
    }
    logSourceHealth(payload);
    render();
  });

  await updateStatus();
  setInterval(updateStatus, 5000);
  void checkForUpdate();
}

/* ------------------------------------------------------------------ *
 * Mock backend — only used when running outside Tauri (browser preview)
 * ------------------------------------------------------------------ */
function mockBackend() {
  const listeners = new Map();
  const emit = (event, payload) => (listeners.get(event) || []).forEach((cb) => cb({ payload }));
  const state = { phase: "stopped", message: "Ready to connect", proxyPort: 17877, controlPort: 17878, socksPort: null, pool: null };
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
        checkedAt: new Date().toISOString(),
        lastUsed: i === 0 ? new Date().toISOString() : null,
        network: {
          isp: ISPS[i],
          org: ISPS[i],
          kind: hosting ? "hosting-likely" : i % 2 ? "consumer-likely" : "unknown",
        },
      };
    });
    // Randomized per call so the preview doesn't show identical numbers on every mock refresh
    // (the real engine's sourceStats come from live network results in src/public/sources.js).
    const jitter = (base, spread) => Math.round(base + (Math.random() - 0.5) * spread);
    const sourceStats = [
      { url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/…", ok: true, count: jitter(412, 80) },
      { url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/…", ok: true, count: jitter(203, 60) },
      { url: "https://api.proxyscrape.com/v2/?protocol=http…", ok: true, count: jitter(318, 70) },
      Math.random() < 0.7
        ? { url: "https://api.proxyscrape.com/v2/?protocol=socks4…", ok: false, count: 0, error: "504 Gateway Timeout" }
        : { url: "https://api.proxyscrape.com/v2/?protocol=socks4…", ok: true, count: jitter(90, 40) },
      { url: "https://api.proxyscrape.com/v2/?protocol=socks5…", ok: true, count: jitter(176, 50) },
    ];
    return {
      country,
      rankMode: selectedRank,
      sourceCount: sourceStats.reduce((sum, s) => sum + s.count, 0),
      sourceStats,
      lastRefresh: new Date().toISOString(),
      refreshing: false,
      autoFallback: true,
      blockedExitIps: loadBlocklist(),
      current: proxies[0],
      proxies,
    };
  };

  const script = (country) => {
    const progress = [
      [300, { stage: "fetch", done: 0, total: 2, message: `Downloading published ${country} proxy lists…` }],
      [400, { stage: "fetch", done: 2, total: 2, message: `Fetched 128 published ${country} candidates; sampling 40…` }],
      [500, { stage: "probe", done: 0, total: 40, message: `Testing 40 of 128 published ${country} candidates…` }],
      [500, { stage: "probe", done: 5, total: 40, message: "Verified 5 working exits of 40 tested…" }],
      [600, { stage: "speed", done: 0, total: 24, message: "Measuring sustained throughput on the 24 strongest candidates…" }],
      [500, { stage: "speed", done: 8, total: 24, message: "Speed-tested 8/24 exits…" }],
      [600, { stage: "confirm", done: 0, total: 12, message: "Confirming the 12 best candidates across independent HTTPS hosts…" }],
      [500, { stage: "confirm", done: 8, total: 12, message: "Confirmed 8/12 exits…" }],
      [400, { stage: "commit", done: 1, total: 1, message: "Selected http://45.120.8.10:8080 (23.55.0.51, 140 ms, 58.2 Mbps); 8 verified exits retained" }],
    ];
    let delay = 200;
    for (const [gap, payload] of progress) {
      delay += gap;
      setTimeout(() => {
        if (state.phase !== "starting") return;
        emit("engine-progress", payload);
        emit("engine-log", { level: "info", message: payload.message });
      }, delay);
    }
    setTimeout(() => {
      if (state.phase !== "starting") return;
      state.pool = makePool(country);
      state.phase = "running";
      state.message = `${country} exit is active`;
      emit("pool-updated", state.pool);
      emit("engine-state", { ...state });
    }, delay + 500);
  };

  const snapshot = () => ({ phase: state.phase, message: state.message, proxyPort: state.proxyPort, controlPort: state.controlPort, socksPort: state.socksPort, pool: state.pool });

  return {
    minimize() {}, toggleMaximize() {}, close() {},
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
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
        state.socksPort = args.config.socksEnabled ? 17879 : null;
        emit("engine-state", { ...state });
        script(country);
        return Promise.resolve(snapshot());
      }
      if (cmd === "block_exit") {
        const ip = String(args.exitIp || "").toLowerCase();
        if (state.pool) {
          state.pool.proxies = state.pool.proxies.filter((proxy) => proxy.exitIp !== ip);
          if (state.pool.current?.exitIp === ip) {
            state.pool.current = state.pool.proxies[0] || null;
          }
          state.pool.blockedExitIps = [...new Set([...(state.pool.blockedExitIps || []), ip])];
          emit("pool-updated", state.pool);
        }
        return Promise.resolve(state.pool);
      }
      if (cmd === "unblock_exit") {
        const ip = String(args.exitIp || "").toLowerCase();
        if (state.pool) {
          state.pool.blockedExitIps = (state.pool.blockedExitIps || []).filter((blocked) => blocked !== ip);
          emit("pool-updated", state.pool);
        }
        return Promise.resolve(state.pool);
      }
      if (cmd === "check_for_update") {
        return Promise.resolve({
          currentVersion: __APP_VERSION__,
          latestVersion: __APP_VERSION__,
          updateAvailable: false,
          downloadUrl: "https://github.com/Swpn0neel/mesh-hop/releases/latest",
          releaseUrl: "https://github.com/Swpn0neel/mesh-hop/releases/latest",
        });
      }
      if (cmd === "open_external_url") return Promise.resolve();
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
      if (cmd === "select_exit") {
        const match = state.pool?.proxies.find(
          (proxy) => proxy.protocol === args.protocol && proxy.host === args.host && proxy.port === args.port,
        );
        if (!match) return Promise.reject(new Error("That exit is no longer in the verified pool"));
        state.pool.current = match;
        emit("pool-updated", state.pool);
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
