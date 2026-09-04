import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  FIXTURES_DIR,
  RULE_CODES,
  SCHEMA_PATH,
  eventTypes,
  loadSchema,
  parseTrace,
  projectTrace,
  validateTrace,
} from "../scripts/advisor-trace.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../scripts/advisor-trace.mjs", import.meta.url));
const DONE = join(FIXTURES_DIR, "one-worker-done.jsonl");
const BLOCKED = join(FIXTURES_DIR, "one-worker-blocked.jsonl");

const fixture = async (path) => parseTrace(await readFile(path, "utf8"));
const clone = (events) => JSON.parse(JSON.stringify(events));
const codes = (result) => result.problems.map((problem) => problem.code);
const expectCode = (result, code) => {
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes(code), `expected ${code}, got ${JSON.stringify(result.problems)}`);
};

test("both fixtures validate with zero problems and together cover every v1 event type", async () => {
  const schema = await loadSchema();
  const seen = new Set();
  for (const path of [DONE, BLOCKED]) {
    const events = await fixture(path);
    const result = validateTrace(events, schema);
    assert.deepEqual(result, { ok: true, problems: [] }, `${path}: ${JSON.stringify(result.problems)}`);
    for (const event of events) seen.add(event.type);
  }
  assert.deepEqual([...seen].sort(), [...eventTypes(schema)].sort());
  assert.equal(eventTypes(schema).length, 8);
});

test("the CLI exits 0 on a valid fixture and 1 with named problems on a broken trace", async () => {
  const ok = await run(process.execPath, [CLI, "validate", DONE]);
  assert.match(ok.stdout, /^ok: 7 event\(s\)/);

  const events = await fixture(DONE);
  const broken = events.filter((event) => event.type !== "node.result.validated").map((event, index) => ({ ...event, seq: index + 1 }));
  const dir = await mkdtemp(join(tmpdir(), "advisor-trace-"));
  try {
    const path = join(dir, "broken.jsonl");
    await writeFile(path, `${broken.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const bad = await run(process.execPath, [CLI, "validate", path]).catch((error) => error);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /E_SETTLE seq 5/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("projection derives node state, result status, and the parent wake", async () => {
  const events = await fixture(DONE);
  const projection = projectTrace(events);
  assert.equal(projection.run.id, "fixture-one-worker-done");
  assert.equal(projection.run.root, "advisor");
  assert.equal(projection.run.lastSeq, 7);
  assert.equal(projection.nodes.length, 1);
  const [node] = projection.nodes;
  assert.equal(node.id, "builder-1");
  assert.equal(node.parent, "advisor");
  assert.equal(node.state, "settled");
  assert.equal(node.settledStatus, "done");
  assert.equal(node.resultStatus, "PASS");
  assert.equal(node.resultValid, true);
  assert.equal(node.surfaceClosed, true);
  assert.equal(node.progress.length, 1);
  assert.deepEqual(projection.wakes, [{ parent: "advisor", child: "builder-1", childStatus: "done", generation: 1, at: "2026-09-04T20:04:03.000Z" }]);

  const blocked = projectTrace(await fixture(BLOCKED));
  assert.equal(blocked.nodes[0].settledStatus, "blocked");
  assert.equal(blocked.nodes[0].blockedRequest.kind, "decision");
  assert.equal(blocked.nodes[0].surfaceClosed, false);
});

test("structural rules each reject a specific mutation with their own code", async () => {
  const schema = await loadSchema();
  const done = await fixture(DONE);
  const blocked = await fixture(BLOCKED);
  const reseq = (events) => events.map((event, index) => ({ ...event, seq: index + 1 }));
  const check = (events) => validateTrace(events, schema);

  // seq must be contiguous from 1
  const gap = clone(done);
  gap[3].seq = 9;
  expectCode(check(gap), RULE_CODES.SEQ);

  // run.created must be first and unique
  expectCode(check(reseq(done.slice(1))), RULE_CODES.FIRST);
  const twice = clone(done);
  twice.splice(3, 0, { ...twice[0] });
  expectCode(check(reseq(twice)), RULE_CODES.FIRST);
  expectCode(check([]), RULE_CODES.FIRST);

  // all events share one run id
  const mixed = clone(done);
  mixed[2].run = "another-run";
  expectCode(check(mixed), RULE_CODES.RUN);

  // timestamps never decrease
  const backwards = clone(done);
  backwards[4].at = "2026-09-04T19:00:00.000Z";
  expectCode(check(backwards), RULE_CODES.TIME);

  // node events need a prior launch, and a settled node accepts no more events
  const early = clone(done);
  [early[1], early[2]] = [early[2], early[1]];
  expectCode(check(reseq(early)), RULE_CODES.ORDER);
  const afterSettle = clone(done);
  afterSettle.splice(6, 0, { ...afterSettle[2] });
  expectCode(check(reseq(afterSettle)), RULE_CODES.ORDER);
  const relaunch = clone(done);
  relaunch.splice(3, 0, { ...relaunch[1] });
  expectCode(check(reseq(relaunch)), RULE_CODES.ORDER);

  // validated requires written with the same path
  const unwritten = reseq(done.filter((event) => event.type !== "node.result.written"));
  expectCode(check(unwritten), RULE_CODES.RESULT_ORDER);
  const otherPath = clone(done);
  otherPath[4].data.path = "/elsewhere/result.md";
  expectCode(check(otherPath), RULE_CODES.RESULT_ORDER);
  const validWithoutStatus = clone(done);
  delete validWithoutStatus[4].data.status;
  expectCode(check(validWithoutStatus), RULE_CODES.RESULT_ORDER);

  // done and blocked settlements require a prior valid validation
  const noValidation = reseq(done.filter((event) => event.type !== "node.result.validated"));
  expectCode(check(noValidation), RULE_CODES.SETTLE);
  const invalidResult = clone(done);
  invalidResult[4].data = { path: invalidResult[4].data.path, valid: false, problems: ["Claims section is empty"] };
  expectCode(check(invalidResult), RULE_CODES.SETTLE);
  const stalled = clone(invalidResult);
  stalled[5].data = { status: "stalled", reason: "result artifact is invalid" };
  stalled[6].data.childStatus = "stalled";
  assert.deepEqual(check(stalled), { ok: true, problems: [] });

  // blocked settlement requires node.blocked
  const silentBlock = reseq(blocked.filter((event) => event.type !== "node.blocked"));
  expectCode(check(silentBlock), RULE_CODES.BLOCKED);

  // wakes: only after settlement, to the right parent, one per child, increasing generation
  const eagerWake = clone(done);
  [eagerWake[5], eagerWake[6]] = [eagerWake[6], eagerWake[5]];
  expectCode(check(reseq(eagerWake)), RULE_CODES.WAKE);
  const wrongParent = clone(done);
  wrongParent[6].node = "builder-1";
  expectCode(check(wrongParent), RULE_CODES.WAKE);
  const doubleWake = clone(done);
  doubleWake.push({ ...doubleWake[6], seq: 8, data: { ...doubleWake[6].data, wakeGeneration: 2 } });
  expectCode(check(doubleWake), RULE_CODES.WAKE);
  const badGeneration = clone(done);
  badGeneration[6].data.wakeGeneration = 3;
  expectCode(check(badGeneration), RULE_CODES.WAKE);
  const statusDrift = clone(done);
  statusDrift[6].data.childStatus = "failed";
  expectCode(check(statusDrift), RULE_CODES.WAKE);

  // parent links must resolve to the root or a launched, unsettled node
  const orphan = clone(done);
  for (const event of orphan.slice(1, 6)) event.parent = "ghost-foreman";
  expectCode(check(orphan), RULE_CODES.PARENT_LINK);
  const driftingParent = clone(done);
  driftingParent[3].parent = "advisor-2";
  expectCode(check(driftingParent), RULE_CODES.PARENT_LINK);
});

test("schema-level probes fail through the JSON Schema file alone", async () => {
  const schema = await loadSchema();
  const done = await fixture(DONE);
  const check = (events) => validateTrace(events, schema);

  const unknownType = clone(done);
  unknownType[2].type = "node.cancelled";
  expectCode(check(unknownType), RULE_CODES.SCHEMA);

  const extraField = clone(done);
  extraField[2].pane = "pane-7";
  expectCode(check(extraField), RULE_CODES.SCHEMA);

  const missingData = clone(done);
  delete missingData[1].data.acceptance;
  expectCode(check(missingData), RULE_CODES.SCHEMA);

  const badTier = clone(done);
  badTier[1].data.riskTier = "critical";
  expectCode(check(badTier), RULE_CODES.SCHEMA);

  const badTime = clone(done);
  badTime[2].at = "yesterday";
  expectCode(check(badTime), RULE_CODES.SCHEMA);

  const runLevelWithNode = clone(done);
  runLevelWithNode[0].node = "advisor";
  expectCode(check(runLevelWithNode), RULE_CODES.SCHEMA);

  // Field requirements live only in the schema file: the validator carries no per-type field list.
  const source = await readFile(new URL("../scripts/advisor-trace.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /required\s*[:=]\s*\[/);
  const schemaText = await readFile(SCHEMA_PATH, "utf8");
  for (const type of eventTypes(schema)) {
    assert.match(schemaText, new RegExp(`"#/\\$defs/${type.replace(/\./g, "\\.")}"`), `schema lacks a data definition for ${type}`);
  }
});

test("the protocol doc names every event type and the trace location, and the docs index links it", async () => {
  const schema = await loadSchema();
  const doc = await readFile(new URL("../docs/advisor-protocol.md", import.meta.url), "utf8");
  for (const type of eventTypes(schema)) assert.match(doc, new RegExp(`\`${type.replace(/\./g, "\\.")}\``), `doc lacks ${type}`);
  assert.match(doc, /<root>\/traces\/<runId>\.jsonl/);
  assert.match(doc, /config\/advisor-core\/canonical-events\.schema\.json/);
  assert.match(doc, /scripts\/advisor-trace\.mjs validate/);

  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /\[`advisor-protocol\.md`\]\(docs\/advisor-protocol\.md\)/);

  const skill = await readFile(new URL("../skills/advisor/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /`<root>\/traces\/<runId>\.jsonl`/);
});
