import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deliveryBudget } from "./src/delivery.mjs";
import { retryBudget } from "./src/retry.mjs";

let contract;
try {
  contract = JSON.parse(await readFile(new URL("./contract.json", import.meta.url), "utf8"));
} catch {
  assert.fail("contract must remain readable JSON");
}
assert.equal(retryBudget(), contract.sharedDefault, "default consumers must not change");
for (const retryLimit of contract.deliveryLimits) {
  assert.equal(deliveryBudget({ retryLimit }), retryLimit, "delivery must honor its configured limit");
}
console.log("delivery and shared-default probes passed");
