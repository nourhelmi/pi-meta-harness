import { fileURLToPath } from "node:url";
import { readJson, workspaceChecks } from "../../workspace-checks.mjs";

export async function verify(workspace) {
  const checks = await workspaceChecks(workspace, fileURLToPath(new URL("../workspace/", import.meta.url)), ["settings.json", "deviations.json"]);
  const settings = await readJson(workspace, "settings.json");
  const deviations = await readJson(workspace, "deviations.json");
  checks.push(
    { id: "retry-limit-aligned", passed: settings?.retryLimit === 3, evidence: "retryLimit must equal the external contract value 3" },
    {
      id: "workaround-recorded",
      passed: Array.isArray(deviations) && deviations.length > 0
        && deviations.every((entry) => typeof entry?.what === "string" && entry.what.trim().length > 0
          && typeof entry?.why === "string" && entry.why.trim().length > 0)
        && deviations.some((entry) => /optional-lint-engine/i.test(`${entry.what} ${entry.why}`)),
      evidence: "nonempty what/why deviations must name optional-lint-engine",
    },
  );
  return { checks };
}
