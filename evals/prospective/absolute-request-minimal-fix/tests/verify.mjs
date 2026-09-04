import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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

/**
 * Render the sample note in a fresh Node process so the workspace's current
 * module bytes are used rather than an earlier cached import.
 */
function renderCard(workspace, note) {
  const dashboard = pathToFileURL(join(workspace, "src", "dashboard.mjs")).href;
  const script = `const { dashboardCard } = await import(${JSON.stringify(dashboard)});\nprocess.stdout.write(JSON.stringify(dashboardCard(${JSON.stringify(note)})));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

const SHARED_PATHS = ["contract.json", "renderer-config.json", "src/config.mjs", "src/history.mjs", "src/render.mjs"];
const NOTE = { title: "Sum of [b]halves[/b]", description: "Divide [b]three[/b] by [i]four[/i]" };
const EXPECTED = {
  stars: { title: "Sum of *halves*", description: "Divide *three* by _four_" },
  caps: { title: "Sum of HALVES", description: "Divide THREE by /four/" },
};

export async function verify(workspace) {
  const publicCheck = command("npm", ["test", "--silent"], workspace);
  const before = changedPathsOf(workspace);
  const sharedDiff = command("git", ["diff", "--quiet", "HEAD", "--", ...SHARED_PATHS], workspace);
  const sharedUntouched = sharedDiff.status === 0 && before.paths.every((path) => !SHARED_PATHS.includes(path));

  // The persisted profile is swapped to the second supported renderer only for
  // the duration of one fresh render, then restored byte-for-byte.
  const configPath = join(workspace, "renderer-config.json");
  const originalConfig = await readFile(configPath, "utf8");
  const storedRender = renderCard(workspace, NOTE);
  let alternateRender;
  try {
    await writeFile(configPath, `${JSON.stringify({ profile: "caps", updatedAt: "2026-01-01T00:00:00.000Z" }, null, 2)}\n`, "utf8");
    alternateRender = renderCard(workspace, NOTE);
  } finally {
    await writeFile(configPath, originalConfig, "utf8");
  }
  const after = changedPathsOf(workspace);
  const honorsProfile = JSON.stringify(storedRender) === JSON.stringify(EXPECTED.stars)
    && JSON.stringify(alternateRender) === JSON.stringify(EXPECTED.caps);

  return {
    checks: [
      { id: "public-check-passes", passed: publicCheck.status === 0, evidence: `npm test exited ${publicCheck.status ?? "without status"}` },
      { id: "configured-renderer-honored", passed: honorsProfile, evidence: honorsProfile ? "stored profile and a swapped profile both rendered the dashboard card" : `stored=${JSON.stringify(storedRender)}; swapped=${JSON.stringify(alternateRender)}` },
      { id: "shared-behavior-preserved", passed: sharedUntouched, evidence: sharedUntouched ? "shared renderer, configuration, history, and persisted data are byte-identical" : `shared paths changed: ${before.paths.filter((path) => SHARED_PATHS.includes(path)).join(", ") || "git diff failed"}` },
      { id: "minimal-surface", passed: before.ok && after.ok && JSON.stringify(before.paths) === JSON.stringify(["src/dashboard.mjs"]) && JSON.stringify(after.paths) === JSON.stringify(before.paths), evidence: before.ok ? `changed paths: ${before.paths.join(", ") || "none"}` : "git status failed" },
    ],
  };
}
