// Deliberately aggregate numbers only; never copy session content or identifiers.
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;

export function summarizeRootUsage(entries) {
  const tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  let assistantMessages = 0;
  let measuredMessages = 0;
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    assistantMessages += 1;
    const usage = entry.message.usage;
    if (!TOKEN_FIELDS.every((field) => validCount(usage?.[field]) && validCount(tokens[field] + usage[field]))) continue;
    for (const field of TOKEN_FIELDS) tokens[field] += usage[field];
    measuredMessages += 1;
  }
  return {
    scope: "root-assistant-messages-only",
    status: !measuredMessages ? "unavailable" : measuredMessages === assistantMessages ? "available" : "partial",
    assistantMessages,
    measuredMessages,
    tokens: measuredMessages ? tokens : null,
    allAgentTokens: null,
    billedCost: null,
    limitation: "Reported root usage excludes helpers, tool-internal LLM calls, and compaction; it is not whole-system usage or subscription billing.",
  };
}

export function finishPerformance({ startedAt, finishedAt, startedTick, finishedTick, rootUsage }) {
  if (![startedAt, finishedAt, startedTick, finishedTick].every(Number.isFinite) || finishedTick < startedTick) {
    throw new Error("Performance measurement requires finite, nondecreasing monotonic ticks");
  }
  return {
    schemaVersion: 1,
    scope: "preparation-through-verification-including-cleanup-and-waits",
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    wallElapsedMs: Math.round(finishedTick - startedTick),
    rootUsage: rootUsage ?? summarizeRootUsage([]),
  };
}

export function summarizePerformance(results) {
  const measured = results.filter((entry) => validCount(entry.result.performance?.wallElapsedMs));
  const durations = measured.map((entry) => entry.result.performance.wallElapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  return {
    measuredRuns: measured.length,
    attemptedRuns: results.length,
    verifiedOutcomes: results.filter((entry) => entry.result.status === "passed").length,
    elapsedMs: {
      total: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
      median: !durations.length ? null : durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2,
      max: durations.at(-1) ?? null,
    },
    limitation: "Elapsed values include failed and timed-out measured runs. Missing timing is unknown, not zero; root trace span is not a substitute. Case mix affects summary latency.",
  };
}
