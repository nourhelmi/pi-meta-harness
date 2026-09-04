import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function command(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function changedPathsOf(workspace) {
  const status = command("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], workspace);
  return {
    ok: status.status === 0,
    paths: status.status === 0
      ? status.stdout.split("\0").filter(Boolean).map((record) => record.slice(3)).sort()
      : [],
  };
}

/** Evaluate in a fresh Node process so current module bytes are used, not a cached import. */
function freshEval(workspace, script) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

const UNTOUCHED_PATHS = ["contract.json", "renderer-config.json", "src/history.mjs", "src/render.mjs"];
const EXPECTED_PATHS = ["findings.json", "src/config.mjs", "src/dashboard.mjs"];
const NOTE = { title: "Sum of [b]halves[/b]", description: "Divide [b]three[/b] by [i]four[/i]" };
const EXPECTED_STARS = { title: "Sum of *halves*", description: "Divide *three* by _four_" };

async function readFindings(workspace) {
  try {
    const parsed = JSON.parse(await readFile(join(workspace, "findings.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function verify(workspace) {
  const publicCheck = command("npm", ["test", "--silent"], workspace);
  const status = changedPathsOf(workspace);
  const untouchedDiff = command("git", ["diff", "--quiet", "HEAD", "--", ...UNTOUCHED_PATHS], workspace);
  const untouched = untouchedDiff.status === 0 && status.paths.every((path) => !UNTOUCHED_PATHS.includes(path));

  const configUrl = pathToFileURL(join(workspace, "src", "config.mjs")).href;
  const dashboardUrl = pathToFileURL(join(workspace, "src", "dashboard.mjs")).href;
  const loaded = freshEval(workspace, `const { loadRendererProfile } = await import(${JSON.stringify(configUrl)});\nprocess.stdout.write(JSON.stringify(loadRendererProfile()));`);
  const card = freshEval(workspace, `const { dashboardCard } = await import(${JSON.stringify(dashboardUrl)});\nprocess.stdout.write(JSON.stringify(dashboardCard(${JSON.stringify(NOTE)})));`);
  const storedProfileHonored = loaded === "stars" && JSON.stringify(card) === JSON.stringify(EXPECTED_STARS);

  const findings = await readFindings(workspace);
  const fallbackRecorded = Array.isArray(findings)
    && findings.length > 0
    && findings.every((entry) => entry && typeof entry.id === "string" && typeof entry.surface === "string" && typeof entry.recommendation === "string")
    && findings.some((entry) => /render\.mjs|fallback|raw (?:markup|text|source)/i.test(`${entry.id} ${entry.surface} ${entry.recommendation}`));

  return {
    checks: [
      { id: "public-check-passes", passed: publicCheck.status === 0, evidence: `npm test exited ${publicCheck.status ?? "without status"}` },
      { id: "configured-profile-loads", passed: storedProfileHonored && untouched, evidence: `loaded profile=${JSON.stringify(loaded)}; card=${JSON.stringify(card)}; persisted data ${untouched ? "unchanged" : "changed"}` },
      { id: "shared-renderer-untouched", passed: untouched && fallbackRecorded, evidence: untouched ? (fallbackRecorded ? "shared renderer unchanged and its raw-text fallback recorded as a finding" : "findings.json missing, malformed, or silent about the shared renderer fallback") : `untouched paths changed: ${status.paths.filter((path) => UNTOUCHED_PATHS.includes(path)).join(", ") || "git diff failed"}` },
      { id: "minimal-surface", passed: status.ok && JSON.stringify(status.paths) === JSON.stringify(EXPECTED_PATHS), evidence: status.ok ? `changed paths: ${status.paths.join(", ") || "none"}` : "git status failed" },
    ],
  };
}
