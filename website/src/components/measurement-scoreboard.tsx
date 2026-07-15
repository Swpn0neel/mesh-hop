"use client";

import { useEffect, useRef, useState } from "react";
import AnimatedContent from "@/components/AnimatedContent";

const TRACE_PATH =
  "M0 139C34 130 43 65 78 77s48 39 83 9 42-43 76-21 43 17 79 4 43 8 80 2 43-4 78 2 52-6 89-1 52-2 97-1";

const TRACE_AREA = `${TRACE_PATH}V164H0Z`;

type TraceState = {
  progress: number;
  speed: number;
  x: number;
  y: number;
};

export function MeasurementScoreboard() {
  const observerTargetRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const animationRef = useRef<number | null>(null);
  const hasPlayedRef = useRef(false);
  const [trace, setTrace] = useState<TraceState>({ progress: 0, speed: 55.5, x: 0, y: 139 });

  useEffect(() => {
    const target = observerTargetRef.current;
    const path = pathRef.current;

    if (!target || !path) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const length = path.getTotalLength();
    const finish = () => {
      const point = path.getPointAtLength(length);
      setTrace({ progress: 1, speed: 74.8, x: point.x, y: point.y });
    };

    if (reducedMotion) {
      hasPlayedRef.current = true;
      finish();
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || hasPlayedRef.current) return;

        hasPlayedRef.current = true;
        observer.disconnect();
        const startedAt = performance.now();
        const duration = 2800;

        const animate = (now: number) => {
          const elapsed = Math.min((now - startedAt) / duration, 1);
          const progress = 1 - Math.pow(1 - elapsed, 4);
          const point = path.getPointAtLength(length * progress);
          const speed = elapsed === 1 ? 74.8 : Math.max(0, Math.min(84, 95 - point.y * 0.284));

          setTrace({ progress, speed, x: point.x, y: point.y });

          if (elapsed < 1) {
            animationRef.current = requestAnimationFrame(animate);
          }
        };

        animationRef.current = requestAnimationFrame(animate);
      },
      { threshold: 0.3, rootMargin: "0px 0px -14%" },
    );

    observer.observe(target);

    return () => {
      observer.disconnect();
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  return (
    <div ref={observerTargetRef} className="measurement-scoreboard-observer">
      <AnimatedContent distance={42} duration={0.85} threshold={0.18} className="scoreboard">
        <div className="scoreboard-primary">
          <div className="scoreboard-heading">
            <div>
              <span className="section-index">Example verified route</span>
              <h3>Steady speed</h3>
            </div>
            <span className="route-grade"><i />Route held</span>
          </div>
          <div className="hero-metric" aria-label={`Measured speed ${trace.speed.toFixed(1)} megabits per second`}>
            <strong>{trace.speed.toFixed(1)}</strong><span>Mbps</span>
          </div>
          <svg
            className="speed-trace"
            viewBox="0 0 660 164"
            preserveAspectRatio="none"
            aria-label="Animated speed trace settling near 75 megabits per second"
          >
            <defs>
              <clipPath id="trace-reveal">
                <rect x="0" y="0" width={660 * trace.progress} height="164" />
              </clipPath>
            </defs>
            <path className="trace-grid" d="M0 25H660M0 80H660M0 135H660" />
            <path className="trace-line trace-line-ghost" d={TRACE_PATH} />
            <g clipPath="url(#trace-reveal)">
              <path className="trace-area" d={TRACE_AREA} />
            </g>
            <path
              ref={pathRef}
              className="trace-line trace-line-progress"
              d={TRACE_PATH}
              pathLength="1"
              style={{ strokeDasharray: 1, strokeDashoffset: 1 - trace.progress }}
            />
            <line x1="0" y1="70" x2="660" y2="70" className="trace-threshold" />
            <text x="650" y="61" textAnchor="end">steady threshold</text>
            {trace.progress > 0 && (
              <g className="trace-cursor" transform={`translate(${trace.x} ${trace.y})`} aria-hidden="true">
                <circle className="trace-cursor-halo" r="8" />
                <circle className="trace-cursor-point" r="3.2" />
              </g>
            )}
          </svg>
          <div className="trace-scale"><span>0s</span><span>15s measurement window</span></div>
        </div>

        <div className="scoreboard-secondary">
          <div className="secondary-metric">
            <div><span>Latency</span><strong>128 <small>ms</small></strong></div>
            <p>Round-trip delay after the route settles.</p>
          </div>
          <div className="secondary-metric">
            <div><span>Consistency</span><strong>94 <small>%</small></strong></div>
            <p>How closely repeated samples hold together.</p>
          </div>
          <div className="secondary-metric verified-count">
            <div><span>Verified pool</span><strong>3 <small>exits</small></strong></div>
            <p>Alternatives ready when you choose to rotate.</p>
          </div>
        </div>
      </AnimatedContent>
    </div>
  );
}
