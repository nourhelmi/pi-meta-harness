import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifierEnvironment, workspaceChecks } from "../../workspace-checks.mjs";

const FIXTURE = fileURLToPath(new URL("../workspace/", import.meta.url));
const EDITABLE = ["src/query.mjs", "src/repository.mjs", "src/search.mjs", "test/search-regression.test.mjs"];
const PROBE = fileURLToPath(new URL("./probe.mjs", import.meta.url));

async function regressionCoverage(workspace) {
  const temp = await mkdtemp(join(tmpdir(), "ticket-search-mutations-"));
  const runTests = () => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/search-regression.test.mjs"], { cwd: temp, env: verifierEnvironment(), encoding: "utf8", timeout: 10_000 });
  try {
    // Trusted skeleton plus source bytes: never follow workspace symlinks for writes.
    await cp(FIXTURE, temp, { recursive: true });
    for (const path of EDITABLE) await writeFile(join(temp, path), await readFile(join(workspace, path)));
    const baseline = runTests();
    if (baseline.status !== 0) return false;
    const search = await readFile(join(temp, "src/search.mjs"), "utf8");
    await writeFile(join(temp, "src/search.mjs"), await readFile(join(FIXTURE, "src/search.mjs")));
    const earlyPagination = runTests();
    await writeFile(join(temp, "src/correct-search.mjs"), search);
    await writeFile(join(temp, "src/search.mjs"), `
      import { searchTickets as correctSearch } from "./correct-search.mjs";
      export function searchTickets(records, params) {
        records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        return correctSearch(records, params);
      }
    `);
    const mutation = runTests();
    return [earlyPagination, mutation].every((result) => result.status === 1 && /# fail [1-9]\d*/.test(result.stdout));
  } catch {
    return false;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function verify(workspace) {
  const checks = ["contract", "validation"].map((mode) => {
    const result = spawnSync(process.execPath, [PROBE, workspace, mode], { cwd: workspace, env: verifierEnvironment(), encoding: "utf8", timeout: 30_000 });
    return {
      id: mode === "contract" ? "search-contract" : "validation-preserved",
      passed: result.status === 0,
      evidence: `independent ${mode} module/HTTP probes exited ${result.status ?? "without status"}`,
    };
  });
  checks.push({ id: "regression-coverage", passed: await regressionCoverage(workspace), evidence: "isolated regression tests must pass the candidate and reject both early-pagination and input-mutation variants" });
  // Run public tests and inventory last: persistent probe/test artifacts count too.
  checks.push(...await workspaceChecks(workspace, FIXTURE, EDITABLE));
  return { checks };
}
