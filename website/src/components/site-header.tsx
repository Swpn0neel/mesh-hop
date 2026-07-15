"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

function DownloadArrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2v8m0 0 3-3m-3 3L5 7M3 13h10" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.8a9.4 9.4 0 0 0-3 18.3c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .8.1-.7.4-1.1.7-1.4-2.3-.3-4.7-1.1-4.7-5.1 0-1.1.4-2 1.1-2.8-.1-.3-.5-1.3.1-2.7 0 0 .9-.3 2.9 1.1a10 10 0 0 1 5.3 0c2-1.4 2.9-1.1 2.9-1.1.6 1.4.2 2.4.1 2.7.7.8 1.1 1.7 1.1 2.8 0 4-2.4 4.8-4.7 5.1.4.3.7 1 .7 1.9v3.5c0 .3.2.6.7.5A9.4 9.4 0 0 0 12 2.8Z" />
    </svg>
  );
}

const GITHUB_URL =
  process.env.NEXT_PUBLIC_GITHUB_URL ?? "https://github.com/search?q=MeshHop&type=repositories";

export function SiteHeader() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const updateHeader = () => {
      const scrollY = window.scrollY;

      setIsScrolled((current) => {
        if (!current && scrollY > 72) return true;
        if (current && scrollY < 10) return false;
        return current;
      });
      frameRef.current = null;
    };

    const handleScroll = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(updateHeader);
    };

    updateHeader();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, []);

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  const reduceMotion = useReducedMotion();

  return (
    <div className="site-header-slot">
      <motion.header
        initial={reduceMotion ? { opacity: 1 } : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className={`site-header shell${isScrolled ? " is-scrolled" : ""}${mobileMenuOpen ? " is-menu-open" : ""}`}
        aria-label="Primary navigation"
      >
        <a className="wordmark" href="#top" aria-label="MeshHop home" onClick={() => setMobileMenuOpen(false)}>
          <Image className="wordmark-logo" src="/meshhop-logo.png" width={64} height={64} alt="" priority />
          <span>MeshHop</span>
        </a>

        <nav className="site-nav" aria-label="Website sections">
          <a href="#process">How it works</a>
          <a href="#proof">Measurements</a>
          <a href="#safety">Good to know</a>
        </nav>

        <div className="header-actions">
          <a
            className="nav-github"
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="View MeshHop on GitHub"
            title="View MeshHop on GitHub"
          >
            <GitHubIcon />
          </a>
          <a
            className="nav-download"
            href="/downloads/MeshHop_0.3.2_x64-setup.exe"
            download
            aria-label="Download MeshHop for Windows"
          >
            <span>Download</span>
            <DownloadArrow />
          </a>
        </div>

        <button
          className={`mobile-menu-toggle${mobileMenuOpen ? " is-active" : ""}`}
          type="button"
          aria-expanded={mobileMenuOpen}
          aria-label="Toggle navigation menu"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        >
          <span className="hamburger-line line-1" />
          <span className="hamburger-line line-2" />
          <span className="hamburger-line line-3" />
        </button>
      </motion.header>

      {/* Mobile Navigation Overlay */}
      <div className={`mobile-nav-overlay${mobileMenuOpen ? " is-open" : ""}`} aria-hidden={!mobileMenuOpen}>
        <nav className="mobile-nav" aria-label="Mobile navigation sections">
          <a href="#process" onClick={() => setMobileMenuOpen(false)}>How it works</a>
          <a href="#proof" onClick={() => setMobileMenuOpen(false)}>Measurements</a>
          <a href="#safety" onClick={() => setMobileMenuOpen(false)}>Good to know</a>
        </nav>
      </div>
    </div>
  );
}
