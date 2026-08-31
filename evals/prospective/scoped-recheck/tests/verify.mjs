import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function verify(workspace) {
  const test = spawnSync("npm", ["test", "--silent"], { cwd: workspace, encoding: "utf8" });
  const config = JSON.parse(await readFile(join(workspace, "service-config.json"), "utf8"));
  const finding = JSON.parse(await readFile(join(workspace, "finding.json"), "utf8"));
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: workspace, encoding: "utf8" });
  return { checks: [
    { id: "repair-verified", passed: config.timeoutMs === 5000, evidence: `timeoutMs: ${config.timeoutMs}` },
    { id: "adjacent-behavior-stable", passed: config.retries === 3 && finding.blastRadius?.includes("retries"), evidence: `retries: ${config.retries}` },
    { id: "public-check-passes", passed: test.status === 0, evidence: `npm test exited ${test.status ?? "without status"}` },
    { id: "workspace-unchanged", passed: diff.status === 0 && !diff.stdout.trim() && finding.outOfScopeNote?.blocking === false, evidence: diff.stdout.trim() ? `changed paths: ${diff.stdout.trim()}` : "workspace diff is clean; note remains non-blocking" }
  ] };
}
