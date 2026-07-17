// Kept in sync with package.json by scripts/sync-version.mjs.
export const USER_AGENT = "MeshHop-Public/0.4.0";

export function userAgent(comment) {
  return comment ? `${USER_AGENT} (${comment})` : USER_AGENT;
}
