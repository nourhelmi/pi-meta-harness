import { hasElapsed } from "./boundary.mjs";

export function isExpired(issuedAtMs, nowMs, ttlSeconds) {
  return hasElapsed(nowMs - issuedAtMs, ttlSeconds);
}
