#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
  node scripts/advisor-eval.mjs ingest <session.jsonl> [--output <file>]
  node scripts/advisor-eval.mjs analyze <trace.json|session.jsonl> [--output <file>]
  node scripts/advisor-eval.mjs evaluate <fixture.json> [--trace <trace.json|session.jsonl>] [--output <file>]
  node scripts/advisor-eval.mjs compare <left.json> <right.json> [--output <file>]

Real trace ingestion defaults to evals/local/, which is gitignored. Raw message bodies,
summaries, raw tool payloads, and identity strings are never copied. Identity-like fields
become deterministic per-artifact aliases; other retained fields use closed categories.`;
}

function parseOptions(argv) {
  const [first = "help", ...rest] = argv;
  const command = first === "--help" || first === "-h" ? "help" : first;
  const positional = [];
  const options = { command, provided: new Set() };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--output" || value === "--trace") {
      const key = value.slice(2);
      const next = rest[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`Option ${value} requires a path`);
      if (options.provided.has(key)) throw new Error(`Duplicate option: ${value}`);
      options[key] = next;
      options.provided.add(key);
      index += 1;
    } else if (value === "--help" || value === "-h") options.help = true;
    else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  return { ...options, positional };
}

function requireAllowedOptions(options, allowed) {
  for (const key of options.provided) {
    if (!allowed.includes(key)) throw new Error(`Option --${key} is not valid for ${options.command}`);
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`Invalid ${label} JSON: ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function loadTrace(path) {
  const contents = await readFile(path, "utf8");
  if (extname(path).toLowerCase() === ".jsonl") {
    return normalizeSession(parseJsonl(contents));
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw new Error(`Invalid trace JSON: ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  analyzeTrace(parsed);
  return parsed;
}

function defaultIngestOutput(normalized) {
  return join(ROOT, "evals", "local", `${normalized.source.artifactAlias}.normalized.json`);
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
  let displayPath = output;
  if (path.startsWith(`${ROOT}/`)) displayPath = relative(ROOT, path);
  else if (isAbsolute(output)) displayPath = path;
  process.stdout.write(`${displayPath}\n`);
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
    requireAllowedOptions(options, ["output"]);
    requirePositionals(options, 1, "ingest <session.jsonl>");
    const normalized = await loadTrace(resolve(options.positional[0]));
    await emitJson(normalized, options.output ?? defaultIngestOutput(normalized));
    return;
  }

  if (options.command === "analyze") {
    requireAllowedOptions(options, ["output"]);
    requirePositionals(options, 1, "analyze <trace.json|session.jsonl>");
    const normalized = await loadTrace(resolve(options.positional[0]));
    await emitJson(analyzeTrace(normalized), options.output);
    return;
  }

  if (options.command === "evaluate") {
    requireAllowedOptions(options, ["output", "trace"]);
    requirePositionals(options, 1, "evaluate <fixture.json>");
    const fixturePath = resolve(options.positional[0]);
    const fixture = await readJson(fixturePath, "fixture");
    const tracePath = resolve(dirname(fixturePath), options.trace ?? fixture.trace ?? "trace.jsonl");
    const normalized = await loadTrace(tracePath);
    const validation = validateFixture(fixture, normalized);
    if (!validation.valid) throw new Error(`Invalid fixture:\n- ${validation.errors.join("\n- ")}`);
    await emitJson(createRubricPacket(fixture, normalized), options.output);
    return;
  }

  if (options.command === "compare") {
    requireAllowedOptions(options, ["output"]);
    requirePositionals(options, 2, "compare <left.json> <right.json>");
    const metrics = [];
    for (const path of options.positional) {
      const value = await readJson(resolve(path), "comparison input");
      metrics.push(Array.isArray(value?.events) ? analyzeTrace(value) : value);
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
