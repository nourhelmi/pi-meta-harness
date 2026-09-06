import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workspaceChecks } from "../../workspace-checks.mjs";

export async function verify(workspace) {
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { deliveryBudget } from "./src/delivery.mjs";
    import { retryBudget } from "./src/retry.mjs";
    assert.equal(retryBudget(), 2);
    for (const retryLimit of [0, 1, 3, 7, 11]) assert.equal(deliveryBudget({ retryLimit }), retryLimit);
  `], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
  const checks = await workspaceChecks(workspace, fileURLToPath(new URL("../workspace/", import.meta.url)), ["src/delivery.mjs"]);
  checks.push({ id: "current-contract", passed: probe.status === 0, evidence: `independent configured-limit and preserved-default probes exited ${probe.status ?? "without status"}` });
  return { checks };
}
