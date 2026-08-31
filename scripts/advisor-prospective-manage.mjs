#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessRevision, localPiDetachRevision, runProspectiveCase } from "./advisor-prospective.mjs";
import {
  CANDIDATE_INPUTS,
  PROJECT_ROOT,
  PROSPECTIVE_EVALUATOR_INPUTS,
  PROSPECTIVE_CASES_ROOT,
  PROSPECTIVE_RUNS_ROOT,
  candidateFingerprint,
  compareProspectiveArtifacts,
  comparisonMarkdown,
  loadProspectiveArtifact,
  promoteProspectiveBaseline,
  prospectiveSuiteFingerprint,
  scanProspectiveArtifacts,
} from "./advisor-prospective-results.mjs";

function usage() {
  return `Prospective Eval Management

Usage:
  node scripts/advisor-prospective-manage.mjs list [--json]
  node scripts/advisor-prospective-manage.mjs compare <before> <after> [--format json|markdown] [--output <path>]
  node scripts/advisor-prospective-manage.mjs baseline <run> --name <slug> [--force] [--allow-failed]
  node scripts/advisor-prospective-manage.mjs suite [case-id ...] [options]

Suite options:
  --trials <number>             Trials per case (default: 1, max: 10)
  --name <label>                Setup-version name (default: working-tree)
  --profile <name>              Advisor intelligence profile
  --model <provider/model>      Root advisor model
  --thinking <level>            Root advisor thinking level
  --timeout-minutes <number>    Per-run timeout

Artifact references may be directories, run IDs, baseline names, or unambiguous ID prefixes.`;
}

function parse(argv) {
  const command = argv[0] ?? "help";
  const positionals = [];
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (["allow-failed", "force", "json"].includes(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    flags[key] = value;
    index += 1;
  }
  return { command, positionals, flags };
}

async function artifactReference(subject) {
  if (!subject) throw new Error("An artifact reference is required");
  const asPath = resolve(subject);
  try {
    return await loadProspectiveArtifact(asPath);
  } catch (error) {
    if (!String(error?.message).includes("no manifest.json") && !String(error?.message).includes("Could not read")) throw error;
  }
  const { runs, baselines } = await scanProspectiveArtifacts();
  const matches = [...runs, ...baselines].filter((artifact) =>
    artifact.id === subject
    || artifact.id.startsWith(subject)
    || basename(artifact.path) === subject
    || artifact.path.endsWith(`/${subject}`)
  );
  if (!matches.length) throw new Error(`No prospective artifact matches: ${subject}`);
  if (matches.length > 1) throw new Error(`Prospective artifact reference is ambiguous: ${subject}`);
  return matches[0];
}

function listText({ runs, baselines }) {
  const rows = [];
  for (const artifact of [...baselines, ...runs]) {
    rows.push([
      artifact.kind,
      artifact.manifest?.case?.id ?? "unknown-case",
      artifact.result?.status ?? "incomplete",
      artifact.result?.reward ?? "—",
      artifact.manifest?.candidate?.label ?? "unlabelled",
      artifact.id,
    ]);
  }
  if (!rows.length) return "No prospective runs or baselines found.\n";
  const widths = ["KIND", "CASE", "STATUS", "REWARD", "SETUP", "ID"].map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => String(row[index]).length))
  );
  const render = (row) => row.map((value, index) => String(value).padEnd(widths[index])).join("  ").trimEnd();
  return `${render(["KIND", "CASE", "STATUS", "REWARD", "SETUP", "ID"])}\n${rows.map(render).join("\n")}\n`;
}

async function allCaseIds() {
  const ids = [];
  for (const entry of await readdir(PROSPECTIVE_CASES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const definition = JSON.parse(await readFile(join(PROSPECTIVE_CASES_ROOT, entry.name, "case.json"), "utf8"));
      if (definition.id === entry.name) ids.push(entry.name);
    } catch {
      // Invalid cases are rejected by the runner; omit them from automatic discovery.
    }
  }
  return ids.sort();
}

function suiteStamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(".", "-");
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function command(commandName, args) {
  const result = spawnSync(commandName, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${commandName} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  return result.stdout;
}

async function copySetupInputs(sourceRoot, snapshotRoot) {
  for (const subject of [...CANDIDATE_INPUTS, ...PROSPECTIVE_EVALUATOR_INPUTS]) {
    const source = join(sourceRoot, subject);
    if (!(await exists(source))) continue;
    const destination = join(snapshotRoot, subject);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }
}

async function copyTrackedCheckout(source, destination) {
  const tracked = command("git", ["-C", source, "ls-files", "-z"])
    .split("\0")
    .filter(Boolean);
  for (const subject of tracked) {
    const target = join(destination, subject);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(source, subject), target, { recursive: true });
  }
}

export async function createSuiteSetupSnapshot({
  suiteDir,
  sourceRoot = PROJECT_ROOT,
  piDetachSource = process.env.ADVISOR_EVAL_PI_DETACH_SOURCE,
} = {}) {
  if (!suiteDir) throw new Error("suiteDir is required for a setup snapshot");
  const snapshotRoot = join(resolve(suiteDir), "setup-snapshot");
  if (await exists(snapshotRoot)) throw new Error(`Suite setup snapshot already exists: ${snapshotRoot}`);
  await mkdir(snapshotRoot, { recursive: true });
  await copySetupInputs(resolve(sourceRoot), snapshotRoot);

  const localPiDetach = localPiDetachRevision(piDetachSource);
  let piDetach;
  if (localPiDetach) {
    const path = join(snapshotRoot, "external", "pi-detach");
    await copyTrackedCheckout(localPiDetach.path, path);
    piDetach = { path, revision: localPiDetach.revision, source: "suite-snapshot" };
  }

  const fingerprintOptions = { piDetachRevision: piDetach?.revision };
  const [sourceCandidate, snapshotCandidate, sourceEvaluation, snapshotEvaluation] = await Promise.all([
    candidateFingerprint(sourceRoot, fingerprintOptions),
    candidateFingerprint(snapshotRoot, fingerprintOptions),
    prospectiveSuiteFingerprint(sourceRoot),
    prospectiveSuiteFingerprint(snapshotRoot),
  ]);
  if (sourceCandidate.value !== snapshotCandidate.value || sourceEvaluation.value !== snapshotEvaluation.value) {
    throw new Error("Suite setup snapshot does not match its source tree");
  }
  const identity = {
    schemaVersion: 1,
    source: harnessRevision(),
    candidateFingerprint: snapshotCandidate,
    evaluationFingerprint: snapshotEvaluation,
    ...(piDetach ? { piDetach: { source: piDetach.source, revision: piDetach.revision } } : {}),
  };
  await writeFile(join(snapshotRoot, "setup.json"), `${JSON.stringify(identity, null, 2)}\n`);
  return { root: snapshotRoot, identity, piDetach };
}

async function assertSnapshotIdentity(snapshot) {
  const [candidate, evaluation] = await Promise.all([
    candidateFingerprint(snapshot.root, { piDetachRevision: snapshot.piDetach?.revision }),
    prospectiveSuiteFingerprint(snapshot.root),
  ]);
  if (candidate.value !== snapshot.identity.candidateFingerprint.value) {
    throw new Error("Suite setup snapshot changed during execution");
  }
  if (evaluation.value !== snapshot.identity.evaluationFingerprint.value) {
    throw new Error("Suite case snapshot changed during execution");
  }
}

export function summarizeSuiteResults(results) {
  const dimensions = {};
  for (const name of ["workspace", "orchestration", "measurement"]) {
    const values = results.map((entry) => entry.result.dimensions?.[name]).filter(Boolean);
    dimensions[name] = {
      passed: values.reduce((sum, value) => sum + value.passed, 0),
      total: values.reduce((sum, value) => sum + value.total, 0),
      cleanRuns: values.filter((value) => value.status === "passed").length,
      runs: values.length,
    };
  }
  const parallel = results.map((entry) => entry.result.parallelism).filter(Boolean);
  const utilizationValues = parallel.map((value) => value.widthUtilization).filter(Number.isFinite);
  return {
    dimensions,
    parallelism: {
      availableRuns: parallel.length,
      utilizedRuns: parallel.filter((value) => value.status === "utilized").length,
      underutilizedRuns: parallel.filter((value) => value.status === "underutilized").length,
      unsettledRuns: parallel.filter((value) => value.status === "launched-not-settled").length,
      oversubscribedRuns: parallel.filter((value) => value.status === "oversubscribed").length,
      averageWidthUtilization: utilizationValues.length
        ? utilizationValues.reduce((sum, value) => sum + value, 0) / utilizationValues.length
        : null,
    },
  };
}

export async function runSuite(caseIds, flags = {}) {
  const trials = Number(flags.trials ?? 1);
  if (!Number.isInteger(trials) || trials < 1 || trials > 10) throw new Error("trials must be an integer from 1 through 10");
  const selected = caseIds.length ? caseIds : await allCaseIds();
  if (!selected.length) throw new Error("No prospective cases selected");
  const setupName = flags.name ?? flags.candidate ?? "working-tree";
  const suiteId = `${suiteStamp()}--${String(setupName).replace(/[^a-zA-Z0-9-]+/g, "-")}`;
  const suiteDir = join(PROSPECTIVE_RUNS_ROOT, "suites", suiteId);
  await mkdir(suiteDir, { recursive: true });
  const snapshot = await createSuiteSetupSnapshot({ suiteDir });
  const results = [];
  const writeSummary = async (status, extra = {}) => {
    const passed = results.filter((entry) => entry.result.status === "passed").length;
    const summary = {
      schemaVersion: 2,
      suiteId,
      suiteDir,
      status,
      name: setupName,
      candidate: setupName,
      setup: snapshot.identity,
      trials,
      selected,
      cases: selected.length,
      runs: results.length,
      passed,
      failed: results.length - passed,
      ...summarizeSuiteResults(results),
      results,
      ...extra,
    };
    await writeFile(join(suiteDir, "suite.json"), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  };
  await writeSummary("running");
  try {
    for (const caseId of selected) {
      for (let trial = 1; trial <= trials; trial += 1) {
        await assertSnapshotIdentity(snapshot);
        const finished = await runProspectiveCase({
          subject: caseId,
          profile: flags.profile,
          candidateLabel: setupName,
          model: flags.model,
          thinking: flags.thinking,
          timeoutMinutes: flags["timeout-minutes"],
          setupRoot: snapshot.root,
          setupRevision: snapshot.identity.source,
          piDetachSource: snapshot.piDetach?.path,
          piDetachRevision: snapshot.piDetach?.revision,
        });
        await assertSnapshotIdentity(snapshot);
        if (finished.result.candidate.fingerprint.value !== snapshot.identity.candidateFingerprint.value) {
          throw new Error(`Run ${finished.result.runId} did not use the frozen suite setup`);
        }
        results.push({ caseId, trial, runDir: finished.runDir, result: finished.result });
        await writeSummary("running");
      }
    }
    return await writeSummary("completed");
  } catch (error) {
    await writeSummary("aborted", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function runManageCli(argv) {
  const { command, positionals, flags } = parse(argv);
  if (["help", "--help", "-h"].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "list") {
    const artifacts = await scanProspectiveArtifacts();
    process.stdout.write(flags.json ? `${JSON.stringify(artifacts, null, 2)}\n` : listText(artifacts));
    return;
  }
  if (command === "compare") {
    if (positionals.length !== 2) throw new Error("compare requires before and after artifact references");
    const [left, right] = await Promise.all(positionals.map(artifactReference));
    const comparison = compareProspectiveArtifacts(left, right);
    const rendered = flags.format === "markdown" ? comparisonMarkdown(comparison) : `${JSON.stringify(comparison, null, 2)}\n`;
    if (flags.output) await writeFile(resolve(flags.output), rendered);
    else process.stdout.write(rendered);
    return;
  }
  if (command === "baseline") {
    if (positionals.length !== 1 || !flags.name) throw new Error("baseline requires one run reference and --name <slug>");
    const artifact = await artifactReference(positionals[0]);
    if (artifact.kind === "baseline") throw new Error("A baseline cannot be promoted from another baseline");
    const promoted = await promoteProspectiveBaseline(artifact.path, flags.name, {
      force: flags.force,
      allowFailed: flags["allow-failed"],
    });
    process.stdout.write(`${JSON.stringify(promoted, null, 2)}\n`);
    return;
  }
  if (command === "suite") {
    const summary = await runSuite(positionals, flags);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runManageCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
