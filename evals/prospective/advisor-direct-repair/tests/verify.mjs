import { fileURLToPath } from "node:url";
import { readJson, workspaceChecks } from "../../workspace-checks.mjs";

export async function verify(workspace) {
  const checks = await workspaceChecks(workspace, fileURLToPath(new URL("../workspace/", import.meta.url)), ["settings.json"]);
  const settings = await readJson(workspace, "settings.json");
  const contract = await readJson(workspace, "contract.json");
  checks.push({ id: "retry-limit-aligned", passed: settings?.retryLimit === 3 && contract?.retryLimit === 3, evidence: "settings and preserved contract must both specify retryLimit 3" });
  return { checks };
}
