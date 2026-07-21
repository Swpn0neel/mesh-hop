"use client";

import Image from "next/image";
import AnimatedContent from "@/components/AnimatedContent";
import BlurText from "@/components/BlurText";
import { HeroRoute } from "@/components/hero-route";
import { MeasurementScoreboard } from "@/components/measurement-scoreboard";
import { MeshHopWindow } from "@/components/meshhop-window";
import { Pipeline } from "@/components/pipeline";
import { SiteHeader } from "@/components/site-header";
import { WindowsDownloadLink } from "@/components/windows-download-link";
import { LATEST_RELEASE_URL, RELEASE_VERSION, WINDOWS_INSTALLER_URL } from "@/lib/release";
import { motion, useReducedMotion } from "motion/react";

const HERO_EASE = [0.22, 1, 0.36, 1] as const;

function DownloadIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M9 2.5v9m0 0 3.5-3.5M9 11.5 5.5 8M3 15h12" />
    </svg>
  );
}

function RouteIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="3.2" cy="12.8" r="1.4" />
      <path d="M4.6 12.5C7 6.7 9.2 5.2 14.5 5.2M11.8 2.8l2.7 2.4-2.7 2.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3 8.2 3.1 3.1L13 4.8" />
    </svg>
  );
}

export default function Home() {
  const reduceMotion = useReducedMotion();

  return (
    <div className="site min-h-screen" id="top">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <SiteHeader />

      <main id="main-content">
        <section className="hero-section" aria-labelledby="hero-title">
          <div className="hero-aura" aria-hidden="true" />
          <div className="hero-copy shell">
            <motion.a
              className="product-hunt-badge"
              href="https://www.producthunt.com/products/meshhop?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-meshhop"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View MeshHop on Product Hunt (opens in a new tab)"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { delay: 0.04, duration: 0.45, ease: HERO_EASE }}
            >
              {/* Product Hunt badges are served as live widgets and should not be proxied by Next Image. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1201337&theme=dark&t=1784589337031"
                alt="MeshHop — Discover, Measure, Verify, Route on Product Hunt"
                width="250"
                height="54"
              />
            </motion.a>
            {/*
            <motion.div
              className="availability"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { delay: 0.08, duration: 0.45, ease: HERO_EASE }}
            >
              <span />Windows desktop app · no account required
            </motion.div>
            */}
            <h1 id="hero-title">
              <BlurText
                text="A working exit, earned."
                delay={65}
                stepDuration={0.3}
                direction="bottom"
                animateOnView={false}
                className="justify-center"
              />
            </h1>
            <motion.p
              className="hero-kicker"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { delay: 0.2, duration: 0.5, ease: HERO_EASE }}
            >
              Discover · Measure · Verify · Route
            </motion.p>
            <motion.p
              className="hero-description"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { delay: 0.28, duration: 0.55, ease: HERO_EASE }}
            >
              MeshHop tests public proxy exits until one earns the route—then opens a dedicated
              browser routed through the best verified option.
            </motion.p>
            <motion.div
              className="hero-actions"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { delay: 0.38, duration: 0.55, ease: HERO_EASE }}
            >
              <WindowsDownloadLink className="button-primary" href={WINDOWS_INSTALLER_URL} download>
                <DownloadIcon />
                Download for Windows
              </WindowsDownloadLink>
              <a className="button-secondary" href="#process">
                <RouteIcon />
                Watch the route
              </a>
            </motion.div>
            <motion.div
              className="hero-meta"
              aria-label="Download details"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={reduceMotion ? { duration: 0 } : { delay: 0.5, duration: 0.4, ease: HERO_EASE }}
            >
              <span><span className="meta-full">Windows 10 / 11</span><span className="meta-compact">Win 10/11</span></span>
              <i />
              <span><span className="meta-full">64-bit installer</span><span className="meta-compact">x64</span></span>
              <i />
              <span><span className="meta-full">Version {RELEASE_VERSION}</span><span className="meta-compact">v{RELEASE_VERSION}</span></span>
            </motion.div>
          </div>

          <HeroRoute />

          <AnimatedContent
            distance={54}
            duration={1}
            threshold={0.05}
            delay={0.08}
            className="app-showcase shell"
          >
            <MeshHopWindow />
          </AnimatedContent>
        </section>

        <Pipeline />

        <section className="measurement-section section-shell" id="proof">
          <div className="measurement-intro">
            <div>
              <span className="section-index">02 / Confidence</span>
              <h2>It does not trust the first green light.</h2>
            </div>
            <p>
              A reachable proxy can still stall under load or when loading complex web assets. MeshHop measures
              steady-state performance and keeps a small verified pool ready for rotation.
            </p>
          </div>

          <MeasurementScoreboard />

          <ul className="measurement-notes" aria-label="Route quality checks">
            <li><CheckIcon /><span><strong>Reachability</strong> before bandwidth is spent</span></li>
            <li><CheckIcon /><span><strong>Steady-state speed</strong> instead of a single burst</span></li>
            <li><CheckIcon /><span><strong>Consistency scoring</strong> across repeated samples</span></li>
          </ul>
        </section>

        <section className="honesty-section" id="safety">
          <div className="section-shell honesty-layout">
            <AnimatedContent
              distance={28}
              direction="horizontal"
              reverse
              duration={0.65}
              threshold={0.2}
              className="honesty-lead"
            >
              <span className="section-index">03 / Good to know</span>
              <h2>Useful, not magic.</h2>
              <p>
                MeshHop removes the busywork from finding a public exit. It does not turn that exit
                into a private network.
              </p>
            </AnimatedContent>

            <AnimatedContent
              distance={30}
              duration={0.7}
              threshold={0.2}
              delay={0.06}
              className="honesty-list"
            >
              <article>
                <span>01</span>
                <div>
                  <h3>Not a VPN</h3>
                  <p>MeshHop routes one dedicated browser profile through a public proxy. It does not tunnel every app on your PC.</p>
                </div>
              </article>
              <article>
                <span>02</span>
                <div>
                  <h3>No anonymity promise</h3>
                  <p>Public proxies are operated by third parties. Use HTTPS, avoid sensitive accounts, and treat every exit as untrusted.</p>
                </div>
              </article>
              <article>
                <span>03</span>
                <div>
                  <h3>Built for ordinary browsing</h3>
                  <p>Use it for low-risk browsing and regional access where a working, measured exit matters more than a raw proxy list.</p>
                </div>
              </article>
            </AnimatedContent>
          </div>
        </section>

        <section id="download">
          <AnimatedContent
            distance={36}
            duration={0.72}
            threshold={0.2}
            className="download-section section-shell"
          >
            <Image className="download-mark" src="/meshhop-logo.png" width={112} height={112} alt="MeshHop" />
            <span className="download-ready"><i />Ready for Windows</span>
            <h2>Let the route prove itself.</h2>
            <p>Choose a region. Give MeshHop a minute to test the field. Open the browser only when the exit is earned.</p>
            <div className="download-actions">
              <WindowsDownloadLink className="button-primary large download-button" href={WINDOWS_INSTALLER_URL} download>
                <DownloadIcon />
                <span>Download MeshHop {RELEASE_VERSION}</span>
              </WindowsDownloadLink>
            </div>
            <div className="download-detail">
              <span>Windows 10/11 · 64-bit</span>
              <a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer">Release details ↗</a>
            </div>
          </AnimatedContent>
        </section>
      </main>

      <footer className="site-footer section-shell">
        <a className="footer-brand" href="#top"><Image src="/meshhop-logo.png" width={56} height={56} alt="" /><span>MeshHop</span></a>
        <p>Measured public exits for a dedicated Windows browser.</p>
        <div><span>Version {RELEASE_VERSION}</span></div>
      </footer>
    </div>
  );
}
