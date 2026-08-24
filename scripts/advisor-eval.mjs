#!/usr/bin/env node

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTrace, normalizeSession, parseJsonl } from "./advisor-eval-lib.mjs";
import { createHarborTask } from "./advisor-harbor-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Advisor Trace Preparation for Harbor

Usage:
  node scripts/advisor-eval.mjs ingest <session.jsonl> [--output <file>]
  node scripts/advisor-eval.mjs analyze <trace.json|session.jsonl> [--output <file>]
  node scripts/advisor-eval.mjs harbor-task <fixture.json> [--trace <trace.json|session.jsonl>] [--output <directory>]

Real trace ingestion defaults to evals/local/, which is gitignored. Raw message bodies,
summaries, raw tool payloads, and identity strings are never copied. Identity-like fields
become deterministic per-artifact aliases; other retained fields use closed categories.
Harbor owns evaluation execution, rewards, result storage, viewing, and comparison.`;
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

function defaultHarborOutput(fixture) {
  return join(ROOT, "evals", "local", "harbor", fixture.id);
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

async function writeHarborTask(task, output) {
  const outputRoot = resolve(output);
  await rm(join(outputRoot, "tests", "advisor.toml"), { force: true });
  for (const [relativePath, contents] of Object.entries(task.files)) {
    const path = resolve(outputRoot, relativePath);
    if (!path.startsWith(`${outputRoot}/`)) throw new Error(`Unsafe Harbor task path: ${relativePath}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
  await chmod(join(outputRoot, "tests", "test.sh"), 0o755);
  const displayPath = outputRoot.startsWith(`${ROOT}/`) ? relative(ROOT, outputRoot) : outputRoot;
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

  if (options.command === "harbor-task") {
    requireAllowedOptions(options, ["output", "trace"]);
    requirePositionals(options, 1, "harbor-task <fixture.json>");
    const fixturePath = resolve(options.positional[0]);
    const fixture = await readJson(fixturePath, "fixture");
    const tracePath = resolve(dirname(fixturePath), options.trace ?? fixture.trace ?? "trace.jsonl");
    const normalized = await loadTrace(tracePath);
    const task = createHarborTask(fixture, normalized);
    await writeHarborTask(task, options.output ?? defaultHarborOutput(fixture));
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
