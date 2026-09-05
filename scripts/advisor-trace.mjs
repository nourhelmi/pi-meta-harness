#!/usr/bin/env node
/**
 * @file advisor-trace.mjs — canonical advisor event trace: parse, validate, project.
 *
 * The trace is the host-neutral truth every surface may read. Field shapes come
 * from config/advisor-core/canonical-events.schema.json (the single source for
 * envelope and data requirements); this module adds the ordering rules a JSON
 * Schema cannot express and a reference projection surfaces can render.
 * See docs/advisor-protocol.md. No host runtime is imported here.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, "..", "config", "advisor-core", "canonical-events.schema.json");
export const FIXTURES_DIR = join(HERE, "..", "config", "advisor-core", "fixtures");
export const TRACE_VERSION = 1;

/** Problem codes produced by the structural (ordering) rules. */
export const RULE_CODES = Object.freeze({
  SCHEMA: "E_SCHEMA",
  SEQ: "E_SEQ",
  RUN: "E_RUN",
  TIME: "E_TIME",
  FIRST: "E_FIRST",
  ORDER: "E_ORDER",
  PARENT_LINK: "E_PARENT_LINK",
  RESULT_ORDER: "E_RESULT_ORDER",
  SETTLE: "E_SETTLE",
  BLOCKED: "E_BLOCKED",
  WAKE: "E_WAKE",
  GRAPH: "E_GRAPH",
  WAVE: "E_WAVE",
  REPLY: "E_REPLY",
  RESUME: "E_RESUME",
});

let schemaCache;

export async function loadSchema(path = SCHEMA_PATH) {
  if (path === SCHEMA_PATH && schemaCache) return schemaCache;
  const text = await readFile(path, "utf8");
  let schema;
  try {
    schema = JSON.parse(text);
  } catch (error) {
    throw new Error(`schema ${path} is not valid JSON (${error.message})`);
  }
  if (path === SCHEMA_PATH) schemaCache = schema;
  return schema;
}

export const eventTypes = (schema) => schema.properties.type.enum;
export const enumeration = (schema, name) => schema.$defs[name].enum;

/** Parse JSONL text into events; throws with the offending line number on bad JSON. */
export function parseTrace(text) {
  const events = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`line ${index + 1}: invalid JSON (${error.message})`);
    }
  });
  return events;
}

// --- minimal JSON Schema (2020-12 subset) checker ---------------------------

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(expected, value) {
  const actual = jsonType(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce((node, key) => {
      if (node === undefined) throw new Error(`unresolved $ref: ${ref}`);
      return node[key.replace(/~1/g, "/").replace(/~0/g, "~")];
    }, root);
}

/**
 * Check `value` against `schema`, appending human-readable problems.
 * Supports the keywords this repository's schema uses: $ref, const, enum, type,
 * oneOf, allOf, if/then/else, required, properties, additionalProperties,
 * items, minItems, minimum, minLength, pattern, and format: date-time.
 */
export function checkSchema(schema, value, path = "$", root = schema, problems = []) {
  if (schema.$ref) return checkSchema(resolveRef(root, schema.$ref), value, path, root, problems);
  if ("const" in schema && !deepEqual(value, schema.const)) {
    problems.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    problems.push(`${path}: expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((type) => matchesType(type, value))) {
      problems.push(`${path}: expected type ${types.join("|")}, got ${jsonType(value)}`);
      return problems;
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => checkSchema(branch, value, path, root, []).length === 0);
    if (matches.length !== 1) problems.push(`${path}: expected exactly one matching oneOf branch, got ${matches.length}`);
  }
  for (const branch of schema.allOf ?? []) checkSchema(branch, value, path, root, problems);
  if (schema.if) {
    const passes = checkSchema(schema.if, value, path, root, []).length === 0;
    const branch = passes ? schema.then : schema.else;
    if (branch) checkSchema(branch, value, path, root, problems);
  }
  if (jsonType(value) === "object") {
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${path}: missing required property "${key}"`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) checkSchema(child, value[key], `${path}.${key}`, root, problems);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) problems.push(`${path}: unexpected property "${key}"`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (!(key in properties)) checkSchema(schema.additionalProperties, child, `${path}.${key}`, root, problems);
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${path}: expected at least ${schema.minItems} item(s)`);
    }
    if (schema.items) value.forEach((item, index) => checkSchema(schema.items, item, `${path}[${index}]`, root, problems));
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    problems.push(`${path}: expected >= ${schema.minimum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`${path}: expected at least ${schema.minLength} character(s)`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format === "date-time" && (!ISO_DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) {
      problems.push(`${path}: expected an ISO-8601 date-time`);
    }
  }
  return problems;
}

// --- structural rules -------------------------------------------------------

const RESULT_GATED_STATUSES = new Set(["done", "blocked"]);

/**
 * Validate a parsed trace: schema shape per event, then the run-wide ordering
 * rules. Returns { ok, problems: [{ code, seq, message }] }. Ordering rules run
 * only when every event is schema-valid, because they assume the envelope shape.
 */
export function validateTrace(events, schema) {
  const problems = [];
  const report = (code, seq, message) => problems.push({ code, seq, message });

  events.forEach((event, index) => {
    for (const message of checkSchema(schema, event)) {
      report(RULE_CODES.SCHEMA, typeof event?.seq === "number" ? event.seq : index + 1, message);
    }
  });
  if (problems.length) return { ok: false, problems };

  if (events.length === 0) {
    report(RULE_CODES.FIRST, 0, "trace is empty; the first event must be run.created");
    return { ok: false, problems };
  }

  const runId = events[0].run;
  let previousTime = -Infinity;
  events.forEach((event, index) => {
    if (event.seq !== index + 1) report(RULE_CODES.SEQ, event.seq, `expected seq ${index + 1}; seq must be contiguous from 1`);
    if (event.run !== runId) report(RULE_CODES.RUN, event.seq, `run "${event.run}" differs from the trace run "${runId}"`);
    const time = Date.parse(event.at);
    if (time < previousTime) report(RULE_CODES.TIME, event.seq, "timestamp is earlier than the previous event");
    previousTime = Math.max(previousTime, time);
  });

  if (events[0].type !== "run.created") {
    report(RULE_CODES.FIRST, events[0].seq, "the first event must be run.created");
    return { ok: false, problems };
  }
  const root = events[0].data.root.node;
  const nodes = new Map();
  const wakeGenerations = new Map();
  let graphPlan;
  let launchedNodes = 0;
  const startedWaves = new Map();
  const completedWaves = new Set();

  for (const event of events.slice(1)) {
    const { seq, type, node: nodeId } = event;
    if (type === "run.created") {
      report(RULE_CODES.FIRST, seq, "run.created may appear only once, as the first event");
      continue;
    }

    if (type === "graph.planned") {
      if (graphPlan) report(RULE_CODES.GRAPH, seq, "graph.planned may appear at most once per run");
      if (launchedNodes > 0) report(RULE_CODES.GRAPH, seq, "graph.planned must appear before node.launched");
      graphPlan = event;
      continue;
    }

    if (type === "wave.started" || type === "wave.completed") {
      const wave = event.data.wave;
      if (!graphPlan) {
        report(RULE_CODES.WAVE, seq, `${type} requires graph.planned`);
        continue;
      }
      const plannedNodes = graphPlan.data.waves[wave - 1];
      if (!plannedNodes || !deepEqual(event.data.nodes, plannedNodes)) {
        report(RULE_CODES.WAVE, seq, `${type} wave ${wave} nodes differ from graph.planned`);
      }
      if (type === "wave.started") {
        const expected = startedWaves.size + 1;
        if (wave !== expected) report(RULE_CODES.WAVE, seq, `expected contiguous wave ${expected}, got ${wave}`);
        if (startedWaves.has(wave)) report(RULE_CODES.WAVE, seq, `wave ${wave} already started`);
        if (wave > 1 && !completedWaves.has(wave - 1)) {
          report(RULE_CODES.WAVE, seq, `wave ${wave} started before wave ${wave - 1} completed`);
        }
        startedWaves.set(wave, event.data.nodes);
      } else {
        if (!startedWaves.has(wave)) report(RULE_CODES.WAVE, seq, `wave ${wave} completed before it started`);
        if (completedWaves.has(wave)) report(RULE_CODES.WAVE, seq, `wave ${wave} already completed`);
        for (const listedNode of event.data.nodes) {
          if (!nodes.get(listedNode)?.settled) {
            report(RULE_CODES.WAVE, seq, `wave ${wave} node "${listedNode}" has not settled`);
          }
        }
        completedWaves.add(wave);
      }
      continue;
    }

    if (type === "node.launched") {
      launchedNodes += 1;
      if (nodes.has(nodeId)) {
        report(RULE_CODES.ORDER, seq, `node "${nodeId}" was already launched`);
        continue;
      }
      const parentKnown = event.parent === root || nodes.has(event.parent);
      if (!parentKnown) {
        report(RULE_CODES.PARENT_LINK, seq, `parent "${event.parent}" is neither the root node nor a launched node`);
      } else if (event.parent !== root && nodes.get(event.parent).settled) {
        report(RULE_CODES.PARENT_LINK, seq, `parent "${event.parent}" already settled`);
      }
      nodes.set(nodeId, {
        parent: event.parent,
        blockedSeq: undefined,
        written: undefined,
        validated: undefined,
        settled: undefined,
        settlements: [],
        wakeCount: 0,
        pendingReply: undefined,
        cancelSeq: undefined,
      });
      continue;
    }

    if (type === "parent.awakened") {
      const child = nodes.get(event.data.child);
      if (nodeId !== root && !nodes.has(nodeId)) {
        report(RULE_CODES.PARENT_LINK, seq, `awakened node "${nodeId}" is neither the root node nor a launched node`);
      }
      if (!child) {
        report(RULE_CODES.WAKE, seq, `child "${event.data.child}" was never launched`);
        continue;
      }
      const settlement = child.settlements[child.wakeCount];
      if (!settlement) report(RULE_CODES.WAKE, seq, `child "${event.data.child}" has not settled since its previous wake`);
      if (child.parent !== nodeId) report(RULE_CODES.WAKE, seq, `child "${event.data.child}" belongs to parent "${child.parent}", not "${nodeId}"`);
      if (settlement && event.data.childStatus !== settlement.status) {
        report(RULE_CODES.WAKE, seq, `childStatus "${event.data.childStatus}" differs from the settlement status "${settlement.status}"`);
      }
      const expectedGeneration = (wakeGenerations.get(nodeId) ?? 0) + 1;
      if (event.data.wakeGeneration !== expectedGeneration) {
        report(RULE_CODES.WAKE, seq, `expected wakeGeneration ${expectedGeneration} for parent "${nodeId}"`);
      }
      wakeGenerations.set(nodeId, Math.max(wakeGenerations.get(nodeId) ?? 0, event.data.wakeGeneration));
      if (settlement) child.wakeCount += 1;
      continue;
    }

    // Remaining types are per-node lifecycle events on an already launched node.
    const state = nodes.get(nodeId);
    if (!state) {
      report(RULE_CODES.ORDER, seq, `${type} for node "${nodeId}" before node.launched`);
      continue;
    }
    if (event.parent !== state.parent) {
      report(RULE_CODES.PARENT_LINK, seq, `parent "${event.parent}" differs from the launch parent "${state.parent}"`);
    }

    if (state.pendingReply && !(type === "node.resumed" && event.data.reason === "reply")) {
      report(RULE_CODES.REPLY, seq, `node.reply.sent at seq ${state.pendingReply} must be followed by node.resumed with reason "reply"`);
      state.pendingReply = undefined;
    }

    if (type === "node.reply.sent") {
      if (state.settled?.status !== "blocked") {
        report(RULE_CODES.REPLY, seq, `node.reply.sent requires the node's last settlement to be blocked`);
      }
      if (event.data.replyTo !== undefined && event.data.replyTo !== state.blockedSeq) {
        report(RULE_CODES.REPLY, seq, `replyTo ${event.data.replyTo} does not identify the last node.blocked event`);
      }
      state.pendingReply = seq;
      continue;
    }

    if (type === "node.resumed") {
      const resumesSettlement = state.settled?.status === "blocked" || state.settled?.status === "stalled";
      const restartsUnsettled = event.data.reason === "restart" && state.settlements.length === 0 && !state.settled;
      if (!resumesSettlement && !restartsUnsettled) {
        report(RULE_CODES.RESUME, seq, "node.resumed requires a blocked or stalled settlement, or restart before any settlement");
        continue;
      }
      if (event.data.reason === "reply" && !state.pendingReply) {
        report(RULE_CODES.RESUME, seq, "node.resumed with reason reply requires the preceding node.reply.sent");
        continue;
      }
      state.pendingReply = undefined;
      state.blockedSeq = undefined;
      state.written = undefined;
      state.validated = undefined;
      state.settled = undefined;
      state.cancelSeq = undefined;
      continue;
    }

    if (type === "node.cancel.requested") {
      if (state.settled && state.settled.status !== "blocked") {
        report(RULE_CODES.ORDER, seq, `node.cancel.requested for node "${nodeId}" after it settled ${state.settled.status}`);
        continue;
      }
      state.cancelSeq = seq;
      continue;
    }

    const cancelsBlocked = type === "node.settled" && event.data.status === "cancelled" &&
      state.settled?.status === "blocked" && state.cancelSeq > state.settled.seq;
    if (state.settled && !cancelsBlocked) {
      report(RULE_CODES.ORDER, seq, `${type} for node "${nodeId}" after it settled`);
      continue;
    }
    switch (type) {
      case "node.blocked":
        state.blockedSeq = seq;
        break;
      case "node.result.written":
        state.written = event.data.path;
        break;
      case "node.result.validated":
        if (state.written !== event.data.path) {
          report(RULE_CODES.RESULT_ORDER, seq, `validated path "${event.data.path}" was not written first`);
        }
        if (event.data.valid && !event.data.status) {
          report(RULE_CODES.RESULT_ORDER, seq, "a valid result must carry its Status line");
        }
        if (!event.data.valid && event.data.problems.length === 0) {
          report(RULE_CODES.RESULT_ORDER, seq, "an invalid result must list at least one problem");
        }
        state.validated = { path: event.data.path, valid: event.data.valid };
        break;
      case "node.settled": {
        const { status } = event.data;
        if (RESULT_GATED_STATUSES.has(status)) {
          const gate = state.validated;
          if (!gate || !gate.valid || gate.path !== state.written) {
            report(RULE_CODES.SETTLE, seq, `settlement "${status}" requires a prior valid node.result.validated`);
          }
        }
        if (status === "blocked" && !state.blockedSeq) {
          report(RULE_CODES.BLOCKED, seq, "blocked settlement requires a prior node.blocked carrying the request");
        }
        state.settled = { status, seq };
        state.settlements.push(state.settled);
        break;
      }
      default:
        break;
    }
  }

  for (const [nodeId, state] of nodes) {
    if (state.pendingReply) {
      report(RULE_CODES.REPLY, state.pendingReply, `node.reply.sent for node "${nodeId}" is not followed by node.resumed`);
    }
  }

  return { ok: problems.length === 0, problems };
}

// --- projection -------------------------------------------------------------

/**
 * Reduce a (validated) trace to the state a surface renders: the run, each node
 * with its derived state, and the wakes delivered to parents.
 */
export function projectTrace(events) {
  const first = events[0];
  const run = first
    ? {
        id: first.run,
        workstream: first.data.workstream,
        goal: first.data.goal ?? null,
        graph: first.data.graph ?? null,
        stateRoot: first.data.stateRoot ?? null,
        root: first.data.root.node,
        session: first.data.root.session,
        host: first.host,
        createdAt: first.at,
        lastSeq: events.at(-1)?.seq ?? 0,
        lastAt: events.at(-1)?.at ?? null,
        waves: [],
      }
    : null;
  const nodes = new Map();
  const wakes = [];

  for (const event of events) {
    if (event.type === "run.created") continue;
    if (event.type === "graph.planned") {
      if (run) {
        run.graph = event.data.graph;
        run.waves = event.data.waves.map((waveNodes, index) => ({
          wave: index + 1,
          nodes: [...waveNodes],
          startedAt: null,
          completedAt: null,
        }));
      }
      continue;
    }
    if (event.type === "wave.started" || event.type === "wave.completed") {
      if (run) {
        let wave = run.waves.find((candidate) => candidate.wave === event.data.wave);
        if (!wave) {
          wave = { wave: event.data.wave, nodes: [...event.data.nodes], startedAt: null, completedAt: null };
          run.waves.push(wave);
        }
        wave.nodes = [...event.data.nodes];
        if (event.type === "wave.started") wave.startedAt = event.at;
        else wave.completedAt = event.at;
      }
      continue;
    }
    if (event.type === "parent.awakened") {
      wakes.push({ parent: event.node, child: event.data.child, childStatus: event.data.childStatus, generation: event.data.wakeGeneration, at: event.at });
      continue;
    }
    if (event.type === "node.launched") {
      nodes.set(event.node, {
        id: event.node,
        parent: event.parent,
        host: event.host,
        state: "running",
        launchedAt: event.at,
        settledAt: null,
        attempts: 0,
        replies: [],
        cancelRequested: false,
        progress: [],
        blockedRequest: null,
        resultPath: event.data.resultPath ?? null,
        resultValid: null,
        resultStatus: null,
        settledStatus: null,
        settledReason: null,
        surfaceClosed: null,
        launch: { ...event.data },
      });
      continue;
    }
    const node = nodes.get(event.node);
    if (!node) continue;
    switch (event.type) {
      case "node.progress":
        node.progress.push({ at: event.at, note: event.data.note });
        break;
      case "node.blocked":
        node.state = "blocked";
        node.blockedRequest = { ...event.data.request, at: event.at };
        break;
      case "node.reply.sent":
        node.replies.push({ at: event.at, text: event.data.text, source: event.data.source });
        break;
      case "node.cancel.requested":
        node.cancelRequested = true;
        break;
      case "node.resumed":
        node.state = "running";
        break;
      case "node.result.written":
        node.state = "result-written";
        node.resultPath = event.data.path;
        break;
      case "node.result.validated":
        node.state = event.data.valid ? "result-validated" : "result-invalid";
        node.resultPath = event.data.path;
        node.resultValid = event.data.valid;
        node.resultStatus = event.data.status ?? null;
        break;
      case "node.settled":
        node.state = "settled";
        node.attempts += 1;
        node.settledAt = event.at;
        node.settledStatus = event.data.status;
        node.settledReason = event.data.reason;
        node.resultStatus = event.data.resultStatus ?? node.resultStatus;
        node.surfaceClosed = event.data.surfaceClosed ?? null;
        break;
      default:
        break;
    }
  }
  return { run, nodes: [...nodes.values()], wakes };
}

// --- CLI --------------------------------------------------------------------

export async function validateTraceFile(path, schema) {
  const events = parseTrace(await readFile(path, "utf8"));
  return { events, ...validateTrace(events, schema ?? (await loadSchema())) };
}

async function main(argv) {
  const [command, path] = argv;
  if (!command || !path || !["validate", "project"].includes(command)) {
    process.stderr.write("usage: advisor-trace.mjs <validate|project> <trace.jsonl>\n");
    return 2;
  }
  const { events, ok, problems } = await validateTraceFile(path);
  if (command === "project") {
    process.stdout.write(`${JSON.stringify({ ok, problems, projection: projectTrace(events) }, null, 2)}\n`);
    return ok ? 0 : 1;
  }
  if (ok) {
    process.stdout.write(`ok: ${events.length} event(s) in ${path}\n`);
    return 0;
  }
  for (const problem of problems) process.stdout.write(`${problem.code} seq ${problem.seq}: ${problem.message}\n`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    },
  );
}
