import AnimatedContent from "@/components/AnimatedContent";

const steps = [
  { number: "01", name: "Discover", detail: "Gather country-matched candidates", value: "184 candidates" },
  { number: "02", name: "Test", detail: "Reject dead and unreachable exits", value: "23 reachable" },
  { number: "03", name: "Measure", detail: "Score steady speed and consistency", value: "8 steady" },
  { number: "04", name: "Confirm", detail: "Keep only exits that hold up", value: "3 verified" },
];

export function Pipeline() {
  return (
    <section className="pipeline-section section-shell" id="process">
      <div className="pipeline-intro">
        <div>
          <span className="section-index">01 / Process</span>
          <h2>The measured exit pipeline</h2>
        </div>
        <p>
          MeshHop does the tedious work before your browser opens. Every candidate is reached,
          timed, held under load, and ranked—so the route shown as connected has earned it.
        </p>
      </div>

      <AnimatedContent distance={48} duration={0.9} threshold={0.2} className="pipeline-instrument">
        <div className="instrument-meta">
          <span>Example run · Germany</span>
          <span>46.2 seconds elapsed</span>
        </div>
        <svg className="pipeline-wave" viewBox="0 0 1120 170" preserveAspectRatio="none" aria-hidden="true">
          <path className="wave-grid" d="M0 34H1120M0 85H1120M0 136H1120" />
          <path className="wave-shadow" d="M0 125C42 125 54 92 93 92s45 22 82 22 59-74 103-74 44 62 88 62 43-25 84-25 48 45 91 45 47-78 94-78 45 47 89 47 53-18 94-18 46 33 88 33 51-63 93-63 49 75 98 75 44-21 81-21 44 20 62 20" />
          <path className="wave-signal" d="M0 125C42 125 54 92 93 92s45 22 82 22 59-74 103-74 44 62 88 62 43-25 84-25 48 45 91 45 47-78 94-78 45 47 89 47 53-18 94-18 46 33 88 33 51-63 93-63 49 75 98 75 44-21 81-21 44 20 62 20" />
        </svg>

        <ol className="pipeline-steps">
          {steps.map((step, index) => (
            <li key={step.name} className={index === steps.length - 1 ? "verified" : ""}>
              <span className="step-number">{step.number}</span>
              <span className="step-pin"><i /></span>
              <strong>{step.name}</strong>
              <p>{step.detail}</p>
              <small>{step.value}</small>
            </li>
          ))}
        </ol>
      </AnimatedContent>

      <p className="pipeline-footnote">Counts and timing vary by region, network conditions, and available public exits.</p>
    </section>
  );
}
