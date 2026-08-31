import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSuiteSetupSnapshot, summarizeSuiteResults } from "../scripts/advisor-prospective-manage.mjs";
import {
  candidateFingerprint,
  compareProspectiveArtifacts,
  comparisonMarkdown,
  parallelismDiagnostics,
  promoteProspectiveBaseline,
  scanProspectiveArtifacts,
} from "../scripts/advisor-prospective-results.mjs";

async function writeJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function artifact(id, passed, { events = 4, launches = 1, wallElapsedMs = 100 } = {}) {
  return {
    id,
    kind: "run",
    path: `/tmp/${id}`,
    manifest: {
      runId: id,
      case: { id: "case-a", title: "Case A" },
      candidate: { label: id, fingerprint: { algorithm: "test", value: id } },
    },
    result: {
      status: passed ? "passed" : "failed",
      reward: passed ? 1 : 0,
      checks: [{ id: "criterion", passed, evidence: passed ? "pass" : "fail" }],
    },
    diagnostics: {
      events,
      launches,
      elapsed: { wallElapsedMs, activeElapsedMs: wallElapsedMs - 10 },
      roleLaunches: { builder: launches },
      repetition: {},
      signals: {},
    },
  };
}

test("candidate fingerprint changes with managed setup content", async () => {
  const root = await mkdtemp(join(tmpdir(), "prospective-fingerprint-"));
  try {
    await mkdir(join(root, "skills"), { recursive: true });
    await writeFile(join(root, "skills", "advisor.md"), "first\n");
    await writeFile(join(root, "package.json"), "{}\n");
    const before = await candidateFingerprint(root);
    await writeFile(join(root, "skills", "advisor.md"), "second\n");
    const after = await candidateFingerprint(root);
    assert.equal(before.algorithm, "sha256-candidate-tree-v1");
    assert.notEqual(before.value, after.value);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("suite setup snapshot freezes setup, cases, and a committed pi-detach checkout", async () => {
  const temp = await mkdtemp(join(tmpdir(), "prospective-suite-snapshot-"));
  const source = join(temp, "source");
  const suiteDir = join(temp, "suite");
  const piDetach = join(temp, "pi-detach");
  try {
    await mkdir(join(source, "config"), { recursive: true });
    await mkdir(join(source, "evals", "prospective", "case-a"), { recursive: true });
    await writeFile(join(source, "config", "settings.overlay.json"), '{"packages":[]}\n');
    await writeFile(join(source, "evals", "prospective", "case-a", "case.json"), '{"id":"case-a"}\n');
    await mkdir(piDetach, { recursive: true });
    await writeFile(join(piDetach, "package.json"), '{"name":"pi-detach"}\n');
    git(piDetach, "init", "-q");
    git(piDetach, "config", "user.email", "test@localhost");
    git(piDetach, "config", "user.name", "Test");
    git(piDetach, "add", ".");
    git(piDetach, "commit", "-qm", "fixture");

    const snapshot = await createSuiteSetupSnapshot({ suiteDir, sourceRoot: source, piDetachSource: piDetach });
    assert.equal(snapshot.identity.candidateFingerprint.algorithm, "sha256-candidate-tree-plus-pi-detach-v1");
    assert.equal(snapshot.identity.evaluationFingerprint.algorithm, "sha256-prospective-suite-tree-v1");
    assert.match(snapshot.identity.piDetach.revision, /^[0-9a-f]{40}$/);
    assert.equal(await readFile(join(snapshot.root, "config", "settings.overlay.json"), "utf8"), '{"packages":[]}\n');
    assert.equal(await readFile(join(snapshot.piDetach.path, "package.json"), "utf8"), '{"name":"pi-detach"}\n');

    await writeFile(join(source, "config", "settings.overlay.json"), '{"changed":true}\n');
    assert.equal(await readFile(join(snapshot.root, "config", "settings.overlay.json"), "utf8"), '{"packages":[]}\n');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("comparison reports criterion regression and process deltas", () => {
  const comparison = compareProspectiveArtifacts(
    artifact("baseline", true, { events: 4, launches: 1, wallElapsedMs: 100 }),
    artifact("candidate", false, { events: 7, launches: 3, wallElapsedMs: 150 }),
  );
  assert.equal(comparison.verdict, "regressed");
  assert.equal(comparison.checks[0].change, "regressed");
  assert.equal(comparison.process.events.delta, 3);
  assert.equal(comparison.process.launches.delta, 2);
  assert.match(comparisonMarkdown(comparison), /REGRESSED/);
});

test("comparison reports mixed direction when shared checks move both ways", () => {
  const before = artifact("before", false);
  before.result.checks = [
    { id: "workspace-check", passed: false, evidence: "before" },
    { id: "checker-delegation", passed: true, evidence: "before" },
  ];
  const after = artifact("after", false);
  after.result.checks = [
    { id: "workspace-check", passed: true, evidence: "after" },
    { id: "checker-delegation", passed: false, evidence: "after" },
  ];
  const comparison = compareProspectiveArtifacts(before, after);
  assert.equal(comparison.verdict, "mixed");
  assert.equal(comparison.dimensions.workspace.verdict, "improved");
  assert.equal(comparison.dimensions.orchestration.verdict, "regressed");
});

test("comparison distinguishes removed checks from real regressions", () => {
  const before = artifact("before", false);
  before.result.checks = [
    { id: "criterion", passed: true, evidence: "shared pass" },
    { id: "lifecycle", passed: false, evidence: "old conditional failure" },
  ];
  const after = artifact("after", true);
  const comparison = compareProspectiveArtifacts(before, after);
  assert.equal(comparison.verdict, "unchanged");
  assert.equal(comparison.comparability.status, "changed");
  assert.deepEqual(comparison.comparability.removedChecks, ["lifecycle"]);
  assert.equal(comparison.checks.find((check) => check.id === "lifecycle")?.change, "removed");
  assert.deepEqual(comparison.dimensions.workspace.after, { passed: 1, total: 1, status: "passed" });
  assert.match(comparisonMarkdown(comparison), /Check contract: changed/);
});

test("comparison explains incomplete artifacts directly", () => {
  const incomplete = artifact("still-running", false);
  incomplete.result = undefined;
  assert.throws(
    () => compareProspectiveArtifacts(artifact("before", true), incomplete),
    /still incomplete: still-running/,
  );
});

test("parallelism diagnostics measure available useful width without rewarding fan-out", () => {
  const trace = {
    events: [
      { id: "e1", kind: "worker_launch", action: "launch", role: "scout", workerAlias: "w1", attemptAlias: "a1", timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "e2", kind: "worker_launch", action: "launch", role: "scout", workerAlias: "w2", attemptAlias: "a2", timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "e3", kind: "worker_status", workerAlias: "w1", attemptAlias: "a1", status: "successful", startedAt: "2026-01-01T00:00:01.000Z", endedAt: "2026-01-01T00:00:05.000Z", timestamp: "2026-01-01T00:00:05.000Z" },
      { id: "e4", kind: "worker_status", workerAlias: "w2", attemptAlias: "a2", status: "successful", startedAt: "2026-01-01T00:00:02.000Z", endedAt: "2026-01-01T00:00:06.000Z", timestamp: "2026-01-01T00:00:06.000Z" },
      { id: "e5", kind: "worker_launch", action: "launch", role: "builder", workerAlias: "w3", attemptAlias: "a3", timestamp: "2026-01-01T00:00:07.000Z" },
    ],
  };
  const diagnostics = parallelismDiagnostics(trace, {
    maxUsefulWidth: 2,
    roles: ["scout"],
    rationale: "two independent reads",
  });
  assert.equal(diagnostics.observedLaunchBatchWidth, 2);
  assert.equal(diagnostics.observedConcurrentWidth, 2);
  assert.equal(diagnostics.observedUsefulWidth, 2);
  assert.equal(diagnostics.successfulSettlements, 2);
  assert.equal(diagnostics.widthUtilization, 1);
  assert.equal(diagnostics.settlementCoverage, 1);
  assert.equal(diagnostics.status, "utilized");
});

test("suite summaries aggregate outcome dimensions and useful-width utilization", () => {
  const summary = summarizeSuiteResults([
    {
      result: {
        dimensions: {
          workspace: { passed: 4, total: 4, status: "passed" },
          orchestration: { passed: 2, total: 2, status: "passed" },
          measurement: { passed: 2, total: 2, status: "passed" },
        },
        parallelism: { status: "utilized", widthUtilization: 1 },
      },
    },
    {
      result: {
        dimensions: {
          workspace: { passed: 4, total: 4, status: "passed" },
          orchestration: { passed: 1, total: 2, status: "failed" },
          measurement: { passed: 2, total: 2, status: "passed" },
        },
        parallelism: { status: "underutilized", widthUtilization: 0.5 },
      },
    },
  ]);
  assert.deepEqual(summary.dimensions.workspace, { passed: 8, total: 8, cleanRuns: 2, runs: 2 });
  assert.equal(summary.dimensions.orchestration.cleanRuns, 1);
  assert.equal(summary.parallelism.utilizedRuns, 1);
  assert.equal(summary.parallelism.underutilizedRuns, 1);
  assert.equal(summary.parallelism.averageWidthUtilization, 0.75);
});

test("baseline promotion copies only privacy-safe result artifacts", async () => {
  const temp = await mkdtemp(join(tmpdir(), "prospective-baseline-"));
  const run = join(temp, "run");
  const baselines = join(temp, "baselines");
  try {
    await mkdir(join(run, "workspace"), { recursive: true });
    await mkdir(join(run, ".agent"), { recursive: true });
    await writeJson(join(run, "manifest.json"), {
      runId: "run-a",
      case: { id: "case-a", title: "Case A" },
      candidate: { label: "candidate-a" },
    });
    await writeJson(join(run, "result.json"), { status: "passed", reward: 1, checks: [] });
    await writeFile(join(run, "workspace", "secret.txt"), "workspace must not be promoted\n");
    await writeFile(join(run, ".agent", "auth.json"), "credential must not be promoted\n");

    const promoted = await promoteProspectiveBaseline(run, "approved", { baselineRoot: baselines });
    assert.equal(JSON.parse(await readFile(join(promoted.destination, "result.json"), "utf8")).reward, 1);
    await assert.rejects(readFile(join(promoted.destination, "workspace", "secret.txt")));
    await assert.rejects(readFile(join(promoted.destination, ".agent", "auth.json")));

    const scanned = await scanProspectiveArtifacts({ runsRoot: join(temp, "missing-runs"), baselinesRoot: baselines });
    assert.equal(scanned.baselines.length, 1);
    assert.equal(scanned.baselines[0].kind, "baseline");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
