import canonicalEventSchema from "./canonical-events.schema.json";
import type { TraceNode, TraceProjection } from "./contracts.js";

export const TRACE_VERSION = 1;

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

type AdvisorHost = "pi" | "claude-code" | "codex";
type SettledStatus = "done" | "blocked" | "failed" | "stalled" | "cancelled";

interface EventEnvelope<Type extends string, Data> {
  v: 1;
  seq: number;
  at: string;
  run: string;
  node: string | null;
  parent: string | null;
  host: AdvisorHost;
  type: Type;
  data: Data;
}

type RunCreatedEvent = EventEnvelope<
  "run.created",
  {
    workstream: string;
    goal?: string;
    graph?: string;
    stateRoot?: string;
    root: { node: string; session: string };
  }
> & { node: null; parent: null };

type NodeLaunchedEvent = EventEnvelope<
  "node.launched",
  {
    role: string;
    label: string;
    harness: AdvisorHost;
    model: string;
    thinking: string;
    cwd: string;
    riskTier: "low" | "standard" | "high";
    acceptance: string[];
    resultPath?: string;
    keepAlive?: boolean;
    launchRef?: Record<string, string>;
  }
> & { node: string; parent: string };

type NodeProgressEvent = EventEnvelope<"node.progress", { note: string }> & {
  node: string;
  parent: string;
};

type NodeBlockedEvent = EventEnvelope<
  "node.blocked",
  {
    request: {
      kind:
        | "question"
        | "decision"
        | "permission"
        | "credential"
        | "external-action";
      text: string;
      options?: string[];
    };
  }
> & { node: string; parent: string };

type NodeResultWrittenEvent = EventEnvelope<
  "node.result.written",
  { path: string; sha256?: string }
> & { node: string; parent: string };

type NodeDeviationEvent = EventEnvelope<
  "node.deviation",
  { count: number; items: string[] }
> & { node: string; parent: string };

type NodeResultValidatedEvent = EventEnvelope<
  "node.result.validated",
  { path: string; valid: boolean; problems: string[]; status?: string }
> & { node: string; parent: string };

type NodeSettledEvent = EventEnvelope<
  "node.settled",
  {
    status: SettledStatus;
    reason: string;
    resultStatus?: string;
    surfaceClosed?: boolean;
  }
> & { node: string; parent: string };

type ParentAwakenedEvent = EventEnvelope<
  "parent.awakened",
  {
    child: string;
    childStatus: SettledStatus;
    wakeGeneration: number;
    resultPath?: string;
  }
> & { node: string };

type GraphPlannedEvent = EventEnvelope<
  "graph.planned",
  {
    graph: string;
    waves: string[][];
    maxParallel: number;
    maxRepairLoops: number;
  }
> & { node: null; parent: null };

type WaveEvent<Type extends "wave.started" | "wave.completed"> = EventEnvelope<
  Type,
  { wave: number; nodes: string[] }
> & { node: null; parent: null };

type NodeReplySentEvent = EventEnvelope<
  "node.reply.sent",
  { text: string; source: "advisor" | "user"; replyTo?: number }
> & { node: string; parent: string };

type NodeCancelRequestedEvent = EventEnvelope<
  "node.cancel.requested",
  { reason: string }
> & { node: string; parent: string };

type NodeResumedEvent = EventEnvelope<
  "node.resumed",
  { reason: "reply" | "restart" | "follow-up" }
> & { node: string; parent: string };

export type CanonicalEvent =
  | GraphPlannedEvent
  | WaveEvent<"wave.started">
  | WaveEvent<"wave.completed">
  | NodeReplySentEvent
  | NodeCancelRequestedEvent
  | NodeResumedEvent
  | RunCreatedEvent
  | NodeLaunchedEvent
  | NodeProgressEvent
  | NodeBlockedEvent
  | NodeResultWrittenEvent
  | NodeDeviationEvent
  | NodeResultValidatedEvent
  | NodeSettledEvent
  | ParentAwakenedEvent;

interface JsonSchema {
  $ref?: string;
  const?: unknown;
  enum?: unknown[];
  type?: string | string[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  [key: string]: unknown;
}

export const CANONICAL_EVENT_SCHEMA = canonicalEventSchema as JsonSchema;

export interface TraceValidationProblem {
  code: string;
  seq: number;
  message: string;
}

export interface TraceValidation {
  ok: boolean;
  problems: TraceValidationProblem[];
}

export function parseTrace(text: string): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line) as CanonicalEvent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`line ${index + 1}: invalid JSON (${message})`);
    }
  });
  return events;
}

const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  const actual = jsonType(value);
  if (expected === "number") {
    return actual === "number" || actual === "integer";
  }
  return actual === expected;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref: ${ref}`);
  let node: unknown = root;
  for (const rawKey of ref.slice(2).split("/")) {
    const key = rawKey.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (typeof node !== "object" || node === null || !(key in node)) {
      throw new Error(`unresolved $ref: ${ref}`);
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node as JsonSchema;
}

export function checkSchema(
  schema: JsonSchema,
  value: unknown,
  path = "$",
  root = schema,
  problems: string[] = [],
): string[] {
  if (schema.$ref !== undefined) {
    return checkSchema(
      resolveRef(root, schema.$ref),
      value,
      path,
      root,
      problems,
    );
  }
  if ("const" in schema && !deepEqual(value, schema.const)) {
    problems.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  }
  if (
    schema.enum !== undefined &&
    !schema.enum.some((candidate) => deepEqual(candidate, value))
  ) {
    problems.push(
      `${path}: expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`,
    );
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      problems.push(
        `${path}: expected type ${types.join("|")}, got ${jsonType(value)}`,
      );
      return problems;
    }
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter(
      (branch) => checkSchema(branch, value, path, root, []).length === 0,
    );
    if (matches.length !== 1) {
      problems.push(
        `${path}: expected exactly one matching oneOf branch, got ${matches.length}`,
      );
    }
  }
  for (const branch of schema.allOf ?? []) {
    checkSchema(branch, value, path, root, problems);
  }
  if (schema.if !== undefined) {
    const passes = checkSchema(schema.if, value, path, root, []).length === 0;
    const branch = passes ? schema.then : schema.else;
    if (branch !== undefined) {
      checkSchema(branch, value, path, root, problems);
    }
  }
  if (jsonType(value) === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        problems.push(`${path}: missing required property "${key}"`);
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (key in record) {
        checkSchema(child, record[key], `${path}.${key}`, root, problems);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          problems.push(`${path}: unexpected property "${key}"`);
        }
      }
    } else if (
      typeof schema.additionalProperties === "object" &&
      schema.additionalProperties !== null
    ) {
      for (const [key, child] of Object.entries(record)) {
        if (!(key in properties)) {
          checkSchema(
            schema.additionalProperties,
            child,
            `${path}.${key}`,
            root,
            problems,
          );
        }
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${path}: expected at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      problems.push(`${path}: expected at most ${schema.maxItems} item(s)`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) =>
        checkSchema(schema.items!, item, `${path}[${index}]`, root, problems),
      );
    }
  }
  if (
    typeof value === "number" &&
    schema.minimum !== undefined &&
    value < schema.minimum
  ) {
    problems.push(`${path}: expected >= ${schema.minimum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(
        `${path}: expected at least ${schema.minLength} character(s)`,
      );
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push(`${path}: expected at most ${schema.maxLength} character(s)`);
    }
    if (
      schema.pattern !== undefined &&
      !new RegExp(schema.pattern).test(value)
    ) {
      problems.push(`${path}: does not match ${schema.pattern}`);
    }
    if (
      schema.format === "date-time" &&
      (!ISO_DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))
    ) {
      problems.push(`${path}: expected an ISO-8601 date-time`);
    }
  }
  return problems;
}

const RESULT_GATED_STATUSES = new Set<SettledStatus>(["done", "blocked"]);

interface NodeValidationState {
  parent: string;
  blockedSeq: number | undefined;
  written: string | undefined;
  validated: { path: string; valid: boolean } | undefined;
  deviationSeq: number | undefined;
  settled: { status: SettledStatus; seq: number } | undefined;
  settlements: { status: SettledStatus; seq: number }[];
  wakeCount: number;
  pendingReply: number | undefined;
  cancelSeq: number | undefined;
}

// Package-local port of the canonical reference. Keep event order, diagnostics,
// and retained projection history aligned; conformance tests compare both.
export function validateTrace(
  events: readonly CanonicalEvent[],
  schema: JsonSchema = CANONICAL_EVENT_SCHEMA,
): TraceValidation {
  const problems: TraceValidationProblem[] = [];
  const report = (code: string, seq: number, message: string) =>
    problems.push({ code, seq, message });

  events.forEach((event, index) => {
    for (const message of checkSchema(schema, event)) {
      report(
        RULE_CODES.SCHEMA,
        typeof event?.seq === "number" ? event.seq : index + 1,
        message,
      );
    }
  });
  if (problems.length) return { ok: false, problems };

  if (events.length === 0) {
    report(
      RULE_CODES.FIRST,
      0,
      "trace is empty; the first event must be run.created",
    );
    return { ok: false, problems };
  }

  const runId = events[0].run;
  let previousTime = -Infinity;
  events.forEach((event, index) => {
    if (event.seq !== index + 1)
      report(
        RULE_CODES.SEQ,
        event.seq,
        `expected seq ${index + 1}; seq must be contiguous from 1`,
      );
    if (event.run !== runId)
      report(
        RULE_CODES.RUN,
        event.seq,
        `run "${event.run}" differs from the trace run "${runId}"`,
      );
    const time = Date.parse(event.at);
    if (time < previousTime)
      report(
        RULE_CODES.TIME,
        event.seq,
        "timestamp is earlier than the previous event",
      );
    previousTime = Math.max(previousTime, time);
  });

  if (events[0].type !== "run.created") {
    report(
      RULE_CODES.FIRST,
      events[0].seq,
      "the first event must be run.created",
    );
    return { ok: false, problems };
  }
  const root = events[0].data.root.node;
  const nodes = new Map<string, NodeValidationState>();
  const wakeGenerations = new Map<string, number>();
  let graphPlan: GraphPlannedEvent | undefined;
  let launchedNodes = 0;
  const startedWaves = new Map<number, string[]>();
  const completedWaves = new Set<number>();

  for (const event of events.slice(1)) {
    const { seq, type, node: nodeId } = event;
    if (type === "run.created") {
      report(
        RULE_CODES.FIRST,
        seq,
        "run.created may appear only once, as the first event",
      );
      continue;
    }

    if (type === "graph.planned") {
      if (graphPlan)
        report(
          RULE_CODES.GRAPH,
          seq,
          "graph.planned may appear at most once per run",
        );
      if (launchedNodes > 0)
        report(
          RULE_CODES.GRAPH,
          seq,
          "graph.planned must appear before node.launched",
        );
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
        report(
          RULE_CODES.WAVE,
          seq,
          `${type} wave ${wave} nodes differ from graph.planned`,
        );
      }
      if (type === "wave.started") {
        const expected = startedWaves.size + 1;
        if (wave !== expected)
          report(
            RULE_CODES.WAVE,
            seq,
            `expected contiguous wave ${expected}, got ${wave}`,
          );
        if (startedWaves.has(wave))
          report(RULE_CODES.WAVE, seq, `wave ${wave} already started`);
        if (wave > 1 && !completedWaves.has(wave - 1)) {
          report(
            RULE_CODES.WAVE,
            seq,
            `wave ${wave} started before wave ${wave - 1} completed`,
          );
        }
        startedWaves.set(wave, event.data.nodes);
      } else {
        if (!startedWaves.has(wave))
          report(
            RULE_CODES.WAVE,
            seq,
            `wave ${wave} completed before it started`,
          );
        if (completedWaves.has(wave))
          report(RULE_CODES.WAVE, seq, `wave ${wave} already completed`);
        for (const listedNode of event.data.nodes) {
          if (!nodes.get(listedNode)?.settled) {
            report(
              RULE_CODES.WAVE,
              seq,
              `wave ${wave} node "${listedNode}" has not settled`,
            );
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
        report(
          RULE_CODES.PARENT_LINK,
          seq,
          `parent "${event.parent}" is neither the root node nor a launched node`,
        );
      } else if (event.parent !== root && nodes.get(event.parent)?.settled) {
        report(
          RULE_CODES.PARENT_LINK,
          seq,
          `parent "${event.parent}" already settled`,
        );
      }
      nodes.set(nodeId, {
        parent: event.parent,
        blockedSeq: undefined,
        written: undefined,
        validated: undefined,
        deviationSeq: undefined,
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
        report(
          RULE_CODES.PARENT_LINK,
          seq,
          `awakened node "${nodeId}" is neither the root node nor a launched node`,
        );
      }
      if (!child) {
        report(
          RULE_CODES.WAKE,
          seq,
          `child "${event.data.child}" was never launched`,
        );
        continue;
      }
      const settlement = child.settlements[child.wakeCount];
      if (!settlement)
        report(
          RULE_CODES.WAKE,
          seq,
          `child "${event.data.child}" has not settled since its previous wake`,
        );
      if (child.parent !== nodeId)
        report(
          RULE_CODES.WAKE,
          seq,
          `child "${event.data.child}" belongs to parent "${child.parent}", not "${nodeId}"`,
        );
      if (settlement && event.data.childStatus !== settlement.status) {
        report(
          RULE_CODES.WAKE,
          seq,
          `childStatus "${event.data.childStatus}" differs from the settlement status "${settlement.status}"`,
        );
      }
      const expectedGeneration = (wakeGenerations.get(nodeId) ?? 0) + 1;
      if (event.data.wakeGeneration !== expectedGeneration) {
        report(
          RULE_CODES.WAKE,
          seq,
          `expected wakeGeneration ${expectedGeneration} for parent "${nodeId}"`,
        );
      }
      wakeGenerations.set(
        nodeId,
        Math.max(wakeGenerations.get(nodeId) ?? 0, event.data.wakeGeneration),
      );
      if (settlement) child.wakeCount += 1;
      continue;
    }

    // Remaining types are per-node lifecycle events on an already launched node.
    const state = nodes.get(nodeId);
    if (!state) {
      report(
        RULE_CODES.ORDER,
        seq,
        `${type} for node "${nodeId}" before node.launched`,
      );
      continue;
    }
    if (event.parent !== state.parent) {
      report(
        RULE_CODES.PARENT_LINK,
        seq,
        `parent "${event.parent}" differs from the launch parent "${state.parent}"`,
      );
    }

    if (
      state.pendingReply &&
      !(type === "node.resumed" && event.data.reason === "reply")
    ) {
      report(
        RULE_CODES.REPLY,
        seq,
        `node.reply.sent at seq ${state.pendingReply} must be followed by node.resumed with reason "reply"`,
      );
      state.pendingReply = undefined;
    }

    if (type === "node.reply.sent") {
      if (state.settled?.status !== "blocked") {
        report(
          RULE_CODES.REPLY,
          seq,
          `node.reply.sent requires the node's last settlement to be blocked`,
        );
      }
      if (
        event.data.replyTo !== undefined &&
        event.data.replyTo !== state.blockedSeq
      ) {
        report(
          RULE_CODES.REPLY,
          seq,
          `replyTo ${event.data.replyTo} does not identify the last node.blocked event`,
        );
      }
      state.pendingReply = seq;
      continue;
    }

    if (type === "node.resumed") {
      const resumesSettlement =
        state.settled?.status === "blocked" ||
        state.settled?.status === "stalled";
      const restartsUnsettled =
        event.data.reason === "restart" &&
        state.settlements.length === 0 &&
        !state.settled;
      const followsTerminal =
        event.data.reason === "follow-up" &&
        ["done", "failed"].includes(state.settled?.status ?? "");
      if (!resumesSettlement && !restartsUnsettled && !followsTerminal) {
        report(
          RULE_CODES.RESUME,
          seq,
          "node.resumed requires blocked/stalled settlement, terminal follow-up, or restart before any settlement",
        );
        continue;
      }
      if (event.data.reason === "reply" && !state.pendingReply) {
        report(
          RULE_CODES.RESUME,
          seq,
          "node.resumed with reason reply requires the preceding node.reply.sent",
        );
        continue;
      }
      state.pendingReply = undefined;
      state.blockedSeq = undefined;
      state.written = undefined;
      state.validated = undefined;
      state.deviationSeq = undefined;
      state.settled = undefined;
      state.cancelSeq = undefined;
      continue;
    }

    if (type === "node.cancel.requested") {
      if (state.settled && state.settled.status !== "blocked") {
        report(
          RULE_CODES.ORDER,
          seq,
          `node.cancel.requested for node "${nodeId}" after it settled ${state.settled.status}`,
        );
        continue;
      }
      state.cancelSeq = seq;
      continue;
    }

    const cancelsBlocked =
      type === "node.settled" &&
      event.data.status === "cancelled" &&
      state.settled?.status === "blocked" &&
      (state.cancelSeq ?? -Infinity) > state.settled.seq;
    if (state.settled && !cancelsBlocked) {
      report(
        RULE_CODES.ORDER,
        seq,
        `${type} for node "${nodeId}" after it settled`,
      );
      continue;
    }
    switch (type) {
      case "node.blocked":
        state.blockedSeq = seq;
        break;
      case "node.result.written":
        state.written = event.data.path;
        break;
      case "node.deviation":
        if (!state.written || state.validated || state.deviationSeq) {
          report(RULE_CODES.RESULT_ORDER, seq, "node.deviation requires result.written, precedes result.validated, and appears at most once per attempt");
        }
        state.deviationSeq = seq;
        break;
      case "node.result.validated":
        if (state.written !== event.data.path) {
          report(
            RULE_CODES.RESULT_ORDER,
            seq,
            `validated path "${event.data.path}" was not written first`,
          );
        }
        if (event.data.valid && !event.data.status) {
          report(
            RULE_CODES.RESULT_ORDER,
            seq,
            "a valid result must carry its Status line",
          );
        }
        if (!event.data.valid && event.data.problems.length === 0) {
          report(
            RULE_CODES.RESULT_ORDER,
            seq,
            "an invalid result must list at least one problem",
          );
        }
        state.validated = { path: event.data.path, valid: event.data.valid };
        break;
      case "node.settled": {
        const { status } = event.data;
        if (RESULT_GATED_STATUSES.has(status)) {
          const gate = state.validated;
          if (!gate || !gate.valid || gate.path !== state.written) {
            report(
              RULE_CODES.SETTLE,
              seq,
              `settlement "${status}" requires a prior valid node.result.validated`,
            );
          }
        }
        if (status === "blocked" && !state.blockedSeq) {
          report(
            RULE_CODES.BLOCKED,
            seq,
            "blocked settlement requires a prior node.blocked carrying the request",
          );
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
      report(
        RULE_CODES.REPLY,
        state.pendingReply,
        `node.reply.sent for node "${nodeId}" is not followed by node.resumed`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

export function projectTrace(
  events: readonly CanonicalEvent[],
): TraceProjection {
  // The reducer consumes structurally validated traces.
  const first = events[0] as RunCreatedEvent | undefined;
  const run: TraceProjection["run"] = first
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
  const nodes = new Map<string, TraceNode>();
  const wakes: TraceProjection["wakes"] = [];

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
        let wave = run.waves.find(
          (candidate) => candidate.wave === event.data.wave,
        );
        if (!wave) {
          wave = {
            wave: event.data.wave,
            nodes: [...event.data.nodes],
            startedAt: null,
            completedAt: null,
          };
          run.waves.push(wave);
        }
        wave.nodes = [...event.data.nodes];
        if (event.type === "wave.started") wave.startedAt = event.at;
        else wave.completedAt = event.at;
      }
      continue;
    }
    if (event.type === "parent.awakened") {
      wakes.push({
        parent: event.node,
        child: event.data.child,
        childStatus: event.data.childStatus,
        generation: event.data.wakeGeneration,
        at: event.at,
      });
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
        deviations: [],
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
        node.replies.push({
          at: event.at,
          text: event.data.text,
          source: event.data.source,
        });
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
      case "node.deviation":
        node.deviations.push({ at: event.at, count: event.data.count, items: [...event.data.items] });
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

export function validationProblemsFromEvents(
  events: readonly CanonicalEvent[],
): Record<string, string[]> {
  const validationProblems: Record<string, string[]> = {};
  for (const event of events) {
    if (event.type === "node.result.validated") {
      validationProblems[event.node] = [...event.data.problems];
    }
  }
  return validationProblems;
}
