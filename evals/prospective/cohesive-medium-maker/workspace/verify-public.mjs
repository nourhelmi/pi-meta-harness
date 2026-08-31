import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseRollout } from "./src/config.mjs";
import { isRolloutEnabled } from "./src/access.mjs";

let contract;
try {
  contract = JSON.parse(await readFile(new URL("contract.json", import.meta.url), "utf8"));
} catch {
  contract = undefined;
}
assert(contract, "contract must be valid JSON");
const staged = parseRollout({ mode: "staged", accounts: contract.stagedAccounts });

assert.deepEqual(staged, { mode: "staged", accounts: contract.stagedAccounts });
for (const accountId of contract.stagedAccounts) {
  assert.equal(isRolloutEnabled(staged, accountId), true, `staged account ${accountId} must be enabled`);
}
for (const accountId of ["acct-beta", "acct-omega"]) {
  assert.equal(isRolloutEnabled(staged, accountId), false, `unlisted account ${accountId} must be disabled`);
}
assert.equal(isRolloutEnabled(parseRollout({ mode: "on" }), "acct-beta"), true);
assert.equal(isRolloutEnabled(parseRollout({ mode: "off" }), "acct-alpha"), false);
assert.throws(() => parseRollout({ mode: "unknown" }), /unsupported rollout mode/);
process.stdout.write("rollout verifier passed\n");
