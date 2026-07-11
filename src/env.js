// Shared environment-variable parsing so the CLI entry point (public.js) and the
// desktop sidecar (desktop-engine.js) validate configuration identically.

export function integerEnv(name, fallback, { minimum = 1 } = {}) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

export function booleanEnv(name, fallback = true) {
  const value = String(process.env[name] ?? (fallback ? "1" : "0")).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}
