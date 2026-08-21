import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  analyzeTrace,
  createRubricPacket,
  normalizeSession,
  parseJsonl,
  sanitizeMetadataText,
  validateFixture,
} from "../scripts/advisor-eval-lib.mjs";
import { runCli } from "../scripts/advisor-eval.mjs";


const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "advisor-eval.mjs");
const CASE_DIR = join(ROOT, "evals", "cases", "evidence-rich-routing-defect");

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
}

async function syntheticInputs() {
  const trace = parseJsonl(await readFile(join(CASE_DIR, "trace.jsonl"), "utf8"));
  const normalized = normalizeSession(trace, { includeSummaries: true });
  const fixture = JSON.parse(await readFile(join(CASE_DIR, "fixture.json"), "utf8"));
  return { fixture, normalized };
}

test("parseJsonl reports malformed input with its line number", () => {
  assert.equal(typeof runCli, "function");
  assert.throws(
    () => parseJsonl('{"type":"session"}\nnot-json\n'),
    /Invalid JSONL at line 2/,
  );
});

test("normalization retains bounded metadata without raw bodies or payloads", () => {
  const privateBody = "Private narrative for person@example.test at /Users/alice/secret/project";
  const secret = ["sk", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
  const entries = [
    { type: "session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/Users/alice/private" },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: privateBody }] },
    },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Unmarked assistant decision text must not be copied" },
          {
            type: "toolCall",
            id: "launch-1",
            name: "bg_agent",
            arguments: {
              name: "private-builder",
              role: "builder",
              model: "provider/model",
              label: `repair ${secret} at /Users/alice/private`,
              anchor: `Never store this anchor body ${secret}`,
              prompt: `Full tool payload ${privateBody}`,
            },
          },
        ],
      },
    },
  ];

  const normalized = normalizeSession(entries);
  const serialized = JSON.stringify(normalized);
  assert.equal(normalized.redaction.rawMessageBodiesCopied, false);
  assert.equal(normalized.redaction.rawToolPayloadsCopied, false);
  assert.equal(normalized.redaction.anchorTextStored, false);
  assert(!serialized.includes(privateBody));
  assert(!serialized.includes("Unmarked assistant decision"));
  assert(!serialized.includes("Never store this anchor body"));
  assert(!serialized.includes(secret));
  assert(!serialized.includes("/Users/alice"));
  const launch = normalized.events.find((event) => event.kind === "worker_launch");
  assert.equal(launch.role, "builder");
  assert.equal(launch.model, "provider/model");
  assert.match(launch.label, /\[secret\]/);
  assert.match(launch.label, /\[path\]/);
  assert.match(launch.anchorFingerprint, /^[0-9a-f]{16}$/);
});

test("only explicitly tagged summaries are retained and sanitized", () => {
  const entries = parseJsonl([
    JSON.stringify({
      type: "message",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hidden preface\nEVAL_SUMMARY: Inspect ABC-123 at person@example.test under /Users/alice/project" }],
      },
    }),
  ].join("\n"));
  const without = normalizeSession(entries);
  assert.equal(without.events.length, 0);
  const withSummaries = normalizeSession(entries, { includeSummaries: true });
  assert.equal(withSummaries.events.length, 1);
  assert.equal(withSummaries.events[0].summary, "Inspect [ticket] at [email] under [path]");
  assert(!JSON.stringify(withSummaries).includes("Hidden preface"));
});

test("synthetic case metrics match the committed deterministic baseline", async () => {
  const { fixture, normalized } = await syntheticInputs();
  const baseline = JSON.parse(await readFile(join(CASE_DIR, "baseline-report.json"), "utf8"));
  assert.deepEqual(validateFixture(fixture, normalized), { valid: true, errors: [] });
  assert.deepEqual(analyzeTrace(normalized), baseline.metrics);
  assert.equal(baseline.metrics.workers.failedLaunches, 1);
  assert.equal(baseline.metrics.workers.resumedLaunches, 1);
  assert.equal(baseline.metrics.workers.recoveryRatio, 1);
  assert.equal(baseline.metrics.graphs.parallelWaves, 1);
  assert.deepEqual(baseline.metrics.repetition.nearLabelPairs, [["e0014", "e0018"]]);
  assert.equal(baseline.metrics.signals.builderInvalidations, 1);
  assert.equal(baseline.metrics.signals.userStops, 1);
});

test("fixture validation requires all dimensions and multiple good actions", async () => {
  const { fixture, normalized } = await syntheticInputs();
  const invalid = structuredClone(fixture);
  invalid.rubric.dimensions.pop();
  invalid.checkpoints[0].acceptableNextActions = invalid.checkpoints[0].acceptableNextActions.slice(0, 1);
  const validation = validateFixture(invalid, normalized);
  assert.equal(validation.valid, false);
  assert(validation.errors.some((error) => error.includes("safetyCommunication")));
  assert(validation.errors.some((error) => error.includes("at least two acceptable next actions")));
});

test("rubric packet exposes a future external judge contract", async () => {
  const { fixture, normalized } = await syntheticInputs();
  const packet = createRubricPacket(fixture, normalized);
  assert.equal(packet.packetType, "advisor-rubric-judge-input");
  assert.equal(packet.judgeBoundary.implementation, "external");
  assert.match(packet.judgeBoundary.instruction, /Multiple checkpoint actions may be good/);
  assert.equal(packet.judgeBoundary.outputSchema.dimensions.length, 5);
  assert.equal(packet.sanitizedTrace.redaction.rawMessageBodiesCopied, false);
});

test("CLI ingests privately, analyzes, evaluates, compares, and shows help", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-eval-test-"));
  const tracePath = join(temp, "session.jsonl");
  const normalizedPath = join(temp, "normalized.json");
  const metricsPath = join(temp, "metrics.json");
  const packetPath = join(temp, "packet.json");
  const comparisonPath = join(temp, "comparison.json");
  await writeFile(
    tracePath,
    `${JSON.stringify({ type: "session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/Users/private/work" })}\n`,
  );

  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Advisor Eval/);

  const ingest = run("ingest", tracePath, "--output", normalizedPath);
  assert.equal(ingest.status, 0, ingest.stderr);
  const normalized = JSON.parse(await readFile(normalizedPath, "utf8"));
  assert.equal(normalized.source.textPolicy, "no-message-text");

  const analyze = run("analyze", normalizedPath, "--output", metricsPath);
  assert.equal(analyze.status, 0, analyze.stderr);
  assert.equal(JSON.parse(await readFile(metricsPath, "utf8")).diagnosticOnly, true);

  const evaluate = run("evaluate", join(CASE_DIR, "fixture.json"), "--output", packetPath);
  assert.equal(evaluate.status, 0, evaluate.stderr);
  assert.equal(JSON.parse(await readFile(packetPath, "utf8")).packetType, "advisor-rubric-judge-input");

  const compare = run("compare", metricsPath, metricsPath, "--output", comparisonPath);
  assert.equal(compare.status, 0, compare.stderr);
  assert(JSON.parse(await readFile(comparisonPath, "utf8")).deltas.every((entry) => entry.delta === 0));
  await rm(temp, { recursive: true, force: true });
});

test("metadata sanitizer is bounded", () => {
  const value = sanitizeMetadataText(`visit https://example.test/${"x".repeat(300)}`, 40);
  assert.equal(value, "visit [url]");
  assert(value.length <= 40);
});
