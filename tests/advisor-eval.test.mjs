import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  analyzeTrace,
  normalizeSession,
  parseJsonl,
  validateFixture,
} from "../scripts/advisor-eval-lib.mjs";
import {
  createAtifTrajectory,
  createHarborTask,
  HARBOR_VERSION,
  REWARDKIT_VERSION,
} from "../scripts/advisor-harbor-lib.mjs";
import { runCli } from "../scripts/advisor-eval.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "advisor-eval.mjs");
const CASE_DIR = join(ROOT, "evals", "cases", "evidence-rich-routing-defect");
const HARBOR_CASE_DIR = join(ROOT, "evals", "harbor", "evidence-rich-routing-defect");
const ADAPTIVE_CASE_DIR = join(ROOT, "evals", "cases", "adaptive-cross-repo-delivery");
const ADAPTIVE_HARBOR_CASE_DIR = join(ROOT, "evals", "harbor", "adaptive-cross-repo-delivery");
const ALIAS = /^(?:ar|g|n|w|a|m|l|h)_[0-9a-f]{32}$/;

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
}

function assistantEntry(content, timestamp = "2026-01-01T00:00:01.000Z") {
  return { type: "message", timestamp, message: { role: "assistant", timestamp, content } };
}

function resultEntry(toolCallId, status = "completed", timestamp = "2026-01-01T00:00:02.000Z") {
  return {
    type: "message",
    timestamp,
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "bg_agent",
      isError: status === "failed",
      timestamp,
      content: [{ type: "text", text: "untrusted result body" }],
      details: { status },
    },
  };
}

function workerCall(id, name, overrides = {}) {
  return {
    type: "toolCall",
    id,
    name: "bg_agent",
    arguments: {
      name,
      role: "scout",
      model: "private/provider-model",
      label: `inspect ${name}`,
      anchor: `report evidence for ${name}`,
      ...overrides,
    },
  };
}

async function syntheticInputs() {
  const trace = parseJsonl(await readFile(join(CASE_DIR, "trace.jsonl"), "utf8"));
  const normalized = normalizeSession(trace);
  const fixture = JSON.parse(await readFile(join(CASE_DIR, "fixture.json"), "utf8"));
  return { fixture, normalized };
}

async function caseInputs(caseDir, traceName) {
  const traceSource = JSON.parse(await readFile(join(caseDir, traceName), "utf8"));
  const normalized = Array.isArray(traceSource) ? normalizeSession(traceSource) : traceSource;
  const fixture = JSON.parse(await readFile(join(caseDir, "fixture.json"), "utf8"));
  return { fixture, normalized };
}

test("parseJsonl reports malformed JSON and malformed valid-JSON shapes", () => {
  assert.equal(typeof runCli, "function");
  assert.throws(() => parseJsonl('{"type":"session"}\nnot-json\n'), /Invalid JSONL at line 2/);
  assert.throws(
    () => parseJsonl(JSON.stringify({ type: "message", message: "not-an-object" })),
    /message must be an object/,
  );
  assert.throws(
    () => parseJsonl(JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "bg_agent", arguments: [] }] },
    })),
    /toolCall.arguments must be an object/,
  );
  assert.throws(
    () => normalizeSession([{ type: "custom_message", customType: "detach_agent_settled", details: "bad" }]),
    /custom_message.details must be an object/,
  );
});

test("normalization tolerates out-of-range timestamps without persisting them", () => {
  const normalized = normalizeSession([{ type: "session", timestamp: 1e100 }]);
  assert.equal(normalized.events[0].timestamp, undefined);
});

test("normalization emits only categorical metadata and opaque artifact-scoped aliases", () => {
  const proprietary = [
    "AcmeInternal",
    "AcmePayrollRouter",
    "NimbusLedger",
    "acme-payroll-routing",
    "internal/Nimbus-2026",
    "correct-horse-battery-staple",
    "/workspaces/AcmeInternal/service",
    "/var/lib/AcmeInternal/payroll",
    "/Users/alice/private",
  ];
  const entries = [
    { type: "session", timestamp: "2026-01-01T00:00:00.000Z", cwd: proprietary[8] },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:00.500Z",
      message: {
        role: "user",
        content: [{
          type: "text",
          text: `EVAL_SUMMARY: password=${proprietary[5]} at ${proprietary[6]} for ${proprietary[0]}`,
        }],
      },
    },
    assistantEntry([
      {
        type: "text",
        text: `EVAL_SUMMARY: ${proprietary[1]} routes ${proprietary[2]} through ${proprietary[4]}`,
      },
      {
        type: "toolCall",
        id: "private-graph-call",
        name: "advisor_graph_plan",
        arguments: {
          graphId: proprietary[3],
          nodes: [
            { id: proprietary[1], role: "scout" },
            { id: proprietary[2], role: "proprietary-role", dependsOn: [proprietary[1]] },
          ],
        },
      },
      workerCall("private-worker-call", "x".repeat(80), {
        model: proprietary[2],
        label: proprietary[7],
        anchor: `password=${proprietary[5]} ${proprietary[6]}`,
      }),
      { type: "toolCall", id: "private-unknown-call", name: proprietary[1], arguments: { secret: proprietary[5] } },
    ]),
  ];

  const first = normalizeSession(entries);
  const second = normalizeSession(structuredClone(entries));
  assert.deepEqual(first, second, "same artifact must produce stable aliases");
  const serialized = JSON.stringify(first);
  for (const value of proprietary) assert(!serialized.includes(value), value);
  assert(!serialized.includes("EVAL_SUMMARY"));
  assert(!serialized.includes("password="));
  assert.equal(first.source.textPolicy, "categorical-only");
  assert.equal(first.source.aliasScope, "deterministic-per-artifact");
  assert.match(first.source.artifactAlias, ALIAS);
  assert.equal(first.redaction.arbitraryTextCopied, false);

  const graph = first.events.find((event) => event.kind === "graph_plan");
  assert.match(graph.graphAlias, ALIAS);
  assert(graph.waves.flatMap((wave) => wave.nodeAliases).every((value) => ALIAS.test(value)));
  assert(graph.waves.flatMap((wave) => wave.roles).includes("unknown"));
  const launch = first.events.find((event) => event.kind === "worker_launch");
  for (const key of ["workerAlias", "attemptAlias", "modelAlias", "labelAlias", "anchorAlias"]) {
    assert.match(launch[key], ALIAS, key);
  }
  assert.equal(first.events.find((event) => event.kind === "tool_call").toolName, "other");

  const changed = normalizeSession([...entries, { type: "session", timestamp: "2026-01-01T00:00:03.000Z" }]);
  assert.notEqual(changed.source.artifactAlias, first.source.artifactAlias);
  assert.notEqual(
    changed.events.find((event) => event.kind === "worker_launch").workerAlias,
    launch.workerAlias,
  );
});

test("initial task constraints are not misclassified as a mid-session intervention", () => {
  const normalized = normalizeSession([
    {
      type: "message",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Stop acting as a provisioning flow; do not use real data." }] },
    },
    {
      type: "message",
      timestamp: "2026-01-01T00:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Stop and redirect the running builder." }] },
    },
  ]);
  assert.equal(normalized.events[0].kind, "user_message");
  assert(normalized.events[0].signals.includes("stop"));
  assert.equal(normalized.events[1].kind, "user_intervention");
  assert.equal(analyzeTrace(normalized).signals.userStops, 1);
});

test("saved normalized traces reject every field outside the closed schema", () => {
  const normalized = normalizeSession([{ type: "session", timestamp: "2026-01-01T00:00:00.000Z" }]);
  normalized.events[0].proprietaryPayload = "AcmeInternal";
  assert.throws(() => analyzeTrace(normalized), /unknown field: proprietaryPayload/);

  const sourceInjection = normalizeSession([{ type: "session", timestamp: "2026-01-01T00:00:00.000Z" }]);
  sourceInjection.source.privatePath = "/workspaces/AcmeInternal";
  assert.throws(() => analyzeTrace(sourceInjection), /Normalized source contains unknown field: privatePath/);
});

test("distinct long worker identities cannot collide or become false resumes", () => {
  const firstName = "A".repeat(80);
  const secondName = "B".repeat(80);
  const entries = [
    assistantEntry([workerCall("call-a", firstName), workerCall("call-b", secondName)]),
    resultEntry("call-a"),
    resultEntry("call-b", "completed", "2026-01-01T00:00:03.000Z"),
  ];
  const normalized = normalizeSession(entries);
  const launches = normalized.events.filter((event) => event.kind === "worker_launch");
  assert.equal(new Set(launches.map((event) => event.workerAlias)).size, 2);
  assert.deepEqual(launches.map((event) => event.action), ["launch", "launch"]);
  assert(!JSON.stringify(normalized).includes(firstName));
  assert(!JSON.stringify(normalized).includes(secondName));
  const metrics = analyzeTrace(normalized);
  assert.equal(metrics.workers.launches, 2);
  assert.equal(metrics.workers.successfulByRole.scout, 2);
  assert.equal(metrics.workers.resumedLaunches, 0);
});

test("ordered and out-of-order results correlate privately by toolCallId", () => {
  const calls = assistantEntry([
    workerCall("call-one", "worker-one"),
    workerCall("call-two", "worker-two"),
  ], "2026-01-01T00:00:03.000Z");
  const ordered = normalizeSession([calls, resultEntry("call-one"), resultEntry("call-two")]);
  const outOfOrder = normalizeSession([
    resultEntry("call-two", "completed", "2026-01-01T00:00:00.000Z"),
    resultEntry("call-one", "completed", "2026-01-01T00:00:00.500Z"),
    calls,
  ]);
  for (const normalized of [ordered, outOfOrder]) {
    const launchAttempts = new Set(
      normalized.events.filter((event) => event.kind === "worker_launch").map((event) => event.attemptAlias),
    );
    const resultAttempts = new Set(
      normalized.events.filter((event) => event.kind === "worker_launch_result").map((event) => event.attemptAlias),
    );
    assert.deepEqual(resultAttempts, launchAttempts);
    assert.equal(analyzeTrace(normalized).workers.successfulByRole.scout, 2);
    assert(!JSON.stringify(normalized).includes("call-one"));
    assert(!JSON.stringify(normalized).includes("call-two"));
  }
});

test("artifact-wide input and repetition budgets are enforced", () => {
  assert.throws(
    () => normalizeSession(Array.from({ length: 50_001 }, () => ({ type: "session" }))),
    /entry budget/,
  );
  const calls = Array.from({ length: 502 }, (_, index) => workerCall(`call-${index}`, `worker-${index}`, {
    label: "same repeated label",
    anchor: "same repeated anchor",
  }));
  const normalized = normalizeSession([assistantEntry(calls)]);
  const repetition = normalized.relationships.repetition;
  assert.equal(repetition.truncated, true);
  assert.equal(repetition.exactLabels.length, 1_000);
  assert.equal(repetition.exactAnchors.length, 1_000);
  assert(Buffer.byteLength(JSON.stringify(normalized)) < 8 * 1024 * 1024);
});

test("synthetic case metrics match the regenerated deterministic baseline", async () => {
  const { fixture, normalized } = await syntheticInputs();
  const baseline = JSON.parse(await readFile(join(CASE_DIR, "baseline-report.json"), "utf8"));
  assert.deepEqual(validateFixture(fixture, normalized), { valid: true, errors: [] });
  assert.deepEqual(analyzeTrace(normalized), baseline.metrics);
  assert.equal(normalized.events.length, 20);
  assert.equal(baseline.metrics.workers.failedLaunches, 1);
  assert.equal(baseline.metrics.workers.resumedLaunches, 1);
  assert.equal(baseline.metrics.workers.recoveryRatio, 1);
  assert.equal(baseline.metrics.graphs.parallelWaves, 1);
  assert.deepEqual(baseline.metrics.repetition.nearLabelPairs, [["e0010", "e0013"]]);
  assert.equal(baseline.metrics.signals.builderInvalidations, 1);
  assert.equal(baseline.metrics.signals.userStops, 1);
});

test("adaptive delivery case preserves the reviewed positive trace and baseline", async () => {
  const { fixture, normalized } = await caseInputs(ADAPTIVE_CASE_DIR, "trace.json");
  const baseline = JSON.parse(await readFile(join(ADAPTIVE_CASE_DIR, "baseline-report.json"), "utf8"));
  assert.deepEqual(validateFixture(fixture, normalized), { valid: true, errors: [] });
  assert.deepEqual(analyzeTrace(normalized), baseline.metrics);
  assert.equal(normalized.events.length, 177);
  assert.equal(normalized.source.textPolicy, "categorical-only");
  assert.equal(normalized.redaction.arbitraryTextCopied, false);
  assert.equal(baseline.metrics.workers.launches, 33);
  assert.equal(baseline.metrics.graphs.maxWaveWidth, 2);
  assert.equal(baseline.metrics.graphs.launchBatches.length, 2);
  assert.deepEqual(baseline.metrics.repetition.exactAnchorPairs, []);
  assert.deepEqual(baseline.metrics.repetition.exactLabelPairs, []);
  assert.equal(fixture.checkpoints.length, 7);
});

test("fixture validation rejects duplicate checkpoint and action semantics", async () => {
  const { fixture, normalized } = await syntheticInputs();
  const invalid = structuredClone(fixture);
  invalid.checkpoints[1].id = invalid.checkpoints[0].id;
  invalid.checkpoints[0].acceptableNextActions = [
    {
      id: "same",
      description: "Only strategy!",
      supports: ["outcomeCorrectness", "informationValue"],
    },
    {
      id: "same",
      description: " only   strategy ",
      supports: ["informationValue", "outcomeCorrectness"],
    },
  ];
  const validation = validateFixture(invalid, normalized);
  assert.equal(validation.valid, false);
  assert(validation.errors.some((error) => error.includes("checkpoint IDs must be unique")));
  assert(validation.errors.some((error) => error.includes("action IDs must be unique")));
  assert(validation.errors.some((error) => error.includes("duplicate normalized action descriptions")));
  assert(validation.errors.some((error) => error.includes("duplicate acceptable actions")));

  const missingId = structuredClone(fixture);
  missingId.checkpoints[0].acceptableNextActions[0].id = " ";
  assert(validateFixture(missingId, normalized).errors.some((error) => error.includes("without an id")));

  const sameSupportsButDistinct = structuredClone(fixture);
  sameSupportsButDistinct.checkpoints[0].acceptableNextActions[1].supports = [
    ...sameSupportsButDistinct.checkpoints[0].acceptableNextActions[0].supports,
  ];
  assert.equal(validateFixture(sameSupportsButDistinct, normalized).valid, true);
});

test("Harbor task exposes a categorical ATIF trajectory and RewardKit rubric", async () => {
  const { fixture, normalized } = await syntheticInputs();
  const trajectory = createAtifTrajectory(normalized);
  const task = createHarborTask(fixture, normalized);
  const context = JSON.parse(task.files["environment/advisor-eval-context.json"]);
  assert.equal(trajectory.schema_version, "ATIF-v1.7");
  assert.equal(trajectory.agent.name, "pi-advisor");
  assert.equal(trajectory.agent.extra.text_policy, "categorical-only");
  assert.equal(trajectory.steps.length, normalized.events.length);
  assert.equal(trajectory.steps.find((step) => step.extra.advisor_event.kind === "user_intervention").source, "user");
  assert.equal(context.framework.version, HARBOR_VERSION);
  assert.equal(context.framework.verifierVersion, REWARDKIT_VERSION);
  assert.equal(context.judgeGuidance.noGoldenWorkflow, true);
  assert.deepEqual(
    { minimum: context.rubric.scale.minimum, maximum: context.rubric.scale.maximum },
    { minimum: 1, maximum: 5 },
  );
  assert.match(task.files["tests/test.sh"], /harbor-rewardkit==0\.1/);
  assert.match(task.files["tests/reward.toml"], /atif-trajectory = "\/app\/advisor-trajectory\.json"/);
  assert.match(task.files["tests/reward.toml"], /name = "outcomeCorrectness"/);
  assert.match(task.files["tests/reward.toml"], /type = "likert"/);
  assert.match(task.files["tests/reward.toml"], /points = 5/);
  assert.match(task.files["tests/run_rewardkit.py"], /os\.environ\.get\("REWARDKIT_JUDGE"\)/);
  assert.equal(task.files["tests/advisor.toml"], undefined);
  for (const [relativePath, contents] of Object.entries(task.files)) {
    assert.equal(await readFile(join(HARBOR_CASE_DIR, relativePath), "utf8"), contents, relativePath);
  }
  assert(!JSON.stringify(trajectory).includes(fixture.title));
  assert(!JSON.stringify(trajectory).includes("EVAL_SUMMARY"));
});

test("adaptive delivery Harbor task stays synchronized and categorical", async () => {
  const { fixture, normalized } = await caseInputs(ADAPTIVE_CASE_DIR, "trace.json");
  const trajectory = createAtifTrajectory(normalized);
  const task = createHarborTask(fixture, normalized);
  const context = JSON.parse(task.files["environment/advisor-eval-context.json"]);
  assert.equal(trajectory.schema_version, "ATIF-v1.7");
  assert.equal(trajectory.steps.length, 177);
  assert.equal(context.checkpoints.length, 7);
  assert.equal(context.judgeGuidance.noGoldenWorkflow, true);
  for (const [relativePath, contents] of Object.entries(task.files)) {
    assert.equal(await readFile(join(ADAPTIVE_HARBOR_CASE_DIR, relativePath), "utf8"), contents, relativePath);
  }
  const serialized = JSON.stringify({ trajectory, context });
  for (const forbidden of ["01a03597", "/Users/", "ai_tutor", "stride", "bitbucket"]) {
    assert(!serialized.includes(forbidden), forbidden);
  }
});

test("CLI prepares Harbor tasks and rejects retired evaluation commands", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-eval-test-"));
  const tracePath = join(temp, "proprietary-session-name.jsonl");
  const normalizedPath = join(temp, "normalized.json");
  const metricsPath = join(temp, "metrics.json");
  const harborTaskPath = join(temp, "harbor-task");
  await writeFile(
    tracePath,
    `${JSON.stringify({ type: "session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspaces/SecretProduct" })}\n`,
  );

  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Harbor/);

  const ingest = run("ingest", tracePath, "--output", normalizedPath);
  assert.equal(ingest.status, 0, ingest.stderr);
  const normalized = JSON.parse(await readFile(normalizedPath, "utf8"));
  assert.equal(normalized.source.textPolicy, "categorical-only");
  assert(!JSON.stringify(normalized).includes("SecretProduct"));

  const analyze = run("analyze", normalizedPath, "--output", metricsPath);
  assert.equal(analyze.status, 0, analyze.stderr);
  assert.equal(JSON.parse(await readFile(metricsPath, "utf8")).diagnosticOnly, true);

  await mkdir(join(harborTaskPath, "tests"), { recursive: true });
  await writeFile(join(harborTaskPath, "tests", "advisor.toml"), "retired config\n");
  const harborTask = run("harbor-task", join(CASE_DIR, "fixture.json"), "--output", harborTaskPath);
  assert.equal(harborTask.status, 0, harborTask.stderr);
  assert.equal(harborTask.stdout.trim(), harborTaskPath);
  const trajectory = JSON.parse(await readFile(join(harborTaskPath, "environment", "advisor-trajectory.json"), "utf8"));
  assert.equal(trajectory.schema_version, "ATIF-v1.7");
  assert.match(await readFile(join(harborTaskPath, "task.toml"), "utf8"), /schema_version = "1\.4"/);
  assert((await stat(join(harborTaskPath, "tests", "test.sh"))).mode & 0o111);
  await assert.rejects(readFile(join(harborTaskPath, "tests", "advisor.toml")), { code: "ENOENT" });

  for (const retired of ["evaluate", "compare"]) {
    const result = run(retired, join(CASE_DIR, "fixture.json"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Unknown command: ${retired}`));
  }
  const invalidOption = run("ingest", tracePath, "--trace", tracePath);
  assert.equal(invalidOption.status, 1);
  assert.match(invalidOption.stderr, /Option --trace is not valid for ingest/);
  const removedSummaryOption = run("ingest", tracePath, "--include-summaries");
  assert.equal(removedSummaryOption.status, 1);
  assert.match(removedSummaryOption.stderr, /Unknown option: --include-summaries/);
  const missingOptionValue = run("ingest", tracePath, "--output");
  assert.equal(missingOptionValue.status, 1);
  assert.match(missingOptionValue.stderr, /Option --output requires a path/);
  const duplicateOption = run("ingest", tracePath, "--output", normalizedPath, "--output", metricsPath);
  assert.equal(duplicateOption.status, 1);
  assert.match(duplicateOption.stderr, /Duplicate option: --output/);

  const defaultIngest = run("ingest", tracePath);
  assert.equal(defaultIngest.status, 0, defaultIngest.stderr);
  assert.match(defaultIngest.stdout.trim(), /^evals\/local\/ar_[0-9a-f]{32}\.normalized\.json$/);

  const defaultOutput = join(ROOT, defaultIngest.stdout.trim());
  assert(!defaultIngest.stdout.includes("proprietary-session-name"));
  await rm(defaultOutput, { force: true });
  await rm(temp, { recursive: true, force: true });
});
