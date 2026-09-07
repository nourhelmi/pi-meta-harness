import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSuiteSetupSnapshot, summarizeSuiteResults } from "../scripts/advisor-prospective-manage.mjs";
import {
  candidateFingerprint,
  prospectiveSuiteFingerprint,
  compareProspectiveArtifacts,
  comparisonMarkdown,
  parallelismDiagnostics,
  promoteProspectiveBaseline,
  prospectiveCheckDimension,
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
      evaluation: { fingerprint: { algorithm: "sha256-prospective-evaluator-tree-v2", value: "e".repeat(64) } },
    },
    result: {
      status: passed ? "passed" : "failed",
      reward: passed ? 1 : 0,
      checks: [{ id: "criterion", passed, evidence: passed ? "pass" : "fail" }],
      process: { launches },
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
    assert.equal(snapshot.identity.evaluationFingerprint.algorithm, "sha256-prospective-evaluator-tree-v2");
    assert.match(snapshot.identity.piDetach.revision, /^[0-9a-f]{40}$/);
    assert.equal(await readFile(join(snapshot.root, "config", "settings.overlay.json"), "utf8"), '{"packages":[]}\n');
    assert.equal(await readFile(join(snapshot.piDetach.path, "package.json"), "utf8"), '{"name":"pi-detach"}\n');

    await writeFile(join(source, "config", "settings.overlay.json"), '{"changed":true}\n');
    assert.equal(await readFile(join(snapshot.root, "config", "settings.overlay.json"), "utf8"), '{"packages":[]}\n');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("real suite snapshot installs all current runtime and host-binding dependencies", async () => {
  const temp = await mkdtemp(join(tmpdir(), "prospective-real-snapshot-"));
  try {
    const snapshot = await createSuiteSetupSnapshot({ suiteDir: join(temp, "suite"), piDetachSource: undefined });
    const target = join(temp, "agent");
    const installed = spawnSync(process.execPath, [join(snapshot.root, "scripts/meta-harness.mjs"), "install", "--target", target], { encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    for (const path of ["scripts/advisor-core/advisor-state.mjs", "advisor-hosts/scripts/codex-advisor-trace.mjs", "advisor-hosts/scripts/claude-advisor-trace.mjs"]) {
      assert((await readFile(join(target, path), "utf8")).length > 0, path);
    }
    const runner = spawnSync(process.execPath, [join(snapshot.root, "scripts/advisor-prospective-manage.mjs"), "help"], { encoding: "utf8" });
    assert.equal(runner.status, 0, runner.stderr);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("evaluator identity is independent of doctrine but changes with case and grader inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "prospective-evaluator-fingerprint-"));
  try {
    await mkdir(join(root, "skills"));
    await mkdir(join(root, "evals/prospective"), { recursive: true });
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "skills/advisor.md"), "before");
    const before = await prospectiveSuiteFingerprint(root);
    await writeFile(join(root, "skills/advisor.md"), "after");
    assert.deepEqual(await prospectiveSuiteFingerprint(root), before);
    await writeFile(join(root, "evals/prospective/case.json"), "new case");
    const casesChanged = await prospectiveSuiteFingerprint(root);
    assert.notEqual(casesChanged.value, before.value);
    await writeFile(join(root, "scripts/advisor-prospective.mjs"), "new grader");
    const graderChanged = await prospectiveSuiteFingerprint(root);
    assert.notEqual(graderChanged.value, casesChanged.value);
    await writeFile(join(root, "scripts/advisor-prospective-metrics.mjs"), "new measurement");
    assert.notEqual((await prospectiveSuiteFingerprint(root)).value, graderChanged.value);
  } finally {
    await rm(root, { recursive: true, force: true });
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

test("comparison includes before/after process deltas without rewarding them or zero-filling legacy results", () => {
  const before = artifact("before", true);
  const after = artifact("after", true);
  const fields = ["launches", "blockedSettlements", "repairRounds", "compactions"];
  before.result.process = Object.fromEntries(fields.map((field) => [field, 3]));
  after.result.process = { ...Object.fromEntries(fields.map((field) => [field, 1])), postCompactionFloorTokens: [90_000] };
  const comparison = compareProspectiveArtifacts(before, after);
  for (const field of fields) {
    assert.deepEqual(comparison.process[field], { before: 3, after: 1, delta: -2 });
    assert.match(comparisonMarkdown(comparison), new RegExp(`${field}: 3 → 1 \\(-2\\)`));
  }
  assert.equal(comparison.verdict, "unchanged");
  assert.equal(comparison.before.reward, 1);
  assert.equal(comparison.after.reward, 1);
  delete before.result.process;
  const legacy = compareProspectiveArtifacts(before, after);
  for (const field of fields) assert.deepEqual(legacy.process[field], { before: null, after: 1, delta: null });
  assert.deepEqual(legacy.process.postCompactionFloorTokens, { before: null, after: [90_000] });
  assert.match(comparisonMarkdown(legacy), /launches: — → 1 \(—\)/);
  delete after.result.process;
  for (const field of fields) assert.deepEqual(compareProspectiveArtifacts(before, after).process[field], { before: null, after: null, delta: null });
});

test("compare CLI loads a legacy result and prints process deltas in JSON and Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "prospective-compare-process-"));
  try {
    for (const id of ["before", "after"]) {
      const value = artifact(id, true);
      value.result.process = id === "before" ? undefined : { launches: 2, blockedSettlements: 1, repairRounds: 1, compactions: 1 };
      await writeJson(join(root, id, "manifest.json"), value.manifest);
      await writeJson(join(root, id, "result.json"), value.result);
    }
    const args = ["scripts/advisor-prospective-manage.mjs", "compare", join(root, "before"), join(root, "after")];
    const json = spawnSync(process.execPath, [...args, "--json"], { encoding: "utf8" });
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).process.launches, { before: null, after: 2, delta: null });
    const markdown = spawnSync(process.execPath, [...args, "--format", "markdown"], { encoding: "utf8" });
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /blockedSettlements: — → 1 \(—\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("comparison rejects missing, blank, changed, or differently versioned evaluator identity", () => {
  const valid = artifact("before", true);
  for (const fingerprint of [undefined, {}, { algorithm: "", value: "" },
    { algorithm: "sha256-prospective-evaluator-tree-v2", value: "different" },
    { algorithm: "sha256-prospective-suite-tree-v1", value: "e".repeat(64) }]) {
    const other = artifact("after", true);
    other.manifest.evaluation = { fingerprint };
    assert.throws(() => compareProspectiveArtifacts(valid, other), /evaluator fingerprints/);
    assert.throws(() => compareProspectiveArtifacts(other, valid), /evaluator fingerprints/);
  }
  assert.equal(compareProspectiveArtifacts(valid, artifact("after", true)).comparability.status, "same");
});

test("comparison CLI fails visibly on evaluator mismatch without rewriting artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "prospective-compare-evaluator-"));
  try {
    for (const id of ["before", "after"]) {
      const value = artifact(id, true);
      value.manifest.evaluation.fingerprint.value = id;
      await writeJson(join(root, id, "manifest.json"), value.manifest);
      await writeJson(join(root, id, "result.json"), value.result);
    }
    const resultPath = join(root, "before", "result.json");
    const prior = await readFile(resultPath, "utf8");
    const command = spawnSync(process.execPath, ["scripts/advisor-prospective-manage.mjs", "compare", join(root, "before"), join(root, "after")], { encoding: "utf8" });
    assert.equal(command.status, 1);
    assert.match(command.stderr, /different evaluator fingerprints/);
    assert.equal(await readFile(resultPath, "utf8"), prior);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      evaluation: {
        fingerprint: { algorithm: "sha256-prospective-suite-tree-v1", value: "evaluator-a" },
      },
    });
    await writeJson(join(run, "result.json"), { status: "passed", reward: 1, checks: [] });
    await writeFile(join(run, "workspace", "secret.txt"), "workspace must not be promoted\n");
    await writeFile(join(run, ".agent", "auth.json"), "credential must not be promoted\n");

    const promoted = await promoteProspectiveBaseline(run, "approved", { baselineRoot: baselines });
    assert.equal(JSON.parse(await readFile(join(promoted.destination, "result.json"), "utf8")).reward, 1);
    const copiedManifest = JSON.parse(await readFile(join(promoted.destination, "manifest.json"), "utf8"));
    assert.equal(copiedManifest.evaluation.fingerprint.value, "evaluator-a");
    assert.equal(promoted.baseline.evaluationFingerprint.value, "evaluator-a");
    await assert.rejects(readFile(join(promoted.destination, "workspace", "secret.txt")));
    await assert.rejects(readFile(join(promoted.destination, ".agent", "auth.json")));

    const scanned = await scanProspectiveArtifacts({ runsRoot: join(temp, "missing-runs"), baselinesRoot: baselines });
    assert.equal(scanned.baselines.length, 1);
    assert.equal(scanned.baselines[0].kind, "baseline");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("failed routing baselines require explicit promotion and clean workspace and measurement dimensions", async () => {
  const temp = await mkdtemp(join(tmpdir(), "prospective-failed-baseline-"));
  const run = join(temp, "run");
  const baselines = join(temp, "baselines");
  try {
    await writeJson(join(run, "manifest.json"), {
      runId: "run-routing-before",
      case: { id: "single-maker-fast-path", title: "Single maker fast path" },
      candidate: { label: "before" },
    });
    await writeJson(join(run, "result.json"), {
      status: "failed",
      reward: 0,
      checks: [
        { id: "public-check-passes", passed: true, evidence: "passed" },
        { id: "completion-signal", passed: true, evidence: "completed" },
        { id: "orchestration-allowed-roles", passed: false, evidence: "checker was unnecessary" },
        { id: "root-trajectory", passed: true, evidence: "available" },
        { id: "lifecycle", passed: true, evidence: "settled" },
      ],
    });
    await assert.rejects(
      promoteProspectiveBaseline(run, "before", { baselineRoot: baselines }),
      /unless --allow-failed is explicit/,
    );
    const promoted = await promoteProspectiveBaseline(run, "before", {
      allowFailed: true,
      baselineRoot: baselines,
    });
    assert.equal(promoted.baseline.sourceStatus, "failed");
    assert.equal(promoted.baseline.admission, "explicit-failed-orchestration");
    assert.equal(prospectiveCheckDimension("orchestration-allowed-roles"), "orchestration");

    await writeJson(join(run, "result.json"), {
      status: "failed",
      reward: 0,
      dimensions: {
        workspace: { passed: 1, total: 1, status: "passed" },
        orchestration: { passed: 0, total: 1, status: "failed" },
        measurement: { passed: 2, total: 2, status: "passed" },
      },
      checks: [
        { id: "public-check-passes", passed: false, evidence: "failed" },
        { id: "orchestration-allowed-roles", passed: false, evidence: "failed" },
        { id: "root-trajectory", passed: false, evidence: "missing" },
        { id: "lifecycle", passed: true, evidence: "settled" },
      ],
    });
    await assert.rejects(
      promoteProspectiveBaseline(run, "forged", { allowFailed: true, baselineRoot: baselines }),
      /stored result dimensions do not match/i,
    );

    await writeJson(join(run, "result.json"), {
      status: "failed",
      reward: 0,
      checks: [
        { id: "public-check-passes", passed: true, evidence: "passed" },
        { id: "orchestration-allowed-roles", passed: false, evidence: "failed" },
        { id: "root-trajectory", passed: false, evidence: "missing" },
        { id: "lifecycle", passed: true, evidence: "settled" },
      ],
    });
    await assert.rejects(
      promoteProspectiveBaseline(run, "measurement-failed", { allowFailed: true, baselineRoot: baselines }),
      /requires passing workspace and measurement dimensions/,
    );
    await writeJson(join(run, "result.json"), {
      status: "failed",
      reward: 0,
      checks: [
        { id: "public-check-passes", passed: false, evidence: "failed" },
        { id: "orchestration-allowed-roles", passed: false, evidence: "failed" },
        { id: "root-trajectory", passed: true, evidence: "available" },
        { id: "lifecycle", passed: true, evidence: "settled" },
      ],
    });
    await assert.rejects(
      promoteProspectiveBaseline(run, "workspace-failed", { allowFailed: true, baselineRoot: baselines }),
      /requires passing workspace and measurement dimensions/,
    );

    await writeJson(join(run, "result.json"), {
      status: "passed",
      reward: 1,
      checks: [{ id: "public-check-passes", passed: false, evidence: "failed" }],
    });
    await assert.rejects(
      promoteProspectiveBaseline(run, "passed-with-failure", { allowFailed: true, baselineRoot: baselines }),
      /status or reward does not match its checks/,
    );

    await writeJson(join(run, "result.json"), {
      status: "failed",
      reward: 0,
      checks: [
        { id: "public-check-passes", passed: true, evidence: "passed" },
        { id: "completion-signal", passed: true, evidence: "completed" },
        { id: "root-trajectory", passed: true, evidence: "available" },
        { id: "lifecycle", passed: true, evidence: "settled" },
      ],
    });
    await assert.rejects(
      promoteProspectiveBaseline(run, "failed-with-passes", { allowFailed: true, baselineRoot: baselines }),
      /status or reward does not match its checks/,
    );

    await writeJson(join(run, "result.json"), {
      status: "failed",
      reward: 1,
      checks: [
        { id: "public-check-passes", passed: true, evidence: "passed" },
        { id: "orchestration-allowed-roles", passed: false, evidence: "failed" },
        { id: "root-trajectory", passed: true, evidence: "available" },
        { id: "lifecycle", passed: true, evidence: "settled" },
      ],
    });
    await assert.rejects(
      promoteProspectiveBaseline(run, "reward-mismatch", { allowFailed: true, baselineRoot: baselines }),
      /status or reward does not match its checks/,
    );

    await writeJson(join(run, "result.json"), { status: "running", reward: 0, checks: [] });
    await assert.rejects(
      promoteProspectiveBaseline(run, "running", { allowFailed: true, baselineRoot: baselines }),
      /source status must be passed or failed/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
