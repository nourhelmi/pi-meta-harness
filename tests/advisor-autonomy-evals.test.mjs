import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAdvisorPrompt, loadProspectiveCase, processChecks, verifyProspectiveWorkspace } from "../scripts/advisor-prospective.mjs";
import { workspaceChecks } from "../evals/prospective/workspace-checks.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

const completion = { schemaVersion: 1, status: "completed" };
const repairs = {
  "advisor-direct-repair": ["settings.json", '{"retryLimit":3}\n'],
  "advisor-direct-capability": ["settings.json", '{"retryLimit":3}\n'],
  "advisor-plan-adaptation": ["src/delivery.mjs", 'import { retryBudget } from "./retry.mjs";\nexport function deliveryBudget(config) { return retryBudget(config.retryLimit); }\n'],
};

for (const [caseId, [path, repair]] of Object.entries(repairs)) {
  test(`${caseId} rejects broken, expanded, committed tampering, and missing fixtures`, async () => {
    const loaded = await loadProspectiveCase(caseId);
    const root = await mkdtemp(join(tmpdir(), "advisor-autonomy-"));
    const workspace = join(root, "workspace");
    try {
      await cp(loaded.workspaceSource, workspace, { recursive: true });
      git(workspace, "init", "-q");
      git(workspace, "config", "user.email", "test@localhost");
      git(workspace, "config", "user.name", "Test");
      git(workspace, "add", ".");
      git(workspace, "commit", "-qm", "fixture");
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 0);
      await writeFile(join(workspace, path), repair);
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 1);
      git(workspace, "add", ".");
      git(workspace, "commit", "-qm", "legitimate repair");
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 1, "a committed valid repair is still valid");

      await writeFile(join(workspace, "unexpected.txt"), "unrequested scope\n");
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 0);
      await appendFile(join(workspace, ".git/info/exclude"), "\nunexpected.txt\nignored/\n");
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 0, "repository-local ignore metadata must not hide expansion");
      await rm(join(workspace, "unexpected.txt"));
      await mkdir(join(workspace, "ignored"));
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 0, "even an ignored empty directory is outside the packet");
      await rm(join(workspace, "ignored"), { recursive: true });

      const originalMode = (await stat(join(workspace, path))).mode & 0o777;
      await chmod(join(workspace, path), originalMode ^ 0o111);
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 0, "editable content does not authorize changing executable modes");
      await chmod(join(workspace, path), originalMode);
      await rm(join(workspace, "contract.json"));
      await symlink(join(loaded.workspaceSource, "contract.json"), join(workspace, "contract.json"));
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 0, "byte-equivalent symlinks do not preserve a file's identity");
      await rm(join(workspace, "contract.json"));
      await cp(join(loaded.workspaceSource, "contract.json"), join(workspace, "contract.json"));

      const contract = await readFile(join(workspace, "contract.json"), "utf8");
      await writeFile(join(workspace, "contract.json"), `${contract}\n`);
      git(workspace, "add", ".");
      git(workspace, "commit", "-qm", "tampered contract");
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 0, "committing must not launder protected-file changes");
      await writeFile(join(workspace, "contract.json"), contract);
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 1);

      if (caseId === "advisor-plan-adaptation") {
        await writeFile(join(workspace, "src/retry.mjs"), "export function retryBudget(limit = 3) { return limit; }\n");
        assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 0, "following the stale planner must fail");
        await cp(join(loaded.workspaceSource, "src/retry.mjs"), join(workspace, "src/retry.mjs"));
        await writeFile(join(workspace, path), 'export function deliveryBudget() { return 3; }\n');
        assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 0, "a hard-coded observed value is not a repair");
        await writeFile(join(workspace, path), repair);
      }
      await rm(join(workspace, "contract.json"));
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 0, "missing evidence fails closed without crashing grading");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  if (caseId === "advisor-direct-capability") continue;
  test(`${caseId} accepts direct or one cohesive maker without imposing a role recipe`, async () => {
    const { definition } = await loadProspectiveCase(caseId);
    const prompt = buildAdvisorPrompt(definition, "/tmp/completion.json", "autonomy-test");
    assert.match(prompt, /choose direct execution or useful delegation/);
    assert.doesNotMatch(prompt, /must not implement|must implement|allowedRoles|maximumSuccessfulWorkers/);
    assert(processChecks({ events: [] }, completion, definition).every((check) => check.passed));
    for (const role of ["builder", "advisor", "foreman"]) {
      const events = [
        { kind: "worker_launch", role, attemptAlias: "maker-1" },
        { kind: "worker_status", role, attemptAlias: "maker-1", status: "successful" },
      ];
      assert(processChecks({ events }, completion, definition).every((check) => check.passed), `${role} is a legitimate owner`);
      events.push({ kind: "worker_status", role, attemptAlias: "maker-2", status: "successful" });
      assert.equal(processChecks({ events }, completion, definition).find((check) => check.id === "orchestration-successful-worker-budget").passed, false);
    }
    for (const role of ["scout", "planner", "checker", "reducer", "browser-verifier"]) {
      const events = [{ kind: "worker_launch", role }];
      assert.equal(processChecks({ events }, completion, definition).find((check) => check.id === "orchestration-allowed-roles").passed, false);
    }
    assert.equal(processChecks(undefined, completion, definition).find((check) => check.id === "root-trajectory").passed, false);
  });
}

test("direct execution is required only by the explicitly requested capability exercise", async () => {
  const { definition } = await loadProspectiveCase("advisor-direct-capability");
  const prompt = buildAdvisorPrompt(definition, "/tmp/completion.json", "capability-test");
  assert.match(prompt, /explicit direct-execution capability exercise, not a routing preference test/);
  assert.match(prompt, /root advisor session yourself, without launching helper agents/);
  assert(processChecks({ events: [] }, completion, definition).every((check) => check.passed));
  const checks = processChecks({ events: [{ kind: "worker_launch", role: "builder" }] }, completion, definition);
  assert.equal(checks.find((check) => check.id === "orchestration-allowed-roles").passed, false);
});

test("absence of a capability requirement never invents mandatory delegation", () => {
  assert.deepEqual(processChecks({ events: [] }, completion, {}).map((check) => check.id), ["completion-signal", "root-trajectory"]);
  const required = processChecks({ events: [] }, completion, {
    process: { requiredDelegation: [{ id: "checker-delegation", roles: ["checker"], minimum: 1 }] },
  });
  assert.equal(required.find((check) => check.id === "checker-delegation").passed, false);
});

test("empty allowed roles means no helpers, but order constraints still need non-empty roles", async () => {
  const loaded = await loadProspectiveCase("advisor-direct-capability");
  const root = await mkdtemp(join(tmpdir(), "advisor-autonomy-schema-"));
  const caseDir = join(root, loaded.definition.id);
  try {
    await cp(loaded.caseDir, caseDir, { recursive: true });
    loaded.definition.process.topology.requiredOrder = [{ id: "invalid-order", beforeRoles: [], afterRoles: ["checker"] }];
    await writeFile(join(caseDir, "case.json"), JSON.stringify(loaded.definition));
    await assert.rejects(loadProspectiveCase(caseDir), /non-empty array/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scope inventory runs after the public check and includes ignored test-created files", async () => {
  const root = await mkdtemp(join(tmpdir(), "advisor-post-test-inventory-"));
  const fixture = join(root, "fixture");
  const workspace = join(root, "workspace");
  try {
    await mkdir(fixture);
    await writeFile(join(fixture, "settings.json"), '{"retryLimit":2}\n');
    await writeFile(join(fixture, "package.json"), JSON.stringify({ scripts: { test: "node verify.mjs" } }));
    await writeFile(join(fixture, "verify.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("generated.txt", "out of scope");\n');
    await cp(fixture, workspace, { recursive: true });
    git(workspace, "init", "-q");
    await appendFile(join(workspace, ".git/info/exclude"), "\ngenerated.txt\n");
    await writeFile(join(workspace, "settings.json"), '{"retryLimit":3}\n');
    const checks = await workspaceChecks(workspace, fixture, ["settings.json"]);
    assert.equal(checks.find((check) => check.id === "public-check-passes").passed, true);
    assert.equal(checks.find((check) => check.id === "bounded-surface").passed, false);
    assert.match(checks.find((check) => check.id === "bounded-surface").evidence, /generated.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
