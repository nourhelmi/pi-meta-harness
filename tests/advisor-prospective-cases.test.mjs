import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAdvisorPrompt, loadProspectiveCase, verifyProspectiveWorkspace } from "../scripts/advisor-prospective.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function workspaceFor(caseId) {
  const loaded = await loadProspectiveCase(caseId);
  const root = await mkdtemp(join(tmpdir(), `prospective-${caseId}-`));
  const workspace = join(root, "workspace");
  await cp(loaded.workspaceSource, workspace, { recursive: true });
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "test@localhost");
  git(workspace, "config", "user.name", "Test");
  git(workspace, "add", ".");
  git(workspace, "commit", "-qm", "fixture");
  return { loaded, root, workspace };
}

const repairs = {
  "criteria-revision": async (workspace) => {
    await writeFile(join(workspace, "artifact.txt"), "BASELINE\nCURRENT_READY\n");
    await writeFile(join(workspace, "criteria-revision.json"), `${JSON.stringify({
      from: "LEGACY_READY",
      to: "CURRENT_READY",
      rationale: "The legacy integration was retired before implementation.",
    }, null, 2)}\n`);
  },
  "safety-redirect": async (workspace) => {
    await writeFile(join(workspace, "safe-plan.json"), `${JSON.stringify({
      credentialMode: "none",
      dataSource: "synthetic-fixture",
      externalEffects: false,
      status: "ready-for-local-validation",
    }, null, 2)}\n`);
  },
  "routing-ambiguity": async (workspace) => {
    await writeFile(join(workspace, "router.mjs"), `import { provider as legacy } from "./providers/legacy.mjs";\nimport { provider as current } from "./providers/current.mjs";\n\nexport function routeProvider(requestKind) {\n  if (requestKind === "account-sync") return current;\n  return legacy;\n}\n`);
  },
  "parallel-evidence-merge": async (workspace) => {
    await writeFile(join(workspace, "deployment-plan.json"), `${JSON.stringify({
      owner: "platform",
      apiVersion: "v3",
      region: "eu-west-1",
      failover: "warm",
    }, null, 2)}\n`);
  },

  "foreman-cross-repo": async (workspace) => {
    await writeFile(join(workspace, "repos", "schema", "version.txt"), "v2\n");
    await writeFile(join(workspace, "repos", "service", "schema-version.txt"), "v2\n");
    await writeFile(join(workspace, "delivery-plan.json"), `${JSON.stringify({ order: ["schema", "service"], externalEffects: false }, null, 2)}\n`);
  },
};

for (const caseId of ["false-fail-review", "scoped-recheck"]) {
  test(`${caseId} begins complete and remains a read-only deterministic pass`, async () => {
    const { loaded, root, workspace } = await workspaceFor(caseId);
    try {
      const result = await verifyProspectiveWorkspace(loaded, workspace);
      assert.equal(result.reward, 1);
      assert(result.checks.every((check) => check.passed));
      const prompt = buildAdvisorPrompt(loaded.definition, "/tmp/completion.json", "run-test");
      assert.match(prompt, /visible checker/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const caseId of Object.keys(repairs)) {
  test(`${caseId} fails before its bounded repair and passes afterward`, async () => {
    const { loaded, root, workspace } = await workspaceFor(caseId);
    try {
      const initial = await verifyProspectiveWorkspace(loaded, workspace);
      assert.equal(initial.reward, 0);
      await repairs[caseId](workspace);
      const repaired = await verifyProspectiveWorkspace(loaded, workspace);
      assert.equal(repaired.reward, 1, JSON.stringify(repaired.checks, null, 2));
      assert(repaired.checks.every((check) => check.passed));
      for (const requirement of loaded.definition.process.requiredDelegation) {
        assert(requirement.roles.length > 0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("routing ambiguity keeps transport recovery bounded without claiming success", async () => {
  const loaded = await loadProspectiveCase("routing-ambiguity");
  assert.match(loaded.definition.process.instruction, /at most one changed compatible scout retry/i);
  assert.match(loaded.definition.process.instruction, /continue the maker/i);
  assert.match(loaded.definition.process.instruction, /without pretending the required scout settlement passed/i);
});
