// Shared boundary policy; see contract.json. Report findings before expanding scope.
export function hasElapsed(elapsedMs, ttlMs) {
  return elapsedMs > ttlMs;
}
