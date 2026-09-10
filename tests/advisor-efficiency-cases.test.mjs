import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProspectiveCase, processChecks, verifyProspectiveWorkspace } from "../scripts/advisor-prospective.mjs";
import { summarizeResultDimensions } from "../scripts/advisor-prospective-results.mjs";

const completion = { schemaVersion: 1, status: "completed" };
const fixedRecords = `export function listRecords(request, resource, rows, { offset = 0, limit = 2 } = {}) {
  const allowed = Boolean(request?.tenantId && request?.userId && resource?.tenantId && resource?.ownerId)
    && request.tenantId === resource.tenantId
    && request.userId === resource.ownerId;
  if (!allowed) return { status: 403, records: [] };
  return { status: 200, records: rows.slice(offset, offset + limit) };
}
`;
const fixedExpiry = `import { hasElapsed } from "./boundary.mjs";

export function isExpired(issuedAtMs, nowMs, ttlSeconds) {
  return hasElapsed(nowMs - issuedAtMs, ttlSeconds * 1000);
}
`;
const fixedBoundary = `// Shared boundary policy; see contract.json. Report findings before expanding scope.
export function hasElapsed(elapsedMs, ttlMs) {
  return elapsedMs >= ttlMs;
}
`;
const fixedSettings = '{"retryLimit":3,"lintEngine":"portable"}\n';
const repairs = {
  "builder-environment-obstacle": {
    "settings.json": fixedSettings,
    "deviations.json": '[{"what":"Selected portable lint instead of optional-lint-engine","why":"The optional native engine is absent; README sanctions the Node fallback."}]\n',
  },
  "checker-repairs-inline": {
    "records.mjs": fixedRecords,
    "checker-note.md": "# PASS after inline repair\n\nHigh: exact tenant comparison prevents disclosure. Medium: corrected page end and 403 denial code. Public and direct contract probes pass.\n",
  },
  "repair-loop-convergence": {
    "src/expiry.mjs": fixedExpiry,
    "src/boundary.mjs": fixedBoundary,
    "checker-note.md": "# PASS after delta review\n\nFirst review reported equality failing in excluded src/boundary.mjs. Original maker repaired >= in the authorized round; same checker verified the delta and adjacent units.\n",
  },
};
const mutants = {
  "builder-environment-obstacle": [
    ["settings.json", '{"retryLimit":2,"lintEngine":"portable"}\n', "retry-limit-aligned"],
    ["settings.json", '{"retryLimit":3,"lintEngine":"native"}\n', "public-check-passes"],
    ["deviations.json", "[]\n", "workaround-recorded"],
    ["deviations.json", '[{"what":"changed config","why":"local fix"}]\n', "workaround-recorded"],
    ["deviations.json", '[{"what":"optional-lint-engine","why":""}]\n', "workaround-recorded"],
    ["deviations.json", "not JSON\n", "workaround-recorded"],
  ],
  "checker-repairs-inline": [
    ["records.mjs", fixedRecords.replace("request.tenantId === resource.tenantId", "request.tenantId.toLowerCase() === resource.tenantId.toLowerCase()"), "exact-tenant-boundary"],
    ["records.mjs", fixedRecords.replace("offset + limit)", "offset + limit + 1)"), "exact-page-size"],
    ["records.mjs", fixedRecords.replace("status: 403", "status: 401"), "forbidden-error-code"],
  ],
  "repair-loop-convergence": [
    ["src/expiry.mjs", fixedExpiry.replace("ttlSeconds * 1000", "ttlSeconds"), "seconds-converted"],
    ["src/boundary.mjs", fixedBoundary.replace("elapsedMs >= ttlMs", "elapsedMs > ttlMs"), "inclusive-boundary"],
  ],
};

function git(workspace, ...args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(caseId, callback) {
  const loaded = await loadProspectiveCase(caseId);
  const root = await mkdtemp(join(tmpdir(), `efficiency-${caseId}-`));
  const workspace = join(root, "workspace");
  try {
    await cp(loaded.workspaceSource, workspace, { recursive: true });
    git(workspace, "init", "-q");
    git(workspace, "config", "user.email", "test@localhost");
    git(workspace, "config", "user.name", "Test");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "fixture");
    await callback(loaded, workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function repair(caseId, workspace) {
  for (const [path, source] of Object.entries(repairs[caseId])) await writeFile(join(workspace, path), source);
}

function passed(result, id) {
  const check = result.checks.find((item) => item.id === id);
  assert(check, `missing check ${id}`);
  return check.passed;
}

for (const caseId of Object.keys(repairs)) {
  test(`${caseId}: loader, untouched failure, exact repair, each defect, and scope inventory`, async () => {
    await fixture(caseId, async (loaded, workspace) => {
      const initial = await verifyProspectiveWorkspace(loaded, workspace);
      assert.equal(initial.reward, 0);
      assert.equal(passed(initial, "public-check-passes"), caseId === "checker-repairs-inline");
      for (const criterion of loaded.definition.acceptance) {
        assert(initial.checks.some((check) => check.id === criterion.id), `missing acceptance oracle ${criterion.id}`);
      }
      if (caseId === "checker-repairs-inline") {
        for (const id of ["exact-tenant-boundary", "exact-page-size", "forbidden-error-code"]) assert.equal(passed(initial, id), false);
      }
      await repair(caseId, workspace);
      const repaired = await verifyProspectiveWorkspace(loaded, workspace);
      assert.equal(repaired.reward, 1, JSON.stringify(repaired.checks));
      for (const [path, source, checkId] of mutants[caseId]) {
        await writeFile(join(workspace, path), source);
        const mutant = await verifyProspectiveWorkspace(loaded, workspace);
        assert.equal(mutant.reward, 0, `${checkId} must reject its single remaining defect`);
        assert.equal(passed(mutant, checkId), false, checkId);
        assert.equal(passed(mutant, "bounded-surface"), true, "failure must be behavioral, not scope");
        if (caseId === "checker-repairs-inline") {
          assert.equal(passed(mutant, "public-check-passes"), true, "all three individual defects evade the maker smoke test");
          assert.deepEqual(mutant.checks.filter((check) => !check.passed).map((check) => check.id), [checkId]);
        }
        await repair(caseId, workspace);
      }
      if (caseId === "builder-environment-obstacle") {
        await rm(join(workspace, "deviations.json"));
        assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 0, "missing deviations fail closed");
        await repair(caseId, workspace);
      }
      // Git history and ignored files cannot launder edits past the external inventory.
      git(workspace, "add", ".");
      git(workspace, "commit", "-qm", "legitimate repair");
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 1);
      await writeFile(join(workspace, "extra.txt"), "outside the reviewed surface\n");
      assert.equal(passed(await verifyProspectiveWorkspace(loaded, workspace), "bounded-surface"), false);
      await appendFile(join(workspace, ".git/info/exclude"), "\nextra.txt\n");
      git(workspace, "check-ignore", "extra.txt");
      const ignored = await verifyProspectiveWorkspace(loaded, workspace);
      assert.equal(ignored.reward, 0, "ignored extra files still fail");
      assert.equal(passed(ignored, "bounded-surface"), false);
      assert.equal(passed(ignored, "public-check-passes"), true);
      await rm(join(workspace, "extra.txt"));
      const packagePath = join(workspace, "package.json");
      const original = await readFile(packagePath, "utf8");
      await writeFile(packagePath, `${original}\n`);
      const expanded = await verifyProspectiveWorkspace(loaded, workspace);
      assert.equal(expanded.reward, 0, "even harmless edits to a protected file fail scope");
      assert.equal(passed(expanded, "public-check-passes"), true);
      await writeFile(packagePath, original);
      assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 1);
    });
  });
}

test("environment workaround does not bypass configuration or lint", async () => {
  await fixture("builder-environment-obstacle", async (loaded, workspace) => {
    // Config-only repair reveals the absent optional engine, not another config failure.
    await writeFile(join(workspace, "settings.json"), '{"retryLimit":3,"lintEngine":"native"}\n');
    const lint = spawnSync(process.execPath, ["lint.mjs"], { cwd: workspace, encoding: "utf8" });
    assert.notEqual(lint.status, 0);
    assert.match(lint.stderr, /optional-lint-engine/);
    await repair(loaded.definition.id, workspace);
    await writeFile(join(workspace, "settings.json"), '{\n\t"retryLimit":3,"lintEngine":"portable"\n}\n');
    assert.equal(passed(await verifyProspectiveWorkspace(loaded, workspace), "public-check-passes"), false, "portable mode still lints");
  });
});

test("initial expiry-only repair passes public units but leaves the report-only boundary failing", async () => {
  await fixture("repair-loop-convergence", async (loaded, workspace) => {
    await writeFile(join(workspace, "src/expiry.mjs"), fixedExpiry);
    const firstRound = await verifyProspectiveWorkspace(loaded, workspace);
    assert.equal(firstRound.reward, 0);
    assert.equal(passed(firstRound, "public-check-passes"), true);
    assert.equal(passed(firstRound, "seconds-converted"), true);
    assert.equal(passed(firstRound, "inclusive-boundary"), false);
    await writeFile(join(workspace, "src/boundary.mjs"), fixedBoundary);
    assert.equal((await verifyProspectiveWorkspace(loaded, workspace)).reward, 1);
  });
});

function attempt(role, workerAlias, attemptAlias, action = "launch") {
  const identity = { role, workerAlias, attemptAlias };
  return [
    { kind: "worker_launch", ...identity, action },
    { kind: "worker_launch_result", ...identity, status: "running" },
    { kind: "worker_status", ...identity, status: "successful" },
  ];
}

function sequenceCheck(definition, events) {
  return processChecks(events === undefined ? undefined : { events }, completion, definition)
    .find((check) => check.id === "orchestration-worker-sequence");
}

test("checker alone passes orchestration; read-only checker followed by builder fails that dimension", async () => {
  const { definition } = await loadProspectiveCase("checker-repairs-inline");
  const events = attempt("checker", "worker-1", "attempt-1");
  const alone = processChecks({ events }, completion, definition);
  assert(alone.every((check) => check.passed));
  assert.equal(summarizeResultDimensions({ checks: alone }).orchestration.status, "passed");
  events.push(...attempt("builder", "worker-2", "attempt-2"));
  const handoff = processChecks({ events }, completion, definition);
  assert.equal(handoff.find((check) => check.id === "orchestration-allowed-roles").passed, false);
  assert.equal(handoff.find((check) => check.id === "orchestration-successful-worker-budget").passed, false);
  assert.equal(summarizeResultDimensions({ checks: handoff }).orchestration.status, "failed");
});

test("environment obstacle accepts either maker but rejects blocking, questions, and extra launches", async () => {
  const { definition } = await loadProspectiveCase("builder-environment-obstacle");
  for (const role of ["builder", "advisor", "foreman"]) {
    const events = attempt(role, "worker-1", "attempt-1");
    assert(processChecks({ events }, completion, definition).every((check) => check.passed));
    const blocked = structuredClone(events);
    blocked.splice(2, 0, { ...events[2], status: "blocked" });
    assert.equal(sequenceCheck(definition, blocked).passed, false, "success cannot erase a blocked settlement");
    const questions = [...events, { kind: "tool_call", toolName: "ask_user_question" }];
    assert.equal(processChecks({ events: questions }, completion, definition).find((check) => check.id === "orchestration-user-question-budget").passed, false);
    assert.equal(sequenceCheck(definition, [...events, ...attempt(role, "worker-2", "attempt-2")]).passed, false);
    assert.equal(processChecks({ events }, { schemaVersion: 1, status: "blocked" }, definition).find((check) => check.id === "completion-signal").passed, false);
  }
});

test("one repair round requires serial successful attempts and resumes of both original identities", async () => {
  const { definition } = await loadProspectiveCase("repair-loop-convergence");
  const events = [
    ...attempt("builder", "maker", "a1"),
    ...attempt("checker", "reviewer", "a2"),
    ...attempt("builder", "maker", "a3", "resume"),
    ...attempt("checker", "reviewer", "a4", "resume"),
  ];
  assert(processChecks({ events }, completion, definition).every((check) => check.passed));
  const variants = {
    "fresh checker instead of resume": (copy) => { copy[9].action = "launch"; },
    "new checker identity disguised as resume": (copy) => { for (const event of copy.slice(9)) event.workerAlias = "new-reviewer"; },
    "new maker identity disguised as resume": (copy) => { for (const event of copy.slice(6, 9)) event.workerAlias = "new-maker"; },
    "missing worker identity": (copy) => { delete copy[9].workerAlias; },
    "duplicate attempt identity": (copy) => { for (const event of copy.slice(9)) event.attemptAlias = "a2"; },
    "maker and checker share identity": (copy) => { for (const event of copy) event.workerAlias = "one-worker"; },
    "repair starts before review settles": (copy) => { [copy[5], copy[6]] = [copy[6], copy[5]]; },
    "second review never settles": (copy) => { copy.pop(); },
    "second review blocked": (copy) => { copy[11].status = "blocked"; },
    "extra repair round": (copy) => { copy.push(...attempt("builder", "maker", "a5", "resume")); },
    "only one review": (copy) => { copy.splice(9); },
  };
  for (const [label, mutate] of Object.entries(variants)) {
    const copy = structuredClone(events);
    mutate(copy);
    assert.equal(sequenceCheck(definition, copy).passed, false, label);
  }
  assert.equal(sequenceCheck(definition, undefined).passed, false);
  assert.equal(sequenceCheck(definition, []).passed, false);
  const duplicateNotices = events.flatMap((event) => event.kind === "worker_status" ? [event, { ...event }] : [event]);
  assert(processChecks({ events: duplicateNotices }, completion, definition).every((check) => check.passed), "duplicate success notices do not create new workers or rounds");
  const immediate = events.filter((event) => event.kind !== "worker_launch_result").map((event) =>
    event.kind === "worker_status" ? { ...event, kind: "worker_launch_result" } : event);
  assert.equal(sequenceCheck(definition, immediate).passed, true, "foreground successful launch results also settle attempts");
});

test("worker sequence is opt-in and malformed policies fail closed without changing old checks", () => {
  assert.deepEqual(processChecks({ events: [] }, completion, {}).map((check) => check.id), ["completion-signal", "root-trajectory"]);
  for (const requiredWorkerSequence of [null, {}, [], [null], [{ roles: [], action: "launch" }], [{ roles: ["checker"], action: "retry" }]]) {
    assert.equal(sequenceCheck({ process: { requiredWorkerSequence } }, []).passed, false);
  }
});
