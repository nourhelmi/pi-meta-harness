import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

function command(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

export async function verify(workspace) {
  const publicCheck = command("npm", ["test", "--silent"], workspace);
  const artifact = await readFile(join(workspace, "artifact.txt"), "utf8");
  const lines = artifact.split(/\r?\n/).filter(Boolean);
  const count = (value) => lines.filter((line) => line === value).length;
  const diff = command("git", ["diff", "--name-only", "HEAD"], workspace);
  const changedPaths = diff.status === 0 ? diff.stdout.trim().split(/\r?\n/).filter(Boolean) : [];

  return {
    checks: [
      {
        id: "public-check-passes",
        passed: publicCheck.status === 0,
        evidence: publicCheck.status === 0 ? "npm test exited 0" : `npm test exited ${publicCheck.status ?? "without status"}`,
      },
      {
        id: "marker-exactly-once",
        passed: count("ADVISOR_READY") === 1,
        evidence: `ADVISOR_READY exact-line count: ${count("ADVISOR_READY")}`,
      },
      {
        id: "baseline-preserved",
        passed: count("BASELINE") === 1,
        evidence: `BASELINE exact-line count: ${count("BASELINE")}`,
      },
      {
        id: "bounded-surface",
        passed: diff.status === 0 && changedPaths.length === 1 && changedPaths[0] === "artifact.txt",
        evidence: diff.status === 0 ? `changed paths: ${changedPaths.join(", ") || "none"}` : "git diff failed",
      },
    ],
  };
}
