import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function verify(workspace) {
  const test = spawnSync("npm", ["test", "--silent"], { cwd: workspace, encoding: "utf8" });
  const artifact = await readFile(join(workspace, "artifact.md"), "utf8");
  const context = JSON.parse(await readFile(join(workspace, "review-context.json"), "utf8"));
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: workspace, encoding: "utf8" });
  const headings = ["## Scope", "## Verification", "## Rollback"];
  return { checks: [
    { id: "public-check-passes", passed: test.status === 0, evidence: `npm test exited ${test.status ?? "without status"}` },
    { id: "artifact-unchanged", passed: diff.status === 0 && !diff.stdout.trim(), evidence: diff.stdout.trim() ? `changed paths: ${diff.stdout.trim()}` : "workspace diff is clean" },
    { id: "all-sections-present", passed: headings.every((heading) => artifact.split(heading).length - 1 === 1), evidence: "required heading counts checked" },
    { id: "below-threshold-note", passed: context.riskThreshold === "medium" && context.observation?.severity === "low" && context.observation?.blocking === false, evidence: "wording preference is explicitly low-risk and non-blocking" }
  ] };
}
