#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeTrace,
  compareMetrics,
  createRubricPacket,
  normalizeSession,
  parseJsonl,
  validateFixture,
} from "./advisor-eval-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Advisor Eval

Usage:
  node scripts/advisor-eval.mjs ingest <session.jsonl> [--output <file>] [--include-summaries]
  node scripts/advisor-eval.mjs analyze <trace.json|session.jsonl> [--output <file>]
  node scripts/advisor-eval.mjs evaluate <fixture.json> [--trace <trace.json|session.jsonl>] [--output <file>]
  node scripts/advisor-eval.mjs compare <left.json> <right.json> [--output <file>]

Real trace ingestion defaults to evals/local/, which is gitignored. Raw message bodies and
raw tool payloads are never copied. --include-summaries accepts only explicitly tagged
EVAL_SUMMARY: lines and sanitizes them.`;
}

function parseOptions(argv) {
  const [first = "help", ...rest] = argv;
  const command = first === "--help" || first === "-h" ? "help" : first;
  const positional = [];
  const options = { command, includeSummaries: false };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--output") options.output = rest[++index];
    else if (value === "--trace") options.trace = rest[++index];
    else if (value === "--include-summaries") options.includeSummaries = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  if (("output" in options && !options.output) || ("trace" in options && !options.trace)) {
    throw new Error("Options --output and --trace require a path");
  }
  return { ...options, positional };
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`Invalid ${label} JSON: ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function loadTrace(path, includeSummaries = false) {
  const contents = await readFile(path, "utf8");
  if (extname(path).toLowerCase() === ".jsonl") {
    return normalizeSession(parseJsonl(contents), { includeSummaries });
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw new Error(`Invalid trace JSON: ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed?.events)) {
    throw new Error(`Trace is not normalized schemaVersion 1: ${path}`);
  }
  return parsed;
}

function defaultIngestOutput(input) {
  const name = basename(input, extname(input)).replace(/[^a-zA-Z0-9._-]+/g, "-") || "session";
  return join(ROOT, "evals", "local", `${name}.normalized.json`);
}

async function emitJson(value, output) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (!output) {
    process.stdout.write(contents);
    return;
  }
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
  process.stdout.write(`${isAbsolute(output) ? path : output}\n`);
}

function requirePositionals(options, count, example) {
  if (options.positional.length !== count) throw new Error(`Expected ${example}`);
}

export async function runCli(argv) {
  const options = parseOptions(argv);
  if (options.help || options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (options.command === "ingest") {
    requirePositionals(options, 1, "ingest <session.jsonl>");
    const [input] = options.positional;
    const normalized = await loadTrace(resolve(input), options.includeSummaries);
    await emitJson(normalized, options.output ?? defaultIngestOutput(input));
    return;
  }

  if (options.command === "analyze") {
    requirePositionals(options, 1, "analyze <trace.json|session.jsonl>");
    const normalized = await loadTrace(resolve(options.positional[0]), options.includeSummaries);
    await emitJson(analyzeTrace(normalized), options.output);
    return;
  }

  if (options.command === "evaluate") {
    requirePositionals(options, 1, "evaluate <fixture.json>");
    const fixturePath = resolve(options.positional[0]);
    const fixture = await readJson(fixturePath, "fixture");
    const tracePath = resolve(dirname(fixturePath), options.trace ?? fixture.trace ?? "trace.jsonl");
    const normalized = await loadTrace(
      tracePath,
      options.includeSummaries || fixture.ingest?.includeTaggedSummaries === true,
    );
    const validation = validateFixture(fixture, normalized);
    if (!validation.valid) throw new Error(`Invalid fixture:\n- ${validation.errors.join("\n- ")}`);
    await emitJson(createRubricPacket(fixture, normalized), options.output);
    return;
  }

  if (options.command === "compare") {
    requirePositionals(options, 2, "compare <left.json> <right.json>");
    const metrics = [];
    for (const path of options.positional) {
      const value = await readJson(resolve(path), "comparison input");
      metrics.push(value?.diagnosticOnly && value?.elapsed ? value : analyzeTrace(value));
    }
    await emitJson(compareMetrics(metrics[0], metrics[1]), options.output);
    return;
  }

  throw new Error(`Unknown command: ${options.command}\n\n${usage()}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
