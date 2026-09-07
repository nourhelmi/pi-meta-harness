import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finishPerformance, PROCESS_SCALAR_FIELDS, summarizePerformance, summarizeProcess, summarizeProcessMetrics, summarizeRootUsage } from "../scripts/advisor-prospective-metrics.mjs";
import { loadProspectiveCase, verifyPreparedRun } from "../scripts/advisor-prospective.mjs";
import { prospectiveSuiteFingerprint } from "../scripts/advisor-prospective-results.mjs";
import { summarizeSuiteResults } from "../scripts/advisor-prospective-manage.mjs";

const usage = { input: 10, output: 4, cacheRead: 3, cacheWrite: 1, totalTokens: 18 };
const assistant = (value = usage) => ({ type: "message", message: { role: "assistant", content: "secret text", usage: value } });

test("root usage retains only numeric counters and excludes nested workers and retained tails", () => {
  const entries = [
    assistant({ ...usage, cost: { total: 50 }, credentials: "secret token" }),
    assistant(),
    { type: "message", message: { role: "toolResult", usage, details: { worker: assistant() } } },
    { type: "compaction", usage, retainedTail: [assistant()] },
    { type: "session", id: "private-session", cwd: "/private/path" },
    null,
  ];
  const result = summarizeRootUsage(entries);
  assert.equal(result.status, "available");
  assert.equal(result.assistantMessages, 2);
  assert.equal(result.measuredMessages, 2);
  assert.deepEqual(result.tokens, { input: 20, output: 8, cacheRead: 6, cacheWrite: 2, totalTokens: 36 });
  assert.equal(result.allAgentTokens, null);
  assert.equal(result.billedCost, null);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|credentials/);
});

test("missing, malformed, negative, nonfinite, and overflowing root usage stays unknown or partial", () => {
  assert.equal(summarizeRootUsage([]).status, "unavailable");
  for (const bad of [undefined, {}, { ...usage, input: -1 }, { ...usage, output: 0.5 },
    { ...usage, cacheRead: "3" }, { ...usage, totalTokens: Infinity }, { ...usage, totalTokens: NaN }]) {
    const invalid = { type: "message", message: { role: "assistant", usage: bad } };
    assert.equal(summarizeRootUsage([invalid]).tokens, null);
    const partial = summarizeRootUsage([assistant(), invalid]);
    assert.equal(partial.status, "partial");
    assert.equal(partial.measuredMessages, 1);
    assert.deepEqual(partial.tokens, usage);
  }
  const huge = { ...usage, totalTokens: Number.MAX_SAFE_INTEGER };
  assert.equal(summarizeRootUsage([assistant(huge), assistant()]).status, "partial");
  assert.equal(summarizeRootUsage([assistant(Object.fromEntries(Object.keys(usage).map((key) => [key, 0])))]).status, "available");
});

test("whole attempt uses monotonic duration even when the wall clock moves backwards", () => {
  const result = finishPerformance({ startedAt: 2_000, finishedAt: 1_000, startedTick: 100, finishedTick: 900_100.4 });
  assert.equal(result.wallElapsedMs, 900_000);
  assert.equal(result.startedAt, "1970-01-01T00:00:02.000Z");
  assert.match(result.scope, /cleanup-and-waits/);
  assert.equal(result.rootUsage.status, "unavailable");
  assert.throws(() => finishPerformance({ startedAt: 0, finishedAt: 1, startedTick: 5, finishedTick: 4 }), /monotonic/);
  assert.throws(() => finishPerformance({ startedAt: 0, finishedAt: Infinity, startedTick: 0, finishedTick: 1 }), /finite/);
});

test("suite latency includes failures and timeouts without zero-filling legacy unknowns", () => {
  const results = [
    { result: { status: "passed", performance: { wallElapsedMs: 100 } } },
    { result: { status: "failed", performance: { wallElapsedMs: 900_000 } } },
    { result: { status: "passed" } },
    { result: { status: "failed", performance: { wallElapsedMs: -1 } } },
  ];
  const summary = summarizePerformance(results);
  assert.equal(summary.verifiedOutcomes, 2);
  assert.equal(summary.measuredRuns, 2);
  assert.equal(summary.attemptedRuns, 4);
  assert.deepEqual(summary.elapsedMs, { total: 900_100, median: 450_050, max: 900_000 });
  assert.deepEqual(summarizeSuiteResults(results).performance, summary);
  assert.deepEqual(summarizePerformance([]).elapsedMs, { total: null, median: null, max: null });
});

test("live runner starts the clock before preparation and finishes after cleanup and grading", async () => {
  const source = await readFile(new URL("../scripts/advisor-prospective.mjs", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function runProspectiveCase(options)"));
  assert.match(body, /startedTick = performance\.now\(\);[\s\S]+prepareProspectiveRun\(options\)/);
  assert.match(body, /persistTrajectory\(runState, sessionPath\)[\s\S]+rm\(runState\.agentDir[\s\S]+verifyProspectiveWorkspace[\s\S]+performance: finishPerformance/);
});

const at = (minute) => new Date(Date.UTC(2026, 0, 1) + minute * 60_000).toISOString();
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const turn = (minute, content, value = usage) => ({ type: "message", timestamp: at(minute), message: { role: "assistant", content, usage: value } });
const settled = (minute, label, status) => ({ type: "custom_message", customType: "detach_agent_settled", timestamp: at(minute), details: { label, status, endedAt: at(minute) } });

function processEntries() {
  return [
    turn(0, [
      call("launch-1", "bg_agent", { role: "builder", label: "private-builder", prompt: "private prompt" }),
      call("read-1", "read_skill", { path: "/private/skills/advisor/SKILL.md" }),
      call("memory-1", "mem_save", { content: "private memory" }),
      call("memory-2", "mem_save", { content: "private memory" }),
    ]),
    { type: "message", timestamp: at(0.1), message: { role: "toolResult", toolCallId: "launch-1", details: { agentName: "private-live-name", status: "running" } } },
    settled(1, "private-builder", "blocked"),
    { type: "compaction", retainedTail: [assistant()], summary: "private summary" },
    turn(3, [call("resume", "bg_agent", { name: "private-live-name", prompt: "continue" })], { input: 10_000, cacheRead: 90_000 }),
    settled(4, "private-live-name", "done"),
    turn(6, [call("launch-2", "bg_agent", { role: "checker", label: "private-checker", prompt: "GRAPH:\n  graph: private-graph\n  repair: 1\n\nprivate packet" })]),
    settled(7, "private-checker", "done"),
  ];
}

test("process counts two launches, a builder resume, a blocked settlement, compaction, doctrine read and two memory calls exactly", () => {
  const result = summarizeProcess({ entries: processEntries(), passedWorkspaceChecks: 4 });
  assert.deepEqual(result, {
    launches: 2, resumes: 1, blockedSettlements: 1, failedSettlements: 0, successfulSettlements: 2,
    repairRounds: 2, launchesPerPassedCriterion: 0.5, serialGapMinutes: 4, compactions: 1,
    firstTurnInputTokens: 10, postCompactionFloorTokens: [100_000], doctrineReads: 1,
    guideReads: 0, roleSkillReads: 0, memoryToolCalls: 2,
  });
  assert.doesNotMatch(JSON.stringify(result), /private|prompt|path|label|agentName|retainedTail/);
});

test("absent process sources are all null, and empty sources are zero-safe", () => {
  assert.deepEqual(summarizeProcess(), Object.fromEntries([...PROCESS_SCALAR_FIELDS, "postCompactionFloorTokens"].map((field) => [field, null])));
  const empty = summarizeProcess({ entries: [], passedWorkspaceChecks: 0 });
  for (const field of PROCESS_SCALAR_FIELDS) {
    assert.equal(empty[field], ["firstTurnInputTokens", "launchesPerPassedCriterion"].includes(field) ? null : 0, field);
  }
  assert.deepEqual(empty.postCompactionFloorTokens, []);
  assert.equal(summarizeProcess({ entries: [], passedWorkspaceChecks: 2 }).launchesPerPassedCriterion, 0);
  assert.equal(summarizeProcess({ entries: processEntries(), passedWorkspaceChecks: 0 }).launchesPerPassedCriterion, null);
});

test("trace-only process measures lifecycle without inventing raw-only counters", () => {
  const trace = { events: [
    { kind: "worker_launch", action: "launch", attemptAlias: "a1", timestamp: at(0) },
    { kind: "worker_status", status: "failed", attemptAlias: "a1", timestamp: at(1) },
    { kind: "worker_launch", action: "resume", attemptAlias: "a2", timestamp: at(3) },
  ] };
  const result = summarizeProcess({ trace, passedWorkspaceChecks: 2 });
  assert.equal(result.launches, 1);
  assert.equal(result.resumes, 1);
  assert.equal(result.failedSettlements, 1);
  assert.equal(result.serialGapMinutes, 2);
  assert.equal(result.launchesPerPassedCriterion, 0.5);
  for (const field of ["repairRounds", "compactions", "firstTurnInputTokens", "postCompactionFloorTokens", "doctrineReads", "guideReads", "roleSkillReads", "memoryToolCalls"]) assert.equal(result[field], null, field);
});

test("serial gaps exclude concurrent work and duplicate notifications and require complete timing", () => {
  const events = [
    { kind: "worker_launch", action: "launch", attemptAlias: "a1", timestamp: at(0) },
    { kind: "worker_launch", action: "launch", attemptAlias: "a2", timestamp: at(0) },
    { kind: "worker_status", status: "successful", attemptAlias: "a1", timestamp: at(1) },
    { kind: "worker_launch", action: "launch", attemptAlias: "a3", timestamp: at(2) },
    { kind: "worker_launch_result", status: "failed", attemptAlias: "a3", timestamp: at(3) },
    { kind: "worker_status", status: "failed", attemptAlias: "a3", timestamp: at(4), endedAt: at(3) },
    { kind: "worker_status", status: "blocked", attemptAlias: "a2", timestamp: at(6), endedAt: at(5) },
    { kind: "worker_launch", action: "resume", attemptAlias: "a4", timestamp: at(7) },
  ];
  assert.equal(summarizeProcess({ trace: { events } }).serialGapMinutes, 2);
  assert.equal(summarizeProcess({ trace: { events: events.map((event) => ({ ...event, timestamp: undefined })) } }).serialGapMinutes, null);
  assert.equal(summarizeProcess({ trace: { events: events.slice(1) } }).serialGapMinutes, null);
});

test("read categories, graph boundaries, and missing compaction usage do not create false measurements", () => {
  const entries = [
    turn(0, [
      call("read-1", "read", { path: "skills/advisor/references/guide.md" }),
      call("read-2", "read_skill", { path: "C:\\private\\skills\\advisor-worker\\roles\\builder\\SKILL.md" }),
      call("read-3", "read", { path: "advisor-intelligence.json" }),
      call("read-4", "read", { path: "skills/advisor-other/SKILL.md" }),
      call("read-5", "read", { path: "advisor-intelligence.json.bak" }),
      call("write", "write", { path: "skills/advisor/SKILL.md" }),
      call("launch", "bg_agent", { role: "scout", label: "scout", prompt: "GRAPH:\n  graph: x\n\n  repair: outside block" }),
    ], { input: -1 }),
    { type: "compaction" },
    turn(1, [call("resume", "bg_agent", { name: "scout" })], { input: 10 }),
    turn(2, [], usage), // Cannot substitute a later valid usage for the first message.
    { type: "compaction" },
    { type: "compaction" },
    turn(3, [], { input: 0, cacheRead: 0 }),
    { type: "compaction" },
  ];
  const result = summarizeProcess({ entries });
  assert.equal(result.doctrineReads, 1);
  assert.equal(result.guideReads, 1);
  assert.equal(result.roleSkillReads, 1);
  assert.equal(result.repairRounds, 0);
  assert.equal(result.firstTurnInputTokens, null);
  assert.deepEqual(result.postCompactionFloorTokens, [null, 0, 0, null]);
});

test("suite process totals and medians include failed runs and preserve all outcome and reward data", () => {
  const metrics = summarizeProcess({ entries: processEntries(), passedWorkspaceChecks: 4 });
  const results = [
    { result: { status: "passed", reward: 1, process: metrics, dimensions: { workspace: { passed: 4, total: 4, status: "passed" } } } },
    { result: { status: "failed", reward: 0, process: { ...metrics, launches: 6, postCompactionFloorTokens: [20_000, null, 60_000] } } },
    { result: { status: "passed", reward: 1 } },
  ];
  const original = structuredClone(results);
  const withoutMetrics = results.map(({ result }) => ({ result: { ...result, process: undefined } }));
  const before = { passed: 2, failed: 1, ...summarizeSuiteResults(withoutMetrics) };
  const after = { passed: 2, failed: 1, ...summarizeSuiteResults(results) };
  assert.deepEqual({ ...after, process: undefined }, { ...before, process: undefined });
  assert.deepEqual(results, original);
  assert.deepEqual(after.process.launches, { total: 8, median: 4, measuredRuns: 2 });
  assert.deepEqual(after.process.blockedSettlements, { total: 2, median: 1, measuredRuns: 2 });
  assert.deepEqual(after.process.postCompactionFloorTokens, { total: 180_000, median: 60_000, measuredRuns: 2, measuredSamples: 3 });
  assert.equal(after.process.attemptedRuns, 3);
  assert.deepEqual(after.process, summarizeProcessMetrics(results));
  for (const field of PROCESS_SCALAR_FIELDS) assert.deepEqual(summarizeProcessMetrics(withoutMetrics)[field], { total: null, median: null, measuredRuns: 0 });
});

test("deterministic verify preserves original process and performance exactly, including unknowns and the original ratio", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-reverify-process-"));
  try {
    const loaded = await loadProspectiveCase("advisor-direct-repair");
    await writeFile(join(temp, "manifest.json"), JSON.stringify({ runId: "process-test", case: { id: loaded.definition.id }, candidate: {}, evaluation: { fingerprint: await prospectiveSuiteFingerprint() } }));
    await cp(loaded.workspaceSource, join(temp, "workspace"), { recursive: true });
    await writeFile(join(temp, "workspace", "settings.json"), '{"retryLimit":3}\n');
    await writeFile(join(temp, "completion.json"), '{"schemaVersion":1,"status":"completed"}\n');
    await writeFile(join(temp, "trace.json"), '{"events":[]}\n');
    const performance = finishPerformance({ startedAt: 0, finishedAt: 60_000, startedTick: 0, finishedTick: 60_000 });
    const process = { ...summarizeProcess({ entries: processEntries(), passedWorkspaceChecks: 400 }), guideReads: null, postCompactionFloorTokens: [100_000, null] };
    await writeFile(join(temp, "result.json"), JSON.stringify({ performance, process, checks: [{ id: "lifecycle", passed: true }] }));
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const result = await verifyPreparedRun(temp);
      assert.equal(result.reward, 1);
      assert.deepEqual(result.process, process);
      assert.deepEqual(result.performance, performance);
      assert.deepEqual(JSON.parse(await readFile(join(temp, "result.json"), "utf8")).process, process);
    }
    await writeFile(join(temp, "result.json"), JSON.stringify({ checks: [{ id: "lifecycle", passed: true }] }));
    assert.equal((await verifyPreparedRun(temp)).process, undefined);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(join(temp, "result.json"), "utf8")), "process"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
