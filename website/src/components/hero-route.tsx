"use client";

import { motion, useReducedMotion } from "motion/react";

const ROUTE_EASE = [0.22, 1, 0.36, 1] as const;

export function HeroRoute() {
  const reduceMotion = useReducedMotion();
  const initialNode = { opacity: 0, scale: 0.78 };

  return (
    <figure className="hero-route" aria-label="Illustrative route verification stages">
      <svg viewBox="0 0 1200 152" role="img" aria-label="A route moving through four verification stages">
        <defs>
          <linearGradient id="routeSignal" x1="40" y1="90" x2="1160" y2="64" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#8f9aff" />
            <stop offset="0.78" stopColor="#6c7cff" />
            <stop offset="1" stopColor="#52d99e" />
          </linearGradient>
          <filter id="routeGlow" x="-10%" y="-100%" width="120%" height="300%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <path
          className="route-baseline"
          d="M42 91C165 91 206 44 330 64s197 67 322 19 215-56 325-8 128 32 181-11"
        />
        <motion.path
          className="route-signal"
          d="M42 91C165 91 206 44 330 64s197 67 322 19 215-56 325-8 128 32 181-11"
          stroke="url(#routeSignal)"
          filter="url(#routeGlow)"
          initial={{ pathLength: 0, opacity: 0.35 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.08, duration: 1.25, ease: ROUTE_EASE }}
        />

        <motion.g
          className="route-node route-node-one"
          initial={initialNode}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.12, duration: 0.3, ease: ROUTE_EASE }}
        >
          <circle cx="42" cy="91" r="8" />
          <circle cx="42" cy="91" r="3" />
        </motion.g>
        <motion.g
          className="route-node route-node-two"
          initial={initialNode}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.38, duration: 0.3, ease: ROUTE_EASE }}
        >
          <circle cx="330" cy="64" r="8" />
          <circle cx="330" cy="64" r="3" />
        </motion.g>
        <motion.g
          className="route-node route-node-three"
          initial={initialNode}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.64, duration: 0.3, ease: ROUTE_EASE }}
        >
          <circle cx="652" cy="83" r="8" />
          <circle cx="652" cy="83" r="3" />
        </motion.g>
        <motion.g
          className="route-node route-node-four route-node-live"
          initial={initialNode}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.9, duration: 0.3, ease: ROUTE_EASE }}
        >
          <motion.circle
            cx="1158"
            cy="64"
            r="10"
            initial={{ scale: 1, opacity: 1 }}
            animate={reduceMotion ? { scale: 1, opacity: 1 } : { scale: [1, 1, 1.55, 1.55], opacity: [1, 1, 0.2, 0] }}
            transition={reduceMotion ? { duration: 0 } : {
              delay: 1.25,
              duration: 2.2,
              times: [0, 0.45, 0.75, 1],
              ease: "easeOut",
              repeat: Infinity,
            }}
          />
          <circle cx="1158" cy="64" r="3.5" />
        </motion.g>
      </svg>

      <ol className="route-checkpoints" aria-hidden="true">
        <motion.li
          className="checkpoint-one"
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.12, duration: 0.3, ease: ROUTE_EASE }}
        >
          <span>Discover</span>
          <strong>184 candidates</strong>
        </motion.li>
        <motion.li
          className="checkpoint-two"
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.38, duration: 0.3, ease: ROUTE_EASE }}
        >
          <span>Test</span>
          <strong>23 reachable</strong>
        </motion.li>
        <motion.li
          className="checkpoint-three"
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.64, duration: 0.3, ease: ROUTE_EASE }}
        >
          <span>Measure</span>
          <strong>8 steady</strong>
        </motion.li>
        <motion.li
          className="checkpoint-four"
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          transition={reduceMotion ? { duration: 0 } : { delay: 0.9, duration: 0.3, ease: ROUTE_EASE }}
        >
          <span>Confirm</span>
          <strong>3 verified</strong>
        </motion.li>
      </ol>
    </figure>
  );
}
