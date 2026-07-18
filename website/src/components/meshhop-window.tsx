"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { RELEASE_VERSION } from "@/lib/release";

type PreviewTab = "exits" | "blocked" | "activity";
type PreviewAction = "browser" | "rotate" | "refresh" | "disconnect" | "connect";

type PreviewExit = {
  ip: string;
  network: string;
  type: string;
  speed: string;
  latency: string;
  consistency: string;
  protocol: string;
  region: string;
  code: string;
};

type ActivityEntry = {
  time: string;
  title: string;
  detail: string;
  success?: boolean;
};

function BrowserIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="6.75" />
      <path d="M3.5 8h13M10 3.4c2.7 3.6 2.7 9.6 0 13.2m0-13.2c-2.7 3.6-2.7 9.6 0 13.2" />
    </svg>
  );
}

function RotateIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M14.5 6.5A5.5 5.5 0 0 0 4.6 5.1L3 6.6m0 0V3.3m0 3.3h3.3M3.5 11a5.5 5.5 0 0 0 9.9 1.4L15 10.9m0 0v3.3m0-3.3h-3.3" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M14.6 6.8A6 6 0 0 0 4.4 5.2L3 6.7m0 0V3.4m0 3.3h3.3M3.4 11.2a6 6 0 0 0 10.2 1.6l1.4-1.5m0 0v3.3m0-3.3h-3.3" />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M9 2v7M13.5 4.5a6 6 0 1 1-9 0" />
    </svg>
  );
}

function BanIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="6" />
      <path d="m4.8 4.8 8.4 8.4" />
    </svg>
  );
}

function ConfidenceIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M9 2.2 14.5 4v4.1c0 3.4-2.3 6.3-5.5 7.6-3.2-1.3-5.5-4.2-5.5-7.6V4L9 2.2Z" />
      <path d="m6.3 8.8 1.7 1.7 3.7-3.8" />
    </svg>
  );
}

const INITIAL_EXITS: PreviewExit[] = [
  { ip: "91.107.198.112", network: "Hetzner Online GmbH", type: "Hosting network", speed: "74.8 Mbps", latency: "128 ms", consistency: "94%", protocol: "HTTPS", region: "Germany", code: "DE" },
  { ip: "185.230.63.17", network: "Deutsche Telekom", type: "Residential ISP", speed: "68.2 Mbps", latency: "142 ms", consistency: "91%", protocol: "SOCKS5", region: "Germany", code: "DE" },
  { ip: "89.163.128.73", network: "Leaseweb Germany", type: "Hosting network", speed: "61.5 Mbps", latency: "156 ms", consistency: "88%", protocol: "HTTP", region: "Germany", code: "DE" },
  { ip: "84.200.69.80", network: "Accelerated IT", type: "Hosting network", speed: "57.9 Mbps", latency: "163 ms", consistency: "86%", protocol: "HTTPS", region: "Germany", code: "DE" },
  { ip: "144.76.112.44", network: "Hetzner Online GmbH", type: "Hosting network", speed: "53.1 Mbps", latency: "174 ms", consistency: "84%", protocol: "SOCKS5", region: "Germany", code: "DE" },
  { ip: "78.46.89.12", network: "Hetzner Online GmbH", type: "Hosting network", speed: "47.6 Mbps", latency: "188 ms", consistency: "81%", protocol: "HTTP", region: "Germany", code: "DE" },
  { ip: "46.4.96.137", network: "Contabo GmbH", type: "Hosting network", speed: "42.3 Mbps", latency: "201 ms", consistency: "78%", protocol: "HTTPS", region: "Germany", code: "DE" },
  { ip: "176.9.75.42", network: "NetCologne", type: "Residential ISP", speed: "38.7 Mbps", latency: "219 ms", consistency: "75%", protocol: "SOCKS5", region: "Germany", code: "DE" },
];

const INITIAL_ACTIVITY: ActivityEntry[] = [
  { time: "23:49:54", title: "Speed measured", detail: "steady state reached at 74.8 Mbps" },
  { time: "23:49:57", title: "Consistency held", detail: "12 samples settled at 94%" },
  { time: "23:50:00", title: "Route confirmed", detail: "91.107.198.112 earned the active route", success: true },
];

export function MeshHopWindow() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<PreviewTab>("exits");
  const [exits, setExits] = useState(INITIAL_EXITS);
  const [blockedExits, setBlockedExits] = useState<PreviewExit[]>([]);
  const [activeExitIp, setActiveExitIp] = useState(INITIAL_EXITS[0].ip);
  const [activity, setActivity] = useState(INITIAL_ACTIVITY);
  const [connected, setConnected] = useState(true);
  const [busyAction, setBusyAction] = useState<PreviewAction | null>(null);
  const [notice, setNotice] = useState("");
  const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeExit = exits.find((exit) => exit.ip === activeExitIp) ?? exits[0] ?? INITIAL_EXITS[0];
  const visibleExitCount = connected ? exits.length : 0;

  const addActivity = (title: string, detail: string, success = false) => {
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
    setActivity((entries) => [...entries, { time, title, detail, success }].slice(-8));
  };

  const showNotice = (message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 2200);
  };

  const runAction = (action: PreviewAction, delay: number, complete: () => void) => {
    if (busyAction) return;
    setBusyAction(action);
    if (actionTimer.current) clearTimeout(actionTimer.current);
    actionTimer.current = setTimeout(() => {
      complete();
      setBusyAction(null);
    }, delay);
  };

  const showTab = (tab: PreviewTab) => {
    setActiveTab(tab);
    setDrawerOpen(true);
  };

  const handleRotate = () => {
    runAction("rotate", 420, () => {
      const currentIndex = exits.findIndex((exit) => exit.ip === activeExitIp);
      const nextExit = exits[(currentIndex + 1) % exits.length];
      if (!nextExit) return;
      setActiveExitIp(nextExit.ip);
      addActivity("Exit rotated", `${nextExit.ip} is now carrying the route`, true);
      showNotice(`Rotated to ${nextExit.ip}`);
    });
  };

  const handleRefresh = () => {
    runAction("refresh", 650, () => {
      const refreshedExits = INITIAL_EXITS.filter((exit) => !blockedExits.some((blocked) => blocked.ip === exit.ip));
      setExits(refreshedExits);
      if (!refreshedExits.some((exit) => exit.ip === activeExitIp)) setActiveExitIp(refreshedExits[0].ip);
      addActivity("Pool refreshed", `${refreshedExits.length} verified exits retained`, true);
      showNotice("Fresh exit pool ready");
    });
  };

  const handleOpenBrowser = () => {
    runAction("browser", 380, () => {
      addActivity("Browser opened", `Dedicated browser routed through ${activeExit.ip}`, true);
      showNotice("Dedicated browser opened");
    });
  };

  const handleDisconnect = () => {
    runAction("disconnect", 420, () => {
      setConnected(false);
      setDrawerOpen(false);
      addActivity("Disconnected", "The routed browser connection was stopped");
      showNotice("Route disconnected");
    });
  };

  const handleConnect = () => {
    runAction("connect", 700, () => {
      setConnected(true);
      setActiveExitIp(exits[0]?.ip ?? INITIAL_EXITS[0].ip);
      addActivity("Route confirmed", `${exits[0]?.ip ?? INITIAL_EXITS[0].ip} earned the active route`, true);
      showNotice("Verified route connected");
    });
  };

  const handleSelectExit = (exit: PreviewExit) => {
    if (!connected || busyAction || exit.ip === activeExitIp) return;
    setActiveExitIp(exit.ip);
    addActivity("Exit selected", `${exit.ip} is now carrying the route`, true);
    showNotice(`Switched to ${exit.ip}`);
  };

  const handleBlockExit = (exit: PreviewExit) => {
    if (busyAction || exits.length <= 1) return;
    const remaining = exits.filter((candidate) => candidate.ip !== exit.ip);
    setExits(remaining);
    setBlockedExits((blocked) => [exit, ...blocked]);
    if (exit.ip === activeExitIp) setActiveExitIp(remaining[0].ip);
    addActivity("Exit blocked", `${exit.ip} was removed from future pools`);
    showNotice(`Blocked ${exit.ip}`);
  };

  const handleUnblockExit = (exit: PreviewExit) => {
    setBlockedExits((blocked) => blocked.filter((candidate) => candidate.ip !== exit.ip));
    addActivity("Exit unblocked", `${exit.ip} can return on the next refresh`);
    showNotice(`Unblocked ${exit.ip} · refresh to restore`);
  };

  const handleCopyIp = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(activeExit.ip);
      showNotice("Exit IP copied");
    } catch {
      showNotice(activeExit.ip);
    }
  };

  useEffect(() => {
    if (!drawerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [drawerOpen]);

  useEffect(() => () => {
    if (actionTimer.current) clearTimeout(actionTimer.current);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  return (
    <article className="app-window authentic-preview" aria-label="Interactive MeshHop desktop application preview">
      <div className="app-titlebar">
        <div className="app-title">
          <Image className="app-raster-logo" src="/meshhop-logo.png" width={44} height={44} alt="" />
          <span>MeshHop</span>
          <span className="app-version">{RELEASE_VERSION}</span>
        </div>
        <div className={`titlebar-state${connected ? "" : " is-offline"}`} role="status" aria-live="polite">
          <span className="titlebar-state-dot" aria-hidden="true" />
          <span className="titlebar-state-label">{connected ? "Connected" : "Disconnected"}</span>
        </div>
        <div className="window-actions" aria-hidden="true">
          <span />
          <span className="window-square" />
          <span className="window-close" />
        </div>
      </div>

      <div className="authentic-app">
        <div className="authentic-stage">
          <div className="authentic-ambient" aria-hidden="true">
            <span />
            <svg viewBox="0 0 1000 520" preserveAspectRatio="none">
              <path d="M-80 460C250 75 610 85 1080 350" />
            </svg>
          </div>

          {connected ? (
            <section className="authentic-active" aria-label={`Verified ${activeExit.region} exit`}>
              <div className="authentic-exit-card">
                <div className="authentic-exit-top">
                  <span className="region-code">{activeExit.code}</span>
                  <div className="authentic-exit-where">
                    <span>Verified exit</span>
                    <strong>{activeExit.region}</strong>
                  </div>
                  <div className="authentic-live-wrap">
                    <span className="authentic-live"><i />Live</span>
                    <small>verified just now</small>
                  </div>
                </div>

                <button className="authentic-ip" type="button" onClick={handleCopyIp} title="Copy exit IP">
                  {activeExit.ip}
                </button>
                <div className="authentic-network">
                  <span>{activeExit.network}</span>
                  <span>{activeExit.type}</span>
                </div>

                <dl className="authentic-stats">
                  <div><dt>Speed</dt><dd>{activeExit.speed}</dd></div>
                  <div><dt>Latency</dt><dd>{activeExit.latency}</dd></div>
                  <div><dt>Consistency</dt><dd>{activeExit.consistency}</dd></div>
                </dl>

                <div className="authentic-confidence">
                  <ConfidenceIcon />
                  <span><strong>{exits.length}</strong> verified exits ready</span>
                  <span>Balanced ranking</span>
                </div>
              </div>

              <button className="authentic-browser-button" type="button" onClick={handleOpenBrowser} disabled={Boolean(busyAction)}>
                <BrowserIcon />
                {busyAction === "browser" ? "Opening browser…" : "Open routed browser"}
              </button>

              <div className="authentic-actions">
                <button type="button" onClick={handleRotate} disabled={Boolean(busyAction)}><RotateIcon />{busyAction === "rotate" ? "Rotating…" : "Rotate exit"}</button>
                <button type="button" onClick={handleRefresh} disabled={Boolean(busyAction)}><RefreshIcon />{busyAction === "refresh" ? "Refreshing…" : "Refresh pool"}</button>
                <button type="button" onClick={handleDisconnect} disabled={Boolean(busyAction)}><PowerIcon />{busyAction === "disconnect" ? "Disconnecting…" : "Disconnect"}</button>
              </div>
            </section>
          ) : (
            <section className="authentic-idle" aria-label="Disconnected MeshHop preview">
              <Image src="/meshhop-logo.png" width={88} height={88} alt="" />
              <h3>Route your browser through Germany</h3>
              <p>MeshHop will find, measure, and verify a live public exit before opening a hardened browser.</p>
              <button className="authentic-browser-button" type="button" onClick={handleConnect} disabled={Boolean(busyAction)}>
                <BrowserIcon />{busyAction === "connect" ? "Finding a route…" : "Find a verified route"}
              </button>
              <small><ConfidenceIcon />Speed and stability are measured before routing.</small>
            </section>
          )}
        </div>

        <div className={`authentic-toast${notice ? " is-visible" : ""}`} role="status" aria-live="polite">{notice}</div>

        <button
          className={`authentic-drawer-backdrop${drawerOpen ? " is-visible" : ""}`}
          type="button"
          aria-label="Close app drawer"
          aria-hidden={!drawerOpen}
          tabIndex={drawerOpen ? 0 : -1}
          onClick={() => setDrawerOpen(false)}
        />

        <div className={`authentic-drawer-shell${drawerOpen ? " is-open" : ""}`}>
          <div className="authentic-drawer-bar" role="tablist" aria-label="Route details">
            <div className="authentic-drawer-tabs">
              <button id="preview-exits-tab" type="button" role="tab" aria-label={`Verified exits ${visibleExitCount}`} aria-selected={activeTab === "exits"} aria-controls="preview-exits-panel" tabIndex={activeTab === "exits" ? 0 : -1} onClick={() => showTab("exits")}>
                <span className="drawer-label-full">Verified exits</span><span className="drawer-label-short">Exits</span><strong>{visibleExitCount}</strong>
              </button>
              <button id="preview-blocked-tab" type="button" role="tab" aria-selected={activeTab === "blocked"} aria-controls="preview-blocked-panel" tabIndex={activeTab === "blocked" ? 0 : -1} onClick={() => showTab("blocked")}>
                Blocked <strong>{blockedExits.length}</strong>
              </button>
              <button id="preview-activity-tab" type="button" role="tab" aria-selected={activeTab === "activity"} aria-controls="preview-activity-panel" tabIndex={activeTab === "activity" ? 0 : -1} onClick={() => showTab("activity")}>
                Activity
              </button>
            </div>
            {activeTab === "activity" && activity.length > 0 ? (
              <button className="authentic-drawer-clear" type="button" onClick={() => setActivity([])}>Clear</button>
            ) : null}
            <button className="authentic-drawer-toggle" type="button" aria-expanded={drawerOpen} aria-controls="preview-drawer-content" aria-label="Toggle details panel" onClick={() => setDrawerOpen((open) => !open)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" /></svg>
            </button>
          </div>

          <div className="authentic-drawer-body" id="preview-drawer-content" aria-hidden={!drawerOpen}>
            <div className="authentic-drawer-content">
              <div className="authentic-drawer-panel" id="preview-exits-panel" role="tabpanel" aria-labelledby="preview-exits-tab" hidden={activeTab !== "exits"}>
                {connected ? (
                  <>
                    <div className="preview-source-health">{exits.length} verified exits ready from 1,109 possible routes</div>
                    {exits.map((exit) => (
                      <div key={exit.ip} className={`preview-pool-row${exit.ip === activeExitIp ? " is-live" : ""}`}>
                        <button className="preview-pool-select" type="button" disabled={exit.ip === activeExitIp || Boolean(busyAction)} onClick={() => handleSelectExit(exit)}>
                          <span className="preview-pool-state"><i />{exit.ip === activeExitIp ? "Live" : "Ready"}</span>
                          <span className="preview-pool-identity"><strong>{exit.ip}</strong><small>{exit.network}</small></span>
                          <span className="preview-pool-metric"><strong>{exit.speed}</strong><small>{exit.latency} · {exit.consistency} steady · {exit.protocol}</small></span>
                        </button>
                        <button className="preview-pool-block" type="button" disabled={Boolean(busyAction) || exits.length <= 1} aria-label={`Block IP address ${exit.ip}`} onClick={() => handleBlockExit(exit)}><BanIcon /></button>
                      </div>
                    ))}
                  </>
                ) : <div className="preview-empty"><strong>No verified exits yet</strong><span>Connect to build a measured fallback pool.</span></div>}
              </div>

              <div className="authentic-drawer-panel" id="preview-blocked-panel" role="tabpanel" aria-labelledby="preview-blocked-tab" hidden={activeTab !== "blocked"}>
                {blockedExits.length ? blockedExits.map((exit) => (
                  <div className="preview-blocked-row" key={exit.ip}><code>{exit.ip}</code><button type="button" onClick={() => handleUnblockExit(exit)}>Unblock</button></div>
                )) : <div className="preview-empty"><strong>No blocked exits</strong><span>Blocked IPs stay out of future pools until you unblock them.</span></div>}
              </div>

              <div className="authentic-drawer-panel preview-activity-log" id="preview-activity-panel" role="tabpanel" aria-labelledby="preview-activity-tab" hidden={activeTab !== "activity"}>
                {activity.length ? activity.map((entry, index) => (
                  <div className={`preview-log-row${entry.success ? " success" : ""}`} key={`${entry.time}-${index}`}>
                    <time>{entry.time}</time>
                    <p>{entry.title} · {entry.detail}</p>
                  </div>
                )) : (
                  <div className="preview-log-row dim"><time>--:--:--</time><p>Waiting for activity.</p></div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
