"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { RELEASE_VERSION } from "@/lib/release";

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
      <path d="M9 3v3m0 6v3m6-6h-3M6 9H3m10.2-4.2-2.1 2.1M7 11l-2.1 2.1m8.3 0L11 11M7 7 4.8 4.8" />
      <circle cx="9" cy="9" r="2.2" />
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

const MOCK_EXITS = [
  {
    ip: "91.107.198.112",
    network: "Hetzner Online GmbH",
    type: "Hosting network",
    speed: "74.8 Mbps",
    latency: "128 ms",
    consistency: "94%",
    region: "Germany",
    code: "DE",
  },
  {
    ip: "185.230.63.17",
    network: "Deutsche Telekom",
    type: "Residential ISP",
    speed: "68.2 Mbps",
    latency: "142 ms",
    consistency: "91%",
    region: "Germany",
    code: "DE",
  },
  {
    ip: "89.163.128.73",
    network: "Leaseweb Germany",
    type: "Hosting network",
    speed: "61.5 Mbps",
    latency: "156 ms",
    consistency: "88%",
    region: "Germany",
    code: "DE",
  }
];

export function MeshHopWindow() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"exits" | "activity">("exits");
  const [activeExitIndex, setActiveExitIndex] = useState(0);

  const activeExit = MOCK_EXITS[activeExitIndex];

  const showTab = (tab: "exits" | "activity") => {
    setActiveTab(tab);
    setDrawerOpen(true);
  };

  const handleRotate = () => {
    setActiveExitIndex((prev) => (prev + 1) % MOCK_EXITS.length);
  };

  useEffect(() => {
    if (!drawerOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [drawerOpen]);

  return (
    <article className="app-window authentic-preview" aria-label="MeshHop desktop application connected-state preview">
      <div className="app-titlebar">
        <div className="app-title">
          <Image className="app-raster-logo" src="/meshhop-logo.png" width={44} height={44} alt="" />
          <span>MeshHop</span>
          <span className="app-version">{RELEASE_VERSION}</span>
        </div>
        <div className="titlebar-state"><span />Connected</div>
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

          <section className="authentic-active" aria-label={`Verified ${activeExit.region} exit`}>
            <div className="authentic-exit-card">
              <div className="authentic-exit-top">
                <span className="region-code">{activeExit.code}</span>
                <div className="authentic-exit-where">
                  <span>Verified exit</span>
                  <strong>{activeExit.region}</strong>
                </div>
                <span className="authentic-live"><i />Live</span>
              </div>

              <code className="authentic-ip">{activeExit.ip}</code>
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
                <span><strong>{MOCK_EXITS.length}</strong> verified exits ready</span>
                <span>Balanced ranking</span>
              </div>
            </div>

            <button className="authentic-browser-button" type="button">
              <BrowserIcon />
              Open routed browser
            </button>

            <div className="authentic-actions">
              <button type="button" onClick={handleRotate}><RotateIcon />Rotate exit</button>
              <button type="button"><RefreshIcon />Refresh pool</button>
              <button type="button">Disconnect</button>
            </div>
          </section>
        </div>

        <button
          className={`authentic-drawer-backdrop${drawerOpen ? " is-visible" : ""}`}
          type="button"
          aria-label="Close app drawer"
          aria-hidden={!drawerOpen}
          tabIndex={drawerOpen ? 0 : -1}
          onClick={() => setDrawerOpen(false)}
        />

        <div className={`authentic-drawer-shell${drawerOpen ? " is-open" : ""}`}>
          <button
            className="authentic-drawer"
            type="button"
            aria-expanded={drawerOpen}
            aria-controls="preview-drawer-content"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <span>Verified exits <strong>{MOCK_EXITS.length}</strong></span>
            <i>·</i>
            <span>{activeTab === "exits" ? "Exit pool" : "Activity"}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" /></svg>
          </button>

          <div className="authentic-drawer-body" id="preview-drawer-content" aria-hidden={!drawerOpen}>
            <div className="authentic-drawer-content">
              <div className="authentic-drawer-tabs" role="tablist" aria-label="Desktop app drawer">
                <button
                  id="preview-exits-tab"
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "exits"}
                  aria-controls="preview-exits-panel"
                  tabIndex={drawerOpen && activeTab === "exits" ? 0 : -1}
                  onClick={() => showTab("exits")}
                >
                  Exit pool <span>{MOCK_EXITS.length}</span>
                </button>
                <button
                  id="preview-activity-tab"
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "activity"}
                  aria-controls="preview-activity-panel"
                  tabIndex={drawerOpen && activeTab === "activity" ? 0 : -1}
                  onClick={() => showTab("activity")}
                >
                  Activity
                </button>
              </div>

              <div
                className="authentic-drawer-panel"
                id="preview-exits-panel"
                role="tabpanel"
                aria-labelledby="preview-exits-tab"
                hidden={activeTab !== "exits"}
              >
                {MOCK_EXITS.map((exit, idx) => (
                  <div key={exit.ip} className={`preview-pool-row${idx === activeExitIndex ? " is-live" : ""}`}>
                    <span className="preview-pool-state"><i />{idx === activeExitIndex ? "Live" : "Ready"}</span>
                    <span className="preview-pool-identity"><strong>{exit.ip}</strong><small>{exit.network}</small></span>
                    <span className="preview-pool-metric"><strong>{exit.speed.split(" ")[0]}</strong><small>Mbps</small></span>
                    <span className="preview-pool-metric"><strong>{exit.latency.split(" ")[0]}</strong><small>ms</small></span>
                  </div>
                ))}
              </div>

              <div
                className="authentic-drawer-panel preview-activity-log"
                id="preview-activity-panel"
                role="tabpanel"
                aria-labelledby="preview-activity-tab"
                hidden={activeTab !== "activity"}
              >
                <p><time>00:46.2</time><span className="success">Route confirmed</span><small>{activeExit.ip} earned the active route</small></p>
                <p><time>00:41.7</time><span>Consistency held</span><small>12 samples settled at {activeExit.consistency}</small></p>
                <p><time>00:29.4</time><span>Speed measured</span><small>Steady state reached at {activeExit.speed}</small></p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
