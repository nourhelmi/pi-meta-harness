import { retryBudget } from "./retry.mjs";

export function deliveryBudget(config) {
  return retryBudget();
}
