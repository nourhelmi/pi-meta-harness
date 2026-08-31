export function parseRollout(raw) {
  if (!raw || !["off", "on"].includes(raw.mode)) {
    throw new Error("unsupported rollout mode");
  }
  return { mode: raw.mode };
}
