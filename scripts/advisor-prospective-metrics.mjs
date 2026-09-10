import { normalizeSession } from "./advisor-eval-lib.mjs";

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

export const PROCESS_SCALAR_FIELDS = [
  "launches", "resumes", "blockedSettlements", "failedSettlements", "successfulSettlements",
  "repairRounds", "launchesPerPassedCriterion", "serialGapMinutes", "compactions",
  "firstTurnInputTokens", "doctrineReads", "guideReads", "roleSkillReads", "memoryToolCalls",
];
const TERMINAL_STATUSES = new Set(["successful", "blocked", "failed", "cancelled", "stopped"]);
const REPAIR_ROLES = new Set(["advisor", "builder", "foreman", "checker"]);

function hasGraphRepair(prompt) {
  if (typeof prompt !== "string") return false;
  return [...prompt.matchAll(/^GRAPH:[ \t]*\r?\n((?:[ \t]+[^\r\n]+\r?\n?)*)/gm)]
    .some((match) => /^[ \t]+repair(?:[ \t]*:|[ \t]+)\S*/m.test(match[1]));
}

function serialGapMinutes(events) {
  const lifecycle = events.filter((event) => event.kind === "worker_launch"
    || (["worker_status", "worker_launch_result"].includes(event.kind) && TERMINAL_STATUSES.has(event.status)));
  const points = lifecycle.map((event) => ({
    event,
    at: Date.parse(event.kind === "worker_status" ? event.endedAt ?? event.timestamp : event.timestamp),
    key: event.attemptAlias ?? event.workerAlias,
  }));
  if (points.some((point) => !Number.isFinite(point.at) || !point.key)) return null;
  points.sort((left, right) => left.at - right.at);
  const running = new Set();
  const settled = new Set();
  let idleSince = null;
  let gapMs = 0;
  for (const { event, at, key } of points) {
    if (event.kind === "worker_launch") {
      if (!running.size && idleSince !== null) gapMs += at - idleSince;
      idleSince = null;
      running.add(key);
      settled.delete(key);
    } else {
      if (settled.has(key)) continue; // A synchronous result may precede the same settlement notice.
      if (!running.delete(key)) return null; // Unlinked lifecycle cannot establish idle time.
      settled.add(key);
      if (!running.size) idleSince = at;
    }
  }
  return gapMs / 60_000;
}

function rawProcessCounters(entries, launchEvents) {
  const counters = {
    launches: 0, resumes: 0, repairRounds: 0, compactions: 0, firstTurnInputTokens: null,
    postCompactionFloorTokens: [], doctrineReads: 0, guideReads: 0, roleSkillReads: 0, memoryToolCalls: 0,
  };
  let firstAssistant = true;
  let pendingFloors = 0;
  let launchIndex = 0;
  for (const entry of entries) {
    if (entry?.type === "compaction") {
      counters.compactions += 1;
      counters.postCompactionFloorTokens.push(null);
      pendingFloors += 1;
    }
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const usage = entry.message.usage;
    if (firstAssistant) {
      counters.firstTurnInputTokens = validCount(usage?.input) ? usage.input : null;
      firstAssistant = false;
    }
    if (pendingFloors) {
      const floor = validCount(usage?.input) && validCount(usage?.cacheRead)
        && validCount(usage.input + usage.cacheRead) ? usage.input + usage.cacheRead : null;
      counters.postCompactionFloorTokens.fill(floor, counters.compactions - pendingFloors);
      pendingFloors = 0;
    }
    for (const call of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (call.type !== "toolCall") continue;
      const args = call.arguments ?? {};
      if (call.name === "bg_agent") {
        const resume = typeof args.name === "string" && args.name.length > 0;
        counters[resume ? "resumes" : "launches"] += 1;
        const role = args.role ?? launchEvents[launchIndex]?.role;
        if (hasGraphRepair(args.prompt) || (resume && REPAIR_ROLES.has(role))) counters.repairRounds += 1;
        launchIndex += 1;
      }
      if (typeof call.name === "string" && call.name.startsWith("mem_")) counters.memoryToolCalls += 1;
      if (!["read", "read_skill"].includes(call.name) || typeof args.path !== "string") continue;
      const path = args.path.replaceAll("\\", "/");
      if (/(?:^|\/)skills\/advisor\//.test(path)) counters.doctrineReads += 1;
      if (/(?:^|\/)advisor-intelligence\.json$/.test(path)) counters.guideReads += 1;
      if (/(?:^|\/)skills\/advisor-worker\//.test(path)) counters.roleSkillReads += 1;
    }
  }
  return counters;
}

// Omitted sources are unknown; an explicitly supplied empty source has observed zero calls.
export function summarizeProcess({ entries, trace, passedWorkspaceChecks } = {}) {
  const events = trace?.events ?? (Array.isArray(entries) ? entries.length ? normalizeSession(entries).events : [] : null);
  const launches = events?.filter((event) => event.kind === "worker_launch") ?? [];
  const result = Object.fromEntries(PROCESS_SCALAR_FIELDS.map((field) => [field, null]));
  result.postCompactionFloorTokens = null;
  if (events) {
    result.launches = launches.filter((event) => event.action === "launch").length;
    result.resumes = launches.filter((event) => event.action === "resume").length;
    for (const status of ["blocked", "failed", "successful"]) {
      result[`${status}Settlements`] = events.filter((event) => event.kind === "worker_status" && event.status === status).length;
    }
    result.serialGapMinutes = serialGapMinutes(events);
  }
  if (Array.isArray(entries)) Object.assign(result, rawProcessCounters(entries, launches));
  if (validCount(result.launches) && validCount(passedWorkspaceChecks) && passedWorkspaceChecks > 0) {
    result.launchesPerPassedCriterion = result.launches / passedWorkspaceChecks;
  }
  return result;
}

function summarizeValues(values) {
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return {
    total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
    median: !values.length ? null : values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
  };
}

export function summarizeProcessMetrics(results) {
  const summary = { attemptedRuns: results.length };
  for (const field of [...PROCESS_SCALAR_FIELDS, "postCompactionFloorTokens"]) {
    const samples = results.map((entry) => entry.result.process?.[field]);
    const available = samples.filter((value) => Array.isArray(value) || (Number.isFinite(value) && value >= 0));
    const values = available.flat().filter((value) => Number.isFinite(value) && value >= 0);
    summary[field] = { ...summarizeValues(values), measuredRuns: available.length };
    if (field === "postCompactionFloorTokens") summary[field].measuredSamples = values.length;
  }
  return summary;
}
