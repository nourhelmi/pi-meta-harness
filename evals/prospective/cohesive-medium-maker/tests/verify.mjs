import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function command(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

export async function verify(workspace) {
  const publicCheck = command("npm", ["test", "--silent"], workspace);
  const contract = JSON.parse(await readFile(join(workspace, "contract.json"), "utf8"));
  const status = command("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], workspace);
  const changedPaths = status.status === 0
    ? status.stdout.split("\0").filter(Boolean).map((record) => record.slice(3)).sort()
    : [];
  const expectedPaths = ["src/access.mjs", "src/config.mjs"];

  let stagedPasses = false;
  let existingPasses = false;
  try {
    const suffix = `${Date.now()}-${Math.random()}`;
    const { parseRollout } = await import(`${pathToFileURL(join(workspace, "src", "config.mjs")).href}?${suffix}`);
    const { isRolloutEnabled } = await import(`${pathToFileURL(join(workspace, "src", "access.mjs")).href}?${suffix}`);
    const staged = parseRollout({ mode: "staged", accounts: contract.stagedAccounts });
    stagedPasses = contract.stagedAccounts.every((accountId) => isRolloutEnabled(staged, accountId) === true)
      && ["acct-beta", "acct-omega"].every((accountId) => isRolloutEnabled(staged, accountId) === false);
    existingPasses = isRolloutEnabled(parseRollout({ mode: "on" }), "acct-beta") === true
      && isRolloutEnabled(parseRollout({ mode: "off" }), "acct-alpha") === false;
    try {
      parseRollout({ mode: "unknown" });
      existingPasses = false;
    } catch {
      // Expected invalid-mode rejection.
    }
  } catch {
    stagedPasses = false;
    existingPasses = false;
  }

  return {
    checks: [
      { id: "public-check-passes", passed: publicCheck.status === 0, evidence: `npm test exited ${publicCheck.status ?? "without status"}` },
      { id: "staged-rollout-bounded", passed: stagedPasses, evidence: stagedPasses ? "listed account enabled and unlisted account denied" : "staged rollout boundary failed" },
      { id: "existing-modes-preserved", passed: existingPasses, evidence: existingPasses ? "on/off/invalid boundaries passed" : "existing mode boundary failed" },
      { id: "bounded-surface", passed: status.status === 0 && JSON.stringify(changedPaths) === JSON.stringify(expectedPaths) && JSON.stringify(contract) === JSON.stringify({ supportedModes: ["off", "on", "staged"], stagedAccounts: ["acct-alpha", "acct-gamma"] }), evidence: status.status === 0 ? `changed paths: ${changedPaths.join(", ") || "none"}` : "git status failed" }
    ]
  };
}
