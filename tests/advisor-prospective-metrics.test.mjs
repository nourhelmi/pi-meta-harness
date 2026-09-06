import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { finishPerformance, summarizePerformance, summarizeRootUsage } from "../scripts/advisor-prospective-metrics.mjs";
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
