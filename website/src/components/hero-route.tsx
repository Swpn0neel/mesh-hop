export function HeroRoute() {
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
        <path
          className="route-signal"
          d="M42 91C165 91 206 44 330 64s197 67 322 19 215-56 325-8 128 32 181-11"
          stroke="url(#routeSignal)"
          filter="url(#routeGlow)"
        />

        <g className="route-node route-node-one">
          <circle cx="42" cy="91" r="8" />
          <circle cx="42" cy="91" r="3" />
        </g>
        <g className="route-node route-node-two">
          <circle cx="330" cy="64" r="8" />
          <circle cx="330" cy="64" r="3" />
        </g>
        <g className="route-node route-node-three">
          <circle cx="652" cy="83" r="8" />
          <circle cx="652" cy="83" r="3" />
        </g>
        <g className="route-node route-node-four route-node-live">
          <circle cx="1158" cy="64" r="10" />
          <circle cx="1158" cy="64" r="3.5" />
        </g>
      </svg>

      <ol className="route-checkpoints" aria-hidden="true">
        <li className="checkpoint-one">
          <span>Discover</span>
          <strong>184 candidates</strong>
        </li>
        <li className="checkpoint-two">
          <span>Test</span>
          <strong>23 reachable</strong>
        </li>
        <li className="checkpoint-three">
          <span>Measure</span>
          <strong>8 steady</strong>
        </li>
        <li className="checkpoint-four">
          <span>Confirm</span>
          <strong>3 verified</strong>
        </li>
      </ol>
    </figure>
  );
}
