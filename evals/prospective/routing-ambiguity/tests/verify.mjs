import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function verify(workspace) {
  const test = spawnSync("npm", ["test", "--silent"], { cwd: workspace, encoding: "utf8" });
  const router = await import(`${pathToFileURL(join(workspace, "router.mjs")).href}?verify=${Date.now()}`);
  const legacyText = await readFile(join(workspace, "providers", "legacy.mjs"), "utf8");
  const currentText = await readFile(join(workspace, "providers", "current.mjs"), "utf8");
  const selected = router.routeProvider("account-sync");
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: workspace, encoding: "utf8" });
  const changed = diff.status === 0 ? diff.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  return { checks: [
    { id: "public-check-passes", passed: test.status === 0, evidence: `npm test exited ${test.status ?? "without status"}` },
    { id: "current-provider-selected", passed: selected.id === "current" && selected.deprecated === false, evidence: `selected provider: ${selected.id}` },
    { id: "providers-preserved", passed: legacyText.includes("deprecated: true") && currentText.includes("deprecated: false"), evidence: "legacy and current provider contracts preserved" },
    { id: "bounded-surface", passed: diff.status === 0 && changed.length === 1 && changed[0] === "router.mjs", evidence: `changed paths: ${changed.join(", ") || "none"}` }
  ] };
}
