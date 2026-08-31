import { provider as legacy } from "./providers/legacy.mjs";
import { provider as current } from "./providers/current.mjs";

export function routeProvider(requestKind) {
  if (requestKind === "account-sync") return legacy;
  return current;
}
