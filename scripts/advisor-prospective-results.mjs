import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTrace } from "./advisor-eval-lib.mjs";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROSPECTIVE_RUNS_ROOT = join(PROJECT_ROOT, "evals", "local", "prospective-runs");
export const PROSPECTIVE_BASELINES_ROOT = join(PROJECT_ROOT, "evals", "baselines", "prospective");
export const PROSPECTIVE_CASES_ROOT = join(PROJECT_ROOT, "evals", "prospective");

export const CANDIDATE_INPUTS = [
  "config",
  "extensions",
  "skills",
  "scripts/meta-harness.mjs",
  "scripts/intelligence-profile.mjs",
  "package.json",
  "package-lock.json",
];

export const PROSPECTIVE_EVALUATOR_INPUTS = [
  "evals/prospective",
  "scripts/advisor-eval-lib.mjs",
  "scripts/advisor-harbor-lib.mjs",
  "scripts/advisor-prospective.mjs",
  "scripts/advisor-prospective-manage.mjs",
  "scripts/advisor-prospective-results.mjs",
];
const SAFE_BASELINE_FILES = ["manifest.json", "prompt.md", "completion.json", "result.json", "trace.json", "trajectory.json"];
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path, label = path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function assertInside(parent, candidate, label) {
  const rel = relative(resolve(parent), resolve(candidate));
  if (!rel || rel === ".") return;
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.includes(`${sep}..${sep}`)) {
    throw new Error(`${label} must stay inside ${parent}`);
  }
}

async function collectCandidateEntries(root, subject, entries) {
  const absolute = join(root, subject);
  if (!(await exists(absolute))) return;
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) {
    entries.push({ path: subject, kind: "symlink", value: await readlink(absolute) });
    return;
  }
  if (info.isDirectory()) {
    const children = await readdir(absolute);
    for (const child of children.sort()) await collectCandidateEntries(root, join(subject, child), entries);
    return;
  }
  if (info.isFile()) {
    const bytes = await readFile(absolute);
    entries.push({ path: subject, kind: "file", value: createHash("sha256").update(bytes).digest("hex") });
  }
}

async function inputsFingerprint(root, inputs, algorithm) {
  const entries = [];
  for (const subject of inputs) await collectCandidateEntries(resolve(root), subject, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return {
    algorithm,
    value: digest,
    files: entries.length,
  };
}

export async function candidateFingerprint(root = PROJECT_ROOT, { piDetachRevision } = {}) {
  const fingerprint = await inputsFingerprint(root, CANDIDATE_INPUTS, "sha256-candidate-tree-v1");
  if (!piDetachRevision) return fingerprint;
  return {
    ...fingerprint,
    algorithm: "sha256-candidate-tree-plus-pi-detach-v1",
    value: createHash("sha256")
      .update(`${fingerprint.value}\0${piDetachRevision}`)
      .digest("hex"),
  };
}

export async function prospectiveSuiteFingerprint(root = PROJECT_ROOT) {
  return inputsFingerprint(
    root,
    [...CANDIDATE_INPUTS, ...PROSPECTIVE_EVALUATOR_INPUTS],
    "sha256-prospective-suite-tree-v1",
  );
}

export function parallelismDiagnostics(trace, expectation) {
  if (!trace || !expectation) return undefined;
  const expectedWidth = expectation.maxUsefulWidth;
  const roles = new Set(expectation.roles ?? []);
  const launches = (trace.events ?? []).filter((event) =>
    event.kind === "worker_launch"
    && event.action === "launch"
    && roles.has(event.role)
  );
  const batches = Object.values(Object.groupBy(
    launches,
    (event) => event.timestamp ?? event.id,
  ));
  const observedLaunchBatchWidth = Math.max(0, ...batches.map((batch) => batch.length));
  const launchWorkers = new Set(launches.map((launch) => launch.workerAlias));
  const updates = Object.groupBy(
    (trace.events ?? []).filter((event) =>
      ["worker_launch_result", "worker_status"].includes(event.kind)
      && launchWorkers.has(event.workerAlias)
    ),
    (event) => event.workerAlias,
  );
  const intervals = [];
  let successfulSettlements = 0;
  for (const launch of launches) {
    const attemptUpdates = updates[launch.workerAlias] ?? [];
    if (attemptUpdates.some((event) => event.status === "successful")) successfulSettlements += 1;
    const start = Date.parse(
      attemptUpdates.find((event) => event.startedAt)?.startedAt
      ?? launch.timestamp,
    );
    const endEvent = attemptUpdates.findLast((event) => event.endedAt || event.status === "successful");
    const end = Date.parse(endEvent?.endedAt ?? endEvent?.timestamp);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push({ start, end });
  }
  const points = intervals.flatMap((interval) => [
    { at: interval.start, delta: 1 },
    { at: interval.end, delta: -1 },
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let concurrent = 0;
  let observedConcurrentWidth = 0;
  for (const point of points) {
    concurrent += point.delta;
    observedConcurrentWidth = Math.max(observedConcurrentWidth, concurrent);
  }
  const observedUsefulWidth = Math.max(observedLaunchBatchWidth, observedConcurrentWidth);
  const widthUtilization = expectedWidth > 0
    ? Math.min(observedUsefulWidth, expectedWidth) / expectedWidth
    : null;
  const settlementCoverage = expectedWidth > 0
    ? Math.min(successfulSettlements, expectedWidth) / expectedWidth
    : null;
  let status = "underutilized";
  if (observedUsefulWidth > expectedWidth) status = "oversubscribed";
  else if (observedUsefulWidth >= expectedWidth && successfulSettlements >= expectedWidth) status = "utilized";
  else if (observedUsefulWidth >= expectedWidth) status = "launched-not-settled";
  return {
    diagnosticOnly: true,
    expectedMaxUsefulWidth: expectedWidth,
    roles: [...roles],
    rationale: expectation.rationale,
    observedLaunchBatchWidth,
    observedConcurrentWidth,
    observedUsefulWidth,
    successfulSettlements,
    widthUtilization,
    settlementCoverage,
    status,
    limitation: "Concurrency is observable only when launch timestamps or worker start/end timestamps are present; this diagnostic never overrides outcome checks.",
  };
}

export function summarizeTrace(trace, parallelismExpectation) {
  if (!trace) return undefined;
  const report = analyzeTrace(trace);
  const roleLaunches = {};
  let launches = 0;
  for (const event of trace.events ?? []) {
    if (event.kind !== "worker_launch") continue;
    launches += 1;
    roleLaunches[event.role] = (roleLaunches[event.role] ?? 0) + 1;
  }
  return {
    events: trace.events?.length ?? 0,
    elapsed: report.elapsed,
    toolUsage: report.toolUsage,
    launches,
    roleLaunches,
    parallelism: parallelismDiagnostics(trace, parallelismExpectation),
    graphs: report.graphs,
    repetition: {
      exactAnchorPairs: report.repetition.exactAnchorPairs.length,
      nearAnchorPairs: report.repetition.nearAnchorPairs.length,
      exactLabelPairs: report.repetition.exactLabelPairs.length,
      nearLabelPairs: report.repetition.nearLabelPairs.length,
      truncated: report.repetition.truncated,
    },
    signals: report.signals,
  };
}

export async function loadProspectiveArtifact(directory) {
  const root = resolve(directory);
  const manifestPath = join(root, "manifest.json");
  if (!(await exists(manifestPath))) throw new Error(`Prospective artifact has no manifest.json: ${root}`);
  const manifest = await readJson(manifestPath, "prospective manifest");
  const result = (await exists(join(root, "result.json")))
    ? await readJson(join(root, "result.json"), "prospective result")
    : undefined;
  const normalizedResult = result
    ? { ...result, dimensions: result.dimensions ?? summarizeResultDimensions(result) }
    : undefined;
  const trace = (await exists(join(root, "trace.json")))
    ? await readJson(join(root, "trace.json"), "prospective trace")
    : undefined;
  return {
    id: manifest.runId ?? basename(root),
    path: root,
    manifest,
    result: normalizedResult,
    diagnostics: summarizeTrace(trace, manifest.case?.parallelism),
  };
}

async function scanArtifactRoot(root, kind) {
  if (!(await exists(root))) return [];
  const discovered = [];
  async function visit(directory, depth) {
    if (depth > 4) return;
    if (await exists(join(directory, "manifest.json"))) {
      try {
        const artifact = { kind, ...(await loadProspectiveArtifact(directory)) };
        if (kind === "baseline" && await exists(join(directory, "baseline.json"))) {
          const baseline = await readJson(join(directory, "baseline.json"), "prospective baseline metadata");
          artifact.id = baseline.name ?? artifact.id;
          artifact.baseline = baseline;
        }
        discovered.push(artifact);
      } catch (error) {
        discovered.push({
          kind,
          id: basename(directory),
          path: directory,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(directory, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  return discovered;
}

export async function scanProspectiveArtifacts({ runsRoot = PROSPECTIVE_RUNS_ROOT, baselinesRoot = PROSPECTIVE_BASELINES_ROOT } = {}) {
  const [runs, baselines] = await Promise.all([
    scanArtifactRoot(runsRoot, "run"),
    scanArtifactRoot(baselinesRoot, "baseline"),
  ]);
  const byNewest = (left, right) => String(right.manifest?.runId ?? right.id).localeCompare(String(left.manifest?.runId ?? left.id));
  return { runs: runs.sort(byNewest), baselines: baselines.sort(byNewest) };
}

export async function promoteProspectiveBaseline(runDirectory, name, { force = false, baselineRoot = PROSPECTIVE_BASELINES_ROOT } = {}) {
  if (!SLUG.test(name ?? "")) throw new Error("Baseline name must be a lowercase slug");
  const artifact = await loadProspectiveArtifact(runDirectory);
  if (!artifact.result || artifact.result.status !== "passed") {
    throw new Error("Only a completed passing prospective run can become a baseline");
  }
  const caseId = artifact.manifest.case?.id;
  if (!SLUG.test(caseId ?? "")) throw new Error("Prospective manifest has no valid case id");
  const destination = join(resolve(baselineRoot), caseId, name);
  assertInside(baselineRoot, destination, "Baseline destination");
  if (await exists(destination)) {
    if (!force) throw new Error(`Baseline already exists: ${destination}`);
    await rm(destination, { recursive: true, force: true });
  }
  await mkdir(destination, { recursive: true });
  for (const filename of SAFE_BASELINE_FILES) {
    const source = join(artifact.path, filename);
    if (await exists(source)) await cp(source, join(destination, filename));
  }
  const safeFiles = [];
  for (const filename of SAFE_BASELINE_FILES) {
    if (await exists(join(destination, filename))) safeFiles.push(filename);
  }
  const baseline = {
    schemaVersion: 1,
    name,
    case: artifact.manifest.case,
    sourceRunId: artifact.id,
    promotedAt: new Date().toISOString(),
    safeFiles,
  };
  await writeFile(join(destination, "baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
  return { destination, baseline };
}

export function prospectiveCheckDimension(id) {
  if (id === "root-trajectory" || id === "lifecycle") return "measurement";
  if (id === "completion-signal" || id.endsWith("-delegation")) return "orchestration";
  return "workspace";
}

function dimensionStatus(total, passed) {
  if (total === 0) return "unavailable";
  return passed === total ? "passed" : "failed";
}

function changeVerdict(regressed, improved) {
  if (regressed && improved) return "mixed";
  if (regressed) return "regressed";
  if (improved) return "improved";
  return "unchanged";
}

export function summarizeResultDimensions(result) {
  const dimensions = {};
  for (const name of ["workspace", "orchestration", "measurement"]) {
    const checks = (result?.checks ?? []).filter((check) => prospectiveCheckDimension(check.id) === name);
    const passed = checks.filter((check) => check.passed).length;
    dimensions[name] = {
      passed,
      total: checks.length,
      status: dimensionStatus(checks.length, passed),
    };
  }
  return dimensions;
}

function checksById(result) {
  return new Map((result?.checks ?? []).map((check) => [check.id, check]));
}

function numericDelta(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined;
  return right - left;
}

function checkChange(before, after) {
  if (before === undefined && after !== undefined) return "added";
  if (before !== undefined && after === undefined) return "removed";
  if (before === after) return "unchanged";
  return after ? "improved" : "regressed";
}

export function compareProspectiveArtifacts(left, right) {
  if (!left.result || !right.result) {
    const incomplete = [left, right]
      .filter((artifact) => !artifact.result)
      .map((artifact) => artifact.id)
      .join(", ");
    throw new Error(`Comparison requires completed runs; still incomplete: ${incomplete}`);
  }
  if (left.manifest.case?.id !== right.manifest.case?.id) {
    throw new Error(`Cannot compare different cases: ${left.manifest.case?.id} and ${right.manifest.case?.id}`);
  }
  const leftChecks = checksById(left.result);
  const rightChecks = checksById(right.result);
  const checkIds = [...new Set([...leftChecks.keys(), ...rightChecks.keys()])].sort();
  const checks = checkIds.map((id) => {
    const before = leftChecks.get(id);
    const after = rightChecks.get(id);
    return {
      id,
      before: before?.passed,
      after: after?.passed,
      change: checkChange(before?.passed, after?.passed),
      beforeEvidence: before?.evidence,
      afterEvidence: after?.evidence,
    };
  });
  const contract = {
    status: checks.some((check) => check.change === "added" || check.change === "removed") ? "changed" : "same",
    addedChecks: checks.filter((check) => check.change === "added").map((check) => check.id),
    removedChecks: checks.filter((check) => check.change === "removed").map((check) => check.id),
  };
  const comparableChecks = checks.filter((check) => check.change !== "added" && check.change !== "removed");
  const hasRegression = comparableChecks.some((check) => check.change === "regressed");
  const hasImprovement = comparableChecks.some((check) => check.change === "improved");
  let verdict = "unchanged";
  if (hasRegression && hasImprovement) verdict = "mixed";
  else if (hasRegression) verdict = "regressed";
  else if (hasImprovement) verdict = "improved";
  else if (contract.status === "same" && right.result.reward < left.result.reward) verdict = "regressed";
  else if (contract.status === "same" && right.result.reward > left.result.reward) verdict = "improved";

  const leftDimensions = summarizeResultDimensions(left.result);
  const rightDimensions = summarizeResultDimensions(right.result);
  const leftElapsed = left.diagnostics?.elapsed ?? {};
  const rightElapsed = right.diagnostics?.elapsed ?? {};
  return {
    schemaVersion: 2,
    case: left.manifest.case,
    before: {
      id: left.id,
      kind: left.kind,
      candidate: left.manifest.candidate,
      status: left.result.status,
      reward: left.result.reward,
    },
    after: {
      id: right.id,
      kind: right.kind,
      candidate: right.manifest.candidate,
      status: right.result.status,
      reward: right.result.reward,
    },
    verdict,
    comparability: contract,
    checks,
    dimensions: Object.fromEntries(
      ["workspace", "orchestration", "measurement"].map((name) => {
        const dimensionChecks = comparableChecks.filter((check) => prospectiveCheckDimension(check.id) === name);
        const regressed = dimensionChecks.some((check) => check.change === "regressed");
        const improved = dimensionChecks.some((check) => check.change === "improved");
        const dimensionVerdict = changeVerdict(regressed, improved);
        return [name, {
          before: leftDimensions[name],
          after: rightDimensions[name],
          verdict: dimensionVerdict,
        }];
      }),
    ),
    process: {
      events: { before: left.diagnostics?.events, after: right.diagnostics?.events, delta: numericDelta(left.diagnostics?.events, right.diagnostics?.events) },
      launches: { before: left.diagnostics?.launches, after: right.diagnostics?.launches, delta: numericDelta(left.diagnostics?.launches, right.diagnostics?.launches) },
      wallElapsedMs: { before: leftElapsed.wallElapsedMs, after: rightElapsed.wallElapsedMs, delta: numericDelta(leftElapsed.wallElapsedMs, rightElapsed.wallElapsedMs) },
      activeElapsedMs: { before: leftElapsed.activeElapsedMs, after: rightElapsed.activeElapsedMs, delta: numericDelta(leftElapsed.activeElapsedMs, rightElapsed.activeElapsedMs) },
      roleLaunches: { before: left.diagnostics?.roleLaunches ?? {}, after: right.diagnostics?.roleLaunches ?? {} },
      parallelism: {
        before: left.result.parallelism ?? left.diagnostics?.parallelism,
        after: right.result.parallelism ?? right.diagnostics?.parallelism,
      },
      repetition: { before: left.diagnostics?.repetition, after: right.diagnostics?.repetition },
      signals: { before: left.diagnostics?.signals, after: right.diagnostics?.signals },
    },
  };
}

export function comparisonMarkdown(comparison) {
  const lines = [
    `# Prospective comparison — ${comparison.case.id}`,
    "",
    `**Verdict:** ${comparison.verdict.toUpperCase()}`,
    "",
    `- Before: \`${comparison.before.id}\` — ${comparison.before.status} (${comparison.before.reward})`,
    `- After: \`${comparison.after.id}\` — ${comparison.after.status} (${comparison.after.reward})`,
    `- Check contract: ${comparison.comparability.status}${comparison.comparability.status === "changed" ? ` (added: ${comparison.comparability.addedChecks.join(", ") || "none"}; removed: ${comparison.comparability.removedChecks.join(", ") || "none"})` : ""}`,
    "",
    "## Outcome dimensions",
    "",
    ...["workspace", "orchestration", "measurement"].map((name) => `- ${name}: ${comparison.dimensions[name].before.passed}/${comparison.dimensions[name].before.total} → ${comparison.dimensions[name].after.passed}/${comparison.dimensions[name].after.total} (${comparison.dimensions[name].verdict})`),
    "",
    "## Checks",
    "",
    "| Check | Before | After | Change |",
    "|---|---:|---:|---|",
    ...comparison.checks.map((check) => `| ${check.id} | ${check.before ?? "—"} | ${check.after ?? "—"} | ${check.change} |`),
    "",
    "## Process diagnostics",
    "",
    `- Events: ${comparison.process.events.before ?? "—"} → ${comparison.process.events.after ?? "—"} (${comparison.process.events.delta ?? "—"})`,
    `- Worker launches: ${comparison.process.launches.before ?? "—"} → ${comparison.process.launches.after ?? "—"} (${comparison.process.launches.delta ?? "—"})`,
    `- Useful width: ${comparison.process.parallelism.before?.observedUsefulWidth ?? "—"}/${comparison.process.parallelism.before?.expectedMaxUsefulWidth ?? "—"} → ${comparison.process.parallelism.after?.observedUsefulWidth ?? "—"}/${comparison.process.parallelism.after?.expectedMaxUsefulWidth ?? "—"}`,
    `- Wall time: ${comparison.process.wallElapsedMs.before ?? "—"} ms → ${comparison.process.wallElapsedMs.after ?? "—"} ms (${comparison.process.wallElapsedMs.delta ?? "—"} ms)`,
    "",
    "> Process deltas are diagnostic. They do not override deterministic task checks.",
  ];
  return `${lines.join("\n")}\n`;
}
