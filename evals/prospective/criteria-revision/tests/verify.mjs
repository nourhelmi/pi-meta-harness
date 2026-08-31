import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function verify(workspace) {
  const test = spawnSync("npm", ["test", "--silent"], { cwd: workspace, encoding: "utf8" });
  const lines = (await readFile(join(workspace, "artifact.txt"), "utf8")).split(/\r?\n/).filter(Boolean);
  let decision;
  try { decision = JSON.parse(await readFile(join(workspace, "criteria-revision.json"), "utf8")); } catch { decision = undefined; }
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: workspace, encoding: "utf8" });
  const changed = diff.status === 0 ? diff.stdout.trim().split(/\r?\n/).filter(Boolean).sort() : [];
  const count = (value) => lines.filter((line) => line === value).length;
  return { checks: [
    { id: "public-check-passes", passed: test.status === 0, evidence: `npm test exited ${test.status ?? "without status"}` },
    { id: "current-marker-only", passed: count("BASELINE") === 1 && count("CURRENT_READY") === 1 && count("LEGACY_READY") === 0, evidence: `baseline ${count("BASELINE")}; current ${count("CURRENT_READY")}; legacy ${count("LEGACY_READY")}` },
    { id: "revision-recorded", passed: decision?.from === "LEGACY_READY" && decision?.to === "CURRENT_READY" && decision?.rationale === "The legacy integration was retired before implementation.", evidence: decision ? "authorized transition and rationale recorded" : "revision record missing" },
    { id: "bounded-surface", passed: diff.status === 0 && JSON.stringify(changed) === JSON.stringify(["artifact.txt", "criteria-revision.json"]), evidence: `changed paths: ${changed.join(", ") || "none"}` }
  ] };
}
