import { createHash } from "node:crypto";

const NORMALIZED_SCHEMA_VERSION = 1;
const FIXTURE_SCHEMA_VERSION = 1;
const ACTIVE_GAP_LIMIT_MS = 5 * 60 * 1000;
const MAX_INPUT_ENTRIES = 50_000;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_EVENTS = 100_000;
const MAX_NORMALIZED_BYTES = 8 * 1024 * 1024;
const MAX_REPETITION_LAUNCHES = 500;
const MAX_REPETITION_PAIRS = 1_000;
const ALIAS_PATTERN = /^(?:ar|g|n|w|a|m|l|h)_[0-9a-f]{32}$/;
const EVENT_ID_PATTERN = /^e\d{4,}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RUBRIC_DIMENSIONS = [
  "outcomeCorrectness",
  "informationValue",
  "adaptationConvergence",
  "efficiencyParallelism",
  "safetyCommunication",
];
const CALIBRATION_BEHAVIORS = new Set([
  "false-fail",
  "builder-self-verification",
  "scoped-recheck",
]);
const CALIBRATION_DECISIONS = new Set([
  "pass-with-notes",
  "builder-reports-fail",
  "scoped-pass",
]);
const RISK_THRESHOLDS = new Set(["low", "medium", "high"]);
const ALLOWED_ROLES = new Set([
  "scout",
  "planner",
  "reducer",
  "builder",
  "foreman",
  "checker",
  "browser-verifier",
  "unknown",
]);
const ALLOWED_TOOLS = new Set([
  "advisor_graph_plan",
  "advisor_session_init",
  "ask_user_question",
  "bash",
  "bg_agent",
  "bg_list",
  "bg_run",
  "edit",
  "fffind",
  "ffgrep",
  "intercom",
  "lens_diagnostics",
  "lsp_diagnostics",
  "mcp",
  "mem_context",
  "mem_save",
  "mem_session_summary",
  "mem_update",
  "module_report",
  "read",
  "read_enclosing",
  "read_symbol",
  "todo",
  "write",
  "other",
]);
const ALLOWED_SIGNALS = new Set([
  "stop",
  "redirect",
  "builder_invalidation",
  "auth_data_boundary",
]);
const ALLOWED_EVENT_KINDS = new Set([
  "session_started",
  "user_message",
  "user_intervention",
  "assistant_decision",
  "graph_plan",
  "worker_launch",
  "worker_launch_result",
  "worker_status",
  "tool_call",
  "tool_error",
]);
const ALLOWED_STATUSES = new Set([
  "requested",
  "running",
  "successful",
  "failed",
  "blocked",
  "cancelled",
  "stopped",
  "unknown",
]);
const ALLOWED_WORKER_FAILURE_KINDS = new Set([
  "startup-blocked",
  "startup-failed",
  "quota",
  "authentication",
  "model-unavailable",
  "timeout",
  "artifact-invalid",
  "worker-missing",
  "tool-error",
]);
const ALLOWED_NORMALIZED_EVENT_KEYS = new Set([
  "id",
  "timestamp",
  "kind",
  "toolName",
  "signals",
  "graphAlias",
  "nodeCount",
  "waves",
  "action",
  "workerAlias",
  "attemptAlias",
  "role",
  "modelAlias",
  "labelAlias",
  "anchorAlias",
  "anchorWordCount",
  "status",
  "failureKind",
  "startedAt",
  "endedAt",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function timestampOf(entry) {
  const value = entry?.timestamp ?? entry?.message?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function validateSessionEntry(entry, lineNumber) {
  const prefix = `Invalid session entry at line ${lineNumber}`;
  if (!isObject(entry)) throw new Error(`${prefix}: entry must be an object`);
  if (typeof entry.type !== "string" || !entry.type) throw new Error(`${prefix}: type must be a non-empty string`);
  if (entry.type === "message") {
    if (!isObject(entry.message)) throw new Error(`${prefix}: message must be an object`);
    if (typeof entry.message.role !== "string" || !entry.message.role) {
      throw new Error(`${prefix}: message.role must be a non-empty string`);
    }
    if (entry.message.content !== undefined
      && typeof entry.message.content !== "string"
      && !Array.isArray(entry.message.content)) {
      throw new Error(`${prefix}: message.content must be a string or array`);
    }
    for (const item of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (!isObject(item)) throw new Error(`${prefix}: message content items must be objects`);
      if (item.type === "toolCall") {
        if (typeof item.name !== "string" || !item.name) throw new Error(`${prefix}: toolCall.name is required`);
        if (item.id !== undefined && typeof item.id !== "string") throw new Error(`${prefix}: toolCall.id must be a string`);
        if (item.arguments !== undefined && !isObject(item.arguments)) {
          throw new Error(`${prefix}: toolCall.arguments must be an object`);
        }
      }
    }
  }
  if (entry.type === "custom_message" && entry.details !== undefined && !isObject(entry.details)) {
    throw new Error(`${prefix}: custom_message.details must be an object`);
  }
}

export function parseJsonl(text) {
  if (Buffer.byteLength(String(text), "utf8") > MAX_INPUT_BYTES) {
    throw new Error(`Session JSONL exceeds the ${MAX_INPUT_BYTES} byte budget`);
  }
  const entries = [];
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    validateSessionEntry(value, index + 1);
    entries.push(value);
    if (entries.length > MAX_INPUT_ENTRIES) {
      throw new Error(`Session JSONL exceeds the ${MAX_INPUT_ENTRIES} entry budget`);
    }
  }
  if (!entries.length) throw new Error("Session JSONL contains no entries");
  return entries;
}

function createAliaser(serializedEntries) {
  const artifactDigest = sha256(serializedEntries);
  const prefixes = {
    artifact: "ar",
    graph: "g",
    node: "n",
    worker: "w",
    attempt: "a",
    model: "m",
    label: "l",
    anchor: "h",
  };
  const alias = (category, value) => {
    if (typeof value !== "string" || !value) return undefined;
    const prefix = prefixes[category];
    if (!prefix) throw new Error(`Unknown alias category: ${category}`);
    return `${prefix}_${sha256(`${artifactDigest}\0${category}\0${value}`).slice(0, 32)}`;

  };
  return { alias, artifactAlias: alias("artifact", artifactDigest) };
}

function safeRole(value) {
  return ALLOWED_ROLES.has(value) ? value : "unknown";
}

function safeToolName(value) {
  return ALLOWED_TOOLS.has(value) ? value : "other";
}

function workerFailureKind(message) {
  const text = messageText(message).toLowerCase();
  if (text.includes("blocked during startup") || text.includes("not ready for prompts")) return "startup-blocked";
  if (text.includes("usage limit") || text.includes("rate limit") || text.includes("quota")) return "quota";
  if (text.includes("oauth") || text.includes("authentication") || text.includes("login")) return "authentication";
  if (text.includes("unsupported model") || text.includes("model unavailable") || text.includes("model not found")) return "model-unavailable";
  if (text.includes("timed out") || text.includes("timeout")) return "timeout";
  if (text.includes("required result artifact")) return "artifact-invalid";
  if (text.includes("no live herdr agent") || text.includes("agent not found")) return "worker-missing";
  if (text.includes("failed to start") || text.includes("agent start failed")) return "startup-failed";
  return "tool-error";
}

function normalizedStatus(value) {
  const status = String(value ?? "unknown").toLowerCase();
  if (["completed", "complete", "succeeded", "success", "passed", "done"].includes(status)) return "successful";
  if (["failed", "failure", "error", "errored", "rejected", "stalled"].includes(status)) return "failed";
  if (["running", "started", "promoted", "pending", "requested"].includes(status)) return "running";
  if (["blocked", "cancelled", "canceled", "stopped"].includes(status)) return status === "canceled" ? "cancelled" : status;
  return "unknown";
}

function normalizedWords(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

function simhash(value) {
  const words = normalizedWords(value);
  if (!words.length) return undefined;
  const weights = Array.from({ length: 64 }, () => 0);
  for (const word of words) {
    const bytes = createHash("sha256").update(word).digest().subarray(0, 8);
    for (let bit = 0; bit < 64; bit += 1) {
      const set = (bytes[Math.floor(bit / 8)] & (1 << (bit % 8))) !== 0;
      weights[bit] += set ? 1 : -1;
    }
  }
  let result = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (weights[bit] >= 0) result |= 1n << BigInt(bit);
  }
  return result.toString(16).padStart(16, "0");
}

function hammingDistance(left, right) {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

function jaccard(left, right) {
  const a = left instanceof Set ? left : new Set(normalizedWords(left));
  const b = right instanceof Set ? right : new Set(normalizedWords(right));

  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((value) => b.has(value)).length;
  return intersection / new Set([...a, ...b]).size;
}

function textSignals(text) {
  const value = text.toLowerCase();
  const signals = [];
  if (/\b(stop|pause|abort|cancel)\b|do not continue|don't continue/.test(value)) signals.push("stop");
  if (/\b(redirect|pivot)\b|\binstead\b|change (?:the )?direction|focus on/.test(value)) signals.push("redirect");
  if (/builder (?:output |work )?(?:is |was )?(?:invalid|invalidated|discarded|obsolete)|invalidate(?:d)? (?:the )?builder/.test(value)) {
    signals.push("builder_invalidation");
  }
  if (/(?:auth|credential|production data|customer data|real data)/.test(value)
    && /(?:do not|don't|must not|without|synthetic|boundary)/.test(value)) {
    signals.push("auth_data_boundary");
  }
  return [...new Set(signals)];
}

function graphWaves(nodes, alias) {
  const pending = new Map();
  for (const [index, node] of (Array.isArray(nodes) ? nodes : []).entries()) {
    if (!isObject(node)) continue;
    const rawId = typeof node.id === "string" && node.id ? node.id : `missing-node-${index + 1}`;
    pending.set(rawId, {
      rawId,
      nodeAlias: alias("node", rawId),
      role: safeRole(node.role),
      dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn.filter((id) => typeof id === "string") : [],
    });
  }
  const completed = new Set();
  const waves = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((node) => node.dependsOn.every((id) => completed.has(id)));
    if (!ready.length) {
      waves.push({
        index: waves.length + 1,
        nodeAliases: [...pending.values()].map((node) => node.nodeAlias).sort(),
        roles: [],
        unresolved: true,
      });
      break;
    }
    const sorted = ready.sort((left, right) => left.nodeAlias.localeCompare(right.nodeAlias));
    waves.push({
      index: waves.length + 1,
      nodeAliases: sorted.map((node) => node.nodeAlias),
      roles: sorted.map((node) => node.role),
    });
    for (const node of ready) {
      completed.add(node.rawId);
      pending.delete(node.rawId);
    }
  }
  return waves;
}

function buildCallDescriptors(entries, alias) {
  const byItem = new Map();
  const byToolCallId = new Map();
  const workerLookup = new Map();
  const workerDescriptors = [];
  const seenWorkers = new Set();
  let callOrder = 0;

  const registerWorkerLookup = (raw, descriptor) => {
    if (typeof raw !== "string" || !raw) return;
    const values = workerLookup.get(raw) ?? [];
    values.push(descriptor);
    workerLookup.set(raw, values);
  };

  for (const [sourceIndex, entry] of entries.entries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const item of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (item.type !== "toolCall") continue;
      callOrder += 1;
      const args = isObject(item.arguments) ? item.arguments : {};
      let descriptor;
      if (item.name === "advisor_graph_plan") {
        const rawGraph = typeof args.graphId === "string" && args.graphId ? args.graphId : `missing-graph-${callOrder}`;
        descriptor = {
          kind: "graph_plan",
          toolName: "advisor_graph_plan",
          graphAlias: alias("graph", rawGraph),
          nodeCount: Array.isArray(args.nodes) ? args.nodes.length : 0,
          waves: graphWaves(args.nodes, alias),
        };
      } else if (item.name === "bg_agent") {
        const rawLabel = typeof args.label === "string" ? args.label : undefined;
        const rawAnchor = typeof args.anchor === "string" ? args.anchor : undefined;
        const rawWorker = typeof args.name === "string" && args.name
          ? args.name
          : rawLabel ?? `missing-worker-${callOrder}`;
        const attemptSeed = typeof item.id === "string" && item.id ? item.id : `missing-call-${callOrder}`;
        descriptor = {
          kind: "worker_launch",
          toolName: "bg_agent",
          sourceIndex,
          action: seenWorkers.has(rawWorker) ? "resume" : "launch",
          workerAlias: alias("worker", rawWorker),
          attemptAlias: alias("attempt", attemptSeed),
          role: safeRole(args.role),
          modelAlias: alias("model", args.model),
          labelAlias: alias("label", rawLabel),
          anchorAlias: alias("anchor", rawAnchor),
          anchorWordCount: Math.min(normalizedWords(rawAnchor).length, 10_000),
          rawWorker,
          rawLabel,
          rawAnchor,
        };
        seenWorkers.add(rawWorker);
        workerDescriptors.push(descriptor);
        registerWorkerLookup(rawWorker, descriptor);
        registerWorkerLookup(rawLabel, descriptor);
      } else {
        descriptor = { kind: "tool_call", toolName: safeToolName(item.name) };
      }
      byItem.set(item, descriptor);
      if (typeof item.id === "string") {
        if (byToolCallId.has(item.id)) throw new Error("Session contains a duplicate toolCall.id");
        byToolCallId.set(item.id, descriptor);
      }
    }
  }
  // Promoted bg_agent calls receive their generated agent name only in the
  // initial tool result. Register it before normalizing later settlement
  // notifications so those notifications retain the launch attempt identity.
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const linked = typeof entry.message.toolCallId === "string"
      ? byToolCallId.get(entry.message.toolCallId)
      : undefined;
    if (linked?.kind !== "worker_launch" || !isObject(entry.message.details)) continue;
    for (const raw of [
      entry.message.details.agentName,
      entry.message.details.label,
      entry.message.details.runId,
      entry.message.details.id,
    ]) registerWorkerLookup(raw, linked);
  }
  // A resumed call identifies the live worker by generated name and normally
  // omits role/model. Reconnect it to the latest earlier descriptor registered
  // under that name so semantic role and worker identity survive the resume.
  for (const descriptor of workerDescriptors) {
    const prior = (workerLookup.get(descriptor.rawWorker) ?? [])
      .filter((candidate) => candidate !== descriptor && candidate.sourceIndex < descriptor.sourceIndex)
      .sort((left, right) => left.sourceIndex - right.sourceIndex)
      .at(-1);
    if (!prior) continue;
    descriptor.action = "resume";
    descriptor.workerAlias = prior.workerAlias;
    if (descriptor.role === "unknown") descriptor.role = prior.role;
    descriptor.modelAlias ??= prior.modelAlias;
    descriptor.labelAlias ??= prior.labelAlias;
  }
  return { byItem, byToolCallId, workerLookup };
}

function settlementDescriptor(details, sourceIndex, workerLookup) {
  const candidates = [];
  for (const raw of [details.agentName, details.label, details.runId, details.id]) {
    if (typeof raw !== "string") continue;
    for (const descriptor of workerLookup.get(raw) ?? []) {
      if (!candidates.includes(descriptor)) candidates.push(descriptor);
    }
  }
  const preceding = candidates.filter((candidate) => candidate.sourceIndex <= sourceIndex);
  preceding.sort((left, right) => left.sourceIndex - right.sourceIndex);
  return preceding.at(-1) ?? candidates[0];
}

function duplicateFacts(privateLaunches) {
  const launches = privateLaunches.slice(0, MAX_REPETITION_LAUNCHES).map((launch) => ({
    ...launch,
    anchorSimilarity: simhash(launch.rawAnchor),
    labelWords: new Set(normalizedWords(launch.rawLabel)),
  }));
  const facts = {
    exactAnchors: [],
    nearAnchors: [],
    exactLabels: [],
    nearLabels: [],
    truncated: privateLaunches.length > MAX_REPETITION_LAUNCHES,
  };
  const append = (key, pair) => {
    if (facts[key].length < MAX_REPETITION_PAIRS) facts[key].push(pair);
    else facts.truncated = true;
  };
  for (let left = 0; left < launches.length; left += 1) {
    for (let right = left + 1; right < launches.length; right += 1) {
      const a = launches[left];
      const b = launches[right];
      const pair = [a.eventId, b.eventId];
      if (a.rawAnchor && a.rawAnchor === b.rawAnchor) append("exactAnchors", pair);
      else if (hammingDistance(a.anchorSimilarity, b.anchorSimilarity) <= 10) append("nearAnchors", pair);
      if (a.rawLabel && a.rawLabel === b.rawLabel) append("exactLabels", pair);
      else if (jaccard(a.labelWords, b.labelWords) >= 0.75) append("nearLabels", pair);
    }
  }
  return facts;
}

export function normalizeSession(entries) {
  if (!Array.isArray(entries)) throw new Error("normalizeSession expects parsed JSONL entries");
  if (!entries.length) throw new Error("Session contains no entries");
  if (entries.length > MAX_INPUT_ENTRIES) throw new Error(`Session exceeds the ${MAX_INPUT_ENTRIES} entry budget`);
  entries.forEach((entry, index) => validateSessionEntry(entry, index + 1));
  const serializedEntries = JSON.stringify(entries);
  if (Buffer.byteLength(serializedEntries, "utf8") > MAX_INPUT_BYTES) {
    throw new Error(`Session exceeds the ${MAX_INPUT_BYTES} byte budget`);
  }

  const { alias, artifactAlias } = createAliaser(serializedEntries);
  const descriptors = buildCallDescriptors(entries, alias);
  const events = [];
  const privateLaunches = [];
  let userMessageCount = 0;

  const add = (entry, event) => {
    if (events.length >= MAX_OUTPUT_EVENTS) throw new Error(`Normalized trace exceeds the ${MAX_OUTPUT_EVENTS} event budget`);
    const normalized = {
      id: `e${String(events.length + 1).padStart(4, "0")}`,
      timestamp: timestampOf(entry),
      ...event,
    };
    if (!normalized.timestamp) delete normalized.timestamp;
    events.push(normalized);
    return normalized;
  };

  for (const [sourceIndex, entry] of entries.entries()) {
    if (entry.type === "session") {
      add(entry, { kind: "session_started" });
      continue;
    }

    if (entry.type === "custom_message" && entry.customType === "detach_agent_settled") {
      const details = isObject(entry.details) ? entry.details : {};
      const linked = settlementDescriptor(details, sourceIndex, descriptors.workerLookup);
      let fallbackRaw = `unknown-settlement-${sourceIndex}`;
      if (typeof details.agentName === "string") fallbackRaw = details.agentName;
      else if (typeof details.label === "string") fallbackRaw = details.label;
      add(entry, {
        kind: "worker_status",
        toolName: "bg_agent",
        workerAlias: linked?.workerAlias ?? alias("worker", fallbackRaw),
        attemptAlias: linked?.attemptAlias ?? alias("attempt", `settlement-${sourceIndex}-${fallbackRaw}`),
        ...(linked?.role ? { role: linked.role } : {}),
        ...(linked?.modelAlias ? { modelAlias: linked.modelAlias } : {}),
        status: normalizedStatus(details.agentState ?? details.status),
        startedAt: timestampOf({ timestamp: details.startedAt }),
        endedAt: timestampOf({ timestamp: details.endedAt }),
      });
      continue;
    }

    if (entry.type !== "message") continue;
    const message = entry.message;
    const text = messageText(message);

    if (message.role === "user") {
      const signals = textSignals(text);
      const isInitialRequest = userMessageCount === 0;
      userMessageCount += 1;
      add(entry, {
        kind: signals.length && !isInitialRequest ? "user_intervention" : "user_message",
        ...(signals.length ? { signals } : {}),
      });
      continue;
    }

    if (message.role === "assistant") {
      const signals = textSignals(text);
      if (signals.length) add(entry, { kind: "assistant_decision", signals });
      for (const item of Array.isArray(message.content) ? message.content : []) {
        if (item.type !== "toolCall") continue;
        const descriptor = descriptors.byItem.get(item);
        if (descriptor.kind === "graph_plan") {
          add(entry, {
            kind: descriptor.kind,
            toolName: descriptor.toolName,
            graphAlias: descriptor.graphAlias,
            nodeCount: descriptor.nodeCount,
            waves: descriptor.waves,
          });
        } else if (descriptor.kind === "worker_launch") {
          const event = add(entry, {
            kind: descriptor.kind,
            toolName: descriptor.toolName,
            action: descriptor.action,
            workerAlias: descriptor.workerAlias,
            attemptAlias: descriptor.attemptAlias,
            role: descriptor.role,
            modelAlias: descriptor.modelAlias,
            labelAlias: descriptor.labelAlias,
            anchorAlias: descriptor.anchorAlias,
            anchorWordCount: descriptor.anchorWordCount,
            status: "requested",
          });
          privateLaunches.push({
            eventId: event.id,
            rawLabel: descriptor.rawLabel,
            rawAnchor: descriptor.rawAnchor,
          });
        } else {
          add(entry, { kind: "tool_call", toolName: descriptor.toolName });
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const linked = typeof message.toolCallId === "string"
        ? descriptors.byToolCallId.get(message.toolCallId)
        : undefined;
      if (linked?.kind === "worker_launch") {
        const status = message.isError
          ? "failed"
          : normalizedStatus(message.details?.agentState ?? message.details?.status ?? "running");
        add(entry, {
          kind: "worker_launch_result",
          toolName: "bg_agent",
          workerAlias: linked.workerAlias,
          attemptAlias: linked.attemptAlias,
          role: linked.role,
          modelAlias: linked.modelAlias,
          status,
          ...(status === "failed" ? { failureKind: workerFailureKind(message) } : {}),
        });
      } else if (message.isError) {
        add(entry, {
          kind: "tool_error",
          toolName: safeToolName(message.toolName ?? linked?.toolName),
          status: "failed",
        });
      }
    }
  }

  const normalized = {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    source: {
      kind: "pi-session-jsonl",
      artifactAlias,
      entryCount: entries.length,
      textPolicy: "categorical-only",
      aliasScope: "deterministic-per-artifact",
    },
    redaction: {
      rawMessageBodiesCopied: false,
      rawToolPayloadsCopied: false,
      arbitraryTextCopied: false,
      identityFieldsAliased: true,
      anchorTextStored: false,
    },
    relationships: { repetition: duplicateFacts(privateLaunches) },
    events,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_NORMALIZED_BYTES) {
    throw new Error(`Normalized trace exceeds the ${MAX_NORMALIZED_BYTES} byte budget`);
  }
  assertNormalizedTrace(normalized);
  return normalized;
}

function assertAlias(value, label, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || !ALIAS_PATTERN.test(value)) throw new Error(`Invalid normalized ${label}`);
}

function assertOnlyKeys(value, allowed, label) {
  if (!isObject(value)) throw new Error(`Normalized ${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Normalized ${label} contains unknown field: ${unknown[0]}`);
}

function assertTimestamp(value, label) {
  if (value === undefined) return;
  if (typeof value !== "string"
    || !ISO_TIMESTAMP_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))) {
    throw new Error(`Normalized ${label} is invalid`);
  }
}

function assertNormalizedTrace(normalized) {
  if (!isObject(normalized) || normalized.schemaVersion !== NORMALIZED_SCHEMA_VERSION || !Array.isArray(normalized.events)) {
    throw new Error(`Expected normalized trace schemaVersion ${NORMALIZED_SCHEMA_VERSION}`);
  }
  assertOnlyKeys(normalized, new Set(["schemaVersion", "source", "redaction", "relationships", "events"]), "trace");
  assertOnlyKeys(
    normalized.source,
    new Set(["kind", "artifactAlias", "entryCount", "textPolicy", "aliasScope"]),
    "source",
  );
  if (normalized.source.kind !== "pi-session-jsonl"
    || normalized.source.textPolicy !== "categorical-only"
    || normalized.source.aliasScope !== "deterministic-per-artifact"
    || !Number.isInteger(normalized.source.entryCount)
    || normalized.source.entryCount < 1
    || normalized.source.entryCount > MAX_INPUT_ENTRIES) {
    throw new Error("Normalized trace has an invalid categorical source contract");
  }
  assertAlias(normalized.source.artifactAlias, "artifactAlias");
  assertOnlyKeys(
    normalized.redaction,
    new Set(["rawMessageBodiesCopied", "rawToolPayloadsCopied", "arbitraryTextCopied", "identityFieldsAliased", "anchorTextStored"]),
    "redaction",
  );
  if (normalized.redaction.rawMessageBodiesCopied !== false
    || normalized.redaction.rawToolPayloadsCopied !== false
    || normalized.redaction.arbitraryTextCopied !== false
    || normalized.redaction.identityFieldsAliased !== true
    || normalized.redaction.anchorTextStored !== false) {
    throw new Error("Normalized trace has an invalid redaction contract");
  }
  if (normalized.events.length > MAX_OUTPUT_EVENTS) throw new Error("Normalized trace exceeds the event budget");
  const eventIds = new Set();
  for (const event of normalized.events) {
    if (!isObject(event) || !EVENT_ID_PATTERN.test(event.id) || !ALLOWED_EVENT_KINDS.has(event.kind)) {
      throw new Error("Normalized trace contains an invalid event");
    }
    assertOnlyKeys(event, ALLOWED_NORMALIZED_EVENT_KEYS, "event");
    if (eventIds.has(event.id)) throw new Error(`Normalized trace repeats event ID: ${event.id}`);
    eventIds.add(event.id);
    assertTimestamp(event.timestamp, "event timestamp");
    assertTimestamp(event.startedAt, "startedAt");
    assertTimestamp(event.endedAt, "endedAt");
    if (event.toolName !== undefined && !ALLOWED_TOOLS.has(event.toolName)) throw new Error("Normalized toolName is not categorical");
    if (event.role !== undefined && !ALLOWED_ROLES.has(event.role)) throw new Error("Normalized role is not categorical");
    if (event.status !== undefined && !ALLOWED_STATUSES.has(event.status)) throw new Error("Normalized status is not categorical");
    if (event.failureKind !== undefined && !ALLOWED_WORKER_FAILURE_KINDS.has(event.failureKind)) {
      throw new Error("Normalized worker failure kind is not categorical");
    }
    if (event.action !== undefined && !["launch", "resume"].includes(event.action)) throw new Error("Normalized action is not categorical");
    if (event.signals !== undefined
      && (!Array.isArray(event.signals)
        || new Set(event.signals).size !== event.signals.length
        || event.signals.some((signal) => !ALLOWED_SIGNALS.has(signal)))) {
      throw new Error("Normalized signals are not categorical");
    }
    if (event.nodeCount !== undefined && (!Number.isInteger(event.nodeCount) || event.nodeCount < 0)) {
      throw new Error("Normalized nodeCount is invalid");
    }
    if (event.anchorWordCount !== undefined
      && (!Number.isInteger(event.anchorWordCount) || event.anchorWordCount < 0 || event.anchorWordCount > 10_000)) {
      throw new Error("Normalized anchorWordCount is invalid");
    }
    for (const key of ["graphAlias", "workerAlias", "attemptAlias", "modelAlias", "labelAlias", "anchorAlias"]) {
      assertAlias(event[key], key, { optional: true });
    }
    if (event.waves !== undefined && !Array.isArray(event.waves)) throw new Error("Normalized graph waves are invalid");
    for (const wave of event.waves ?? []) {
      assertOnlyKeys(wave, new Set(["index", "nodeAliases", "roles", "unresolved"]), "graph wave");
      if (!Number.isInteger(wave.index)
        || wave.index < 1
        || !Array.isArray(wave.nodeAliases)
        || !Array.isArray(wave.roles)
        || (wave.unresolved !== undefined && typeof wave.unresolved !== "boolean")) {
        throw new Error("Normalized graph wave is invalid");
      }
      wave.nodeAliases.forEach((value) => assertAlias(value, "nodeAlias"));
      if (wave.roles.some((role) => !ALLOWED_ROLES.has(role))) throw new Error("Normalized graph wave role is invalid");
    }
  }
  assertOnlyKeys(normalized.relationships, new Set(["repetition"]), "relationships");
  const repetition = normalized.relationships.repetition;
  assertOnlyKeys(
    repetition,
    new Set(["exactAnchors", "nearAnchors", "exactLabels", "nearLabels", "truncated"]),
    "repetition relationships",
  );
  for (const key of ["exactAnchors", "nearAnchors", "exactLabels", "nearLabels"]) {
    const pairs = repetition[key];
    if (!Array.isArray(pairs) || pairs.length > MAX_REPETITION_PAIRS) throw new Error(`Normalized ${key} is invalid`);
    for (const pair of pairs) {
      if (!Array.isArray(pair)
        || pair.length !== 2
        || pair.some((id) => !eventIds.has(id))) {
        throw new Error(`Normalized ${key} contains an invalid event pair`);
      }
    }
  }
  if (typeof repetition.truncated !== "boolean") throw new Error("Normalized repetition truncation flag is invalid");
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_NORMALIZED_BYTES) {
    throw new Error("Normalized trace exceeds the byte budget");
  }
}

function resolvedAttemptStatus(updates) {
  let selected = "requested";
  let priority = 0;
  for (const update of updates) {
    const terminal = ["successful", "failed", "blocked", "cancelled", "stopped"].includes(update.status);
    let nextPriority = 0;
    if (update.kind === "worker_status" && terminal) nextPriority = 3;
    else if (terminal) nextPriority = 2;
    else if (update.status === "running") nextPriority = 1;
    if (nextPriority >= priority) {
      selected = update.status;
      priority = nextPriority;
    }
  }
  return selected;
}

export function analyzeTrace(normalized) {
  assertNormalizedTrace(normalized);
  const events = normalized.events;
  const times = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
  let activeElapsedMs = 0;
  for (let index = 1; index < times.length; index += 1) {
    activeElapsedMs += Math.min(times[index] - times[index - 1], ACTIVE_GAP_LIMIT_MS);
  }

  const launches = events.filter((event) => event.kind === "worker_launch");
  const updatesByAttempt = Object.groupBy(
    events.filter((event) => ["worker_launch_result", "worker_status"].includes(event.kind)),
    (event) => event.attemptAlias,
  );
  const attempts = launches.map((event) => ({
    eventId: event.id,
    workerAlias: event.workerAlias,
    attemptAlias: event.attemptAlias,
    role: event.role,
    action: event.action,
    status: resolvedAttemptStatus(updatesByAttempt[event.attemptAlias] ?? []),
  }));
  const successfulByRole = {};
  for (const attempt of attempts.filter((value) => value.status === "successful")) {
    successfulByRole[attempt.role] = (successfulByRole[attempt.role] ?? 0) + 1;
  }
  const failedWorkers = new Set(attempts.filter((attempt) => attempt.status === "failed").map((attempt) => attempt.workerAlias));
  const recoveredWorkers = new Set(
    attempts
      .filter((attempt) => attempt.action === "resume" && attempt.status === "successful" && failedWorkers.has(attempt.workerAlias))
      .map((attempt) => attempt.workerAlias),
  );

  const graphs = events.filter((event) => event.kind === "graph_plan");
  const allWaves = graphs.flatMap((graph) => graph.waves ?? []);
  const launchBatches = Object.values(Object.groupBy(launches.filter((event) => event.timestamp), (event) => event.timestamp))
    .filter((batch) => batch.length > 1)
    .map((batch) => ({ timestamp: batch[0].timestamp, width: batch.length, eventIds: batch.map((event) => event.id) }));
  const toolUsage = {};
  for (const event of events.filter((candidate) => ["tool_call", "graph_plan", "worker_launch"].includes(candidate.kind))) {
    toolUsage[event.toolName] = (toolUsage[event.toolName] ?? 0) + 1;
  }
  const repetition = normalized.relationships?.repetition ?? {};

  return {
    schemaVersion: 1,
    diagnosticOnly: true,
    limitations: [
      "Trace metrics describe observable events; they do not prove outcome quality or prescribe an orchestration workflow.",
      "Active elapsed time caps each inter-event gap at five minutes and is only a workload proxy.",
      "Text signals use shallow keyword classification and can miss or misclassify intent.",
      "Near-duplicate relationships are heuristic and require human review.",
    ],
    elapsed: {
      wallElapsedMs: times.length > 1 ? times.at(-1) - times[0] : 0,
      activeElapsedMs,
      interEventGapCapMs: ACTIVE_GAP_LIMIT_MS,
    },
    toolUsage,
    workers: {
      launches: attempts.length,
      successfulByRole,
      failedLaunches: attempts.filter((attempt) => attempt.status === "failed").length,
      resumedLaunches: attempts.filter((attempt) => attempt.action === "resume").length,
      recoveredWorkers: recoveredWorkers.size,
      recoveryRatio: failedWorkers.size ? recoveredWorkers.size / failedWorkers.size : null,
    },
    graphs: {
      count: graphs.length,
      dependencyWaves: allWaves.length,
      parallelWaves: allWaves.filter((wave) => wave.nodeAliases?.length > 1).length,
      maxWaveWidth: Math.max(0, ...allWaves.map((wave) => wave.nodeAliases?.length ?? 0)),
      launchBatches,
    },
    repetition: {
      exactAnchorPairs: repetition.exactAnchors ?? [],
      nearAnchorPairs: repetition.nearAnchors ?? [],
      exactLabelPairs: repetition.exactLabels ?? [],
      nearLabelPairs: repetition.nearLabels ?? [],
      truncated: repetition.truncated === true,
    },
    signals: {
      builderInvalidations: events.filter((event) => event.signals?.includes("builder_invalidation")).length,
      userRedirects: events.filter((event) => event.kind === "user_intervention" && event.signals?.includes("redirect")).length,
      userStops: events.filter((event) => event.kind === "user_intervention" && event.signals?.includes("stop")).length,
      authDataBoundaries: events.filter((event) => event.signals?.includes("auth_data_boundary")).length,
    },
  };
}

function normalizedDescription(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function validateCalibration(calibration, errors) {
  if (calibration === undefined) return;
  if (!isObject(calibration)) {
    errors.push("calibration must be an object");
    return;
  }
  if (!CALIBRATION_BEHAVIORS.has(calibration.behavior)) errors.push("calibration.behavior is invalid");
  if (!CALIBRATION_DECISIONS.has(calibration.expectedDecision)) errors.push("calibration.expectedDecision is invalid");
  if (!RISK_THRESHOLDS.has(calibration.riskThreshold)) errors.push("calibration.riskThreshold is invalid");
  if (!Array.isArray(calibration.acceptanceCriteria)
    || !calibration.acceptanceCriteria.length
    || calibration.acceptanceCriteria.some((criterion) => typeof criterion !== "string" || !criterion.trim())) {
    errors.push("calibration.acceptanceCriteria must contain non-empty criteria");
  }
  if (!isObject(calibration.criteriaRevision)
    || calibration.criteriaRevision.frozenWithinLoop !== true
    || calibration.criteriaRevision.allowedWithRationale !== true) {
    errors.push("calibration.criteriaRevision must freeze one loop and allow a reasoned packet revision");
  }
}

export function validateFixture(fixture, normalized) {
  const errors = [];
  if (!isObject(fixture)) return { valid: false, errors: ["Fixture must be an object"] };
  if (fixture.schemaVersion !== FIXTURE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${FIXTURE_SCHEMA_VERSION}`);
  if (typeof fixture.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(fixture.id)) errors.push("id must be a lowercase slug");
  if (typeof fixture.title !== "string" || !fixture.title.trim()) errors.push("title is required");
  validateCalibration(fixture.calibration, errors);
  if (!isObject(fixture.rubric) || !Array.isArray(fixture.rubric.dimensions)) {
    errors.push("rubric.dimensions must be an array");
  } else {
    const dimensions = fixture.rubric.dimensions;
    const ids = dimensions.map((dimension) => dimension?.id);
    if (new Set(ids).size !== ids.length) errors.push("rubric dimension IDs must be unique");
    for (const id of RUBRIC_DIMENSIONS) {
      if (!ids.includes(id)) errors.push(`rubric dimension is missing: ${id}`);
    }
    for (const dimension of dimensions) {
      if (!RUBRIC_DIMENSIONS.includes(dimension?.id)) errors.push(`unknown rubric dimension: ${dimension?.id}`);
      if (typeof dimension?.weight !== "number" || !Number.isFinite(dimension.weight) || dimension.weight <= 0) {
        errors.push(`dimension ${dimension?.id ?? "unknown"} needs a positive weight`);
      }
      if (!Array.isArray(dimension?.criteria) || !dimension.criteria.every((criterion) => typeof criterion === "string" && criterion.trim())) {
        errors.push(`dimension ${dimension?.id ?? "unknown"} needs non-empty criteria`);
      }
    }
    const weight = dimensions.reduce((sum, dimension) => sum + (typeof dimension?.weight === "number" ? dimension.weight : 0), 0);
    if (Math.abs(weight - 1) > 1e-9) errors.push("rubric dimension weights must sum to 1");
  }
  if (!Array.isArray(fixture.checkpoints) || !fixture.checkpoints.length) {
    errors.push("at least one checkpoint is required");
  } else {
    const eventIds = new Set(normalized?.events?.map((event) => event.id) ?? []);
    const checkpointIds = new Set();
    for (const checkpoint of fixture.checkpoints) {
      const checkpointId = typeof checkpoint?.id === "string" ? checkpoint.id.trim() : "";
      const prefix = `checkpoint ${checkpointId || "unknown"}`;
      if (!checkpointId) errors.push(`${prefix} needs an id`);
      else if (checkpointIds.has(checkpointId)) errors.push(`checkpoint IDs must be unique: ${checkpointId}`);
      else checkpointIds.add(checkpointId);
      if (typeof checkpoint?.situation !== "string" || !checkpoint.situation.trim()) errors.push(`${prefix} needs a situation`);
      if (typeof checkpoint?.afterEvent !== "string") errors.push(`${prefix} needs afterEvent`);
      else if (normalized && !eventIds.has(checkpoint.afterEvent)) errors.push(`${prefix} references missing event ${checkpoint.afterEvent}`);
      if (!Array.isArray(checkpoint?.acceptableNextActions) || checkpoint.acceptableNextActions.length < 2) {
        errors.push(`${prefix} must allow at least two acceptable next actions`);
        continue;
      }
      const actionIds = new Set();
      const descriptions = new Set();
      const signatures = new Set();
      for (const action of checkpoint.acceptableNextActions) {
        const actionId = typeof action?.id === "string" ? action.id.trim() : "";
        if (!actionId) errors.push(`${prefix} has an action without an id`);
        else if (actionIds.has(actionId)) errors.push(`${prefix} action IDs must be unique: ${actionId}`);
        else actionIds.add(actionId);
        const description = normalizedDescription(action?.description);
        if (!description) errors.push(`${prefix} has an action without a description`);
        else if (descriptions.has(description)) errors.push(`${prefix} has duplicate normalized action descriptions`);
        else descriptions.add(description);
        const supports = Array.isArray(action?.supports) ? action.supports : [];
        if (!supports.length || supports.some((id) => !RUBRIC_DIMENSIONS.includes(id))) {
          errors.push(`${prefix} action ${actionId || "unknown"} has invalid supports dimensions`);
        }
        if (new Set(supports).size !== supports.length) errors.push(`${prefix} action ${actionId || "unknown"} repeats supports dimensions`);
        const signature = `${description}\0${[...new Set(supports)].sort().join(",")}`;
        if (signatures.has(signature)) errors.push(`${prefix} has duplicate acceptable actions`);
        else signatures.add(signature);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
