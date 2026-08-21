import { createHash } from "node:crypto";

const NORMALIZED_SCHEMA_VERSION = 1;
const FIXTURE_SCHEMA_VERSION = 1;
const RUBRIC_DIMENSIONS = [

  "outcomeCorrectness",
  "informationValue",
  "adaptationConvergence",
  "efficiencyParallelism",
  "safetyCommunication",
];

const SUMMARY_PREFIX = /^\s*EVAL_SUMMARY:\s*(.+)$/im;
const ACTIVE_GAP_LIMIT_MS = 5 * 60 * 1000;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestampOf(entry) {
  const value = entry?.timestamp ?? entry?.message?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
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

export function sanitizeMetadataText(value, maxLength = 160) {
  if (typeof value !== "string") return undefined;
  let text = value
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Z]:\\(?:[^\s\\]+\\)+[^\s\\]*/g, "[path]")
    .replace(/(?:^|\s)(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/tmp|\/tmp)(?:\/[^\s]*)?/g, (match) => `${match.startsWith(" ") ? " " : ""}[path]`)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b[A-Z][A-Z0-9]{1,9}-\d{2,}\b/g, "[ticket]")
    .replace(/\b(?:gh[pousr]_|sk-|NRAK-|ctx7sk-)[A-Za-z0-9_-]{12,}\b/g, "[secret]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[opaque]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  if (text.length > maxLength) text = `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
  return text;
}

function fingerprint(value) {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
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

function extractSummary(text, includeSummaries) {
  if (!includeSummaries) return undefined;
  const match = text.match(SUMMARY_PREFIX);
  return match ? sanitizeMetadataText(match[1], 240) : undefined;
}

function graphWaves(nodes) {
  const pending = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!isObject(node) || typeof node.id !== "string") continue;
    pending.set(node.id, {
      rawId: node.id,
      id: sanitizeMetadataText(node.id, 80),
      role: sanitizeMetadataText(node.role, 40),
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
        nodeIds: [...pending.values()].map((node) => node.id).sort(),
        roles: [],
        unresolved: true,
      });
      break;
    }
    const sorted = ready.sort((left, right) => left.id.localeCompare(right.id));
    waves.push({
      index: waves.length + 1,
      nodeIds: sorted.map((node) => node.id),
      roles: sorted.map((node) => node.role).filter(Boolean),
    });
    for (const node of ready) {
      completed.add(node.rawId);
      pending.delete(node.rawId);
    }
  }
  return waves;
}

function normalizedStatus(value) {
  const status = String(value ?? "unknown").toLowerCase();
  if (["completed", "complete", "succeeded", "success", "passed", "done"].includes(status)) return "successful";
  if (["failed", "failure", "error", "errored", "rejected"].includes(status)) return "failed";
  if (["running", "started", "promoted", "pending", "requested"].includes(status)) return "running";
  if (["blocked", "cancelled", "canceled", "stopped"].includes(status)) return status === "canceled" ? "cancelled" : status;
  return sanitizeMetadataText(status, 40) ?? "unknown";
}

export function parseJsonl(text) {
  const entries = [];
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!isObject(value)) throw new Error("entry must be an object");
      entries.push(value);
    } catch (cause) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (!entries.length) throw new Error("Session JSONL contains no entries");
  return entries;
}

export function normalizeSession(entries, { includeSummaries = false } = {}) {
  if (!Array.isArray(entries)) throw new Error("normalizeSession expects parsed JSONL entries");
  const events = [];
  const toolCalls = new Map();
  const seenWorkers = new Set();
  let generatedWorker = 0;

  const add = (entry, event) => {
    const normalized = {
      id: `e${String(events.length + 1).padStart(4, "0")}`,
      timestamp: timestampOf(entry),
      ...event,
    };
    if (!normalized.timestamp) delete normalized.timestamp;
    events.push(normalized);
    return normalized;
  };

  for (const entry of entries) {
    if (entry.type === "session") {
      add(entry, { kind: "session_started" });
      continue;
    }

    if (entry.type === "custom_message" && entry.customType === "detach_agent_settled") {
      const details = isObject(entry.details) ? entry.details : {};
      add(entry, {
        kind: "worker_status",
        toolName: "bg_agent",
        workerKey: sanitizeMetadataText(details.agentName ?? details.label ?? `worker-${++generatedWorker}`, 100),
        label: sanitizeMetadataText(details.label, 120),
        status: normalizedStatus(details.agentState ?? details.status),
        startedAt: timestampOf({ timestamp: details.startedAt }),
        endedAt: timestampOf({ timestamp: details.endedAt }),
      });
      continue;
    }

    if (entry.type !== "message" || !isObject(entry.message)) continue;
    const message = entry.message;
    const text = messageText(message);

    if (message.role === "user") {
      const signals = textSignals(text);
      add(entry, {
        kind: signals.length ? "user_intervention" : "user_message",
        ...(signals.length ? { signals } : {}),
        ...(extractSummary(text, includeSummaries) ? { summary: extractSummary(text, includeSummaries) } : {}),
      });
      continue;
    }

    if (message.role === "assistant") {
      const signals = textSignals(text);
      const summary = extractSummary(text, includeSummaries);
      if (signals.length || summary) {
        add(entry, {
          kind: "assistant_decision",
          ...(signals.length ? { signals } : {}),
          ...(summary ? { summary } : {}),
        });
      }
      for (const item of Array.isArray(message.content) ? message.content : []) {
        if (item?.type !== "toolCall" || typeof item.name !== "string") continue;
        const args = isObject(item.arguments) ? item.arguments : {};
        let event;
        if (item.name === "advisor_graph_plan") {
          const waves = graphWaves(args.nodes);
          event = add(entry, {
            kind: "graph_plan",
            toolName: item.name,
            graphId: sanitizeMetadataText(args.graphId, 100),
            nodeCount: Array.isArray(args.nodes) ? args.nodes.length : 0,
            waves,
          });
        } else if (item.name === "bg_agent") {
          const workerKey = sanitizeMetadataText(args.name ?? args.label ?? `worker-${++generatedWorker}`, 100);
          const label = sanitizeMetadataText(args.label, 120);
          const anchorText = typeof args.anchor === "string" ? args.anchor : "";
          const action = seenWorkers.has(workerKey) ? "resume" : "launch";
          seenWorkers.add(workerKey);
          event = add(entry, {
            kind: "worker_launch",
            toolName: item.name,
            action,
            workerKey,
            role: sanitizeMetadataText(args.role, 40),
            model: sanitizeMetadataText(args.model, 100),
            label,
            labelFingerprint: fingerprint(label),
            labelSimilarity: simhash(label),
            anchorFingerprint: fingerprint(normalizedWords(anchorText).join(" ")),
            anchorSimilarity: simhash(anchorText),
            anchorWordCount: normalizedWords(anchorText).length,
            status: "requested",
          });
        } else {
          event = add(entry, { kind: "tool_call", toolName: sanitizeMetadataText(item.name, 100) });
        }
        if (typeof item.id === "string") toolCalls.set(item.id, event);
      }
      continue;
    }

    if (message.role === "toolResult") {
      const linked = toolCalls.get(message.toolCallId);
      const toolName = sanitizeMetadataText(message.toolName ?? linked?.toolName, 100);
      if (linked?.kind === "worker_launch") {
        const details = isObject(message.details) ? message.details : {};
        add(entry, {
          kind: "worker_launch_result",
          toolName: "bg_agent",
          workerKey: linked.workerKey,
          role: sanitizeMetadataText(details.role ?? linked.role, 40),
          model: sanitizeMetadataText(details.model ?? linked.model, 100),
          status: message.isError ? "failed" : normalizedStatus(details.status ?? "running"),
        });
      } else if (message.isError) {
        add(entry, { kind: "tool_error", toolName, status: "failed" });
      }
    }
  }

  return {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    source: {
      kind: "pi-session-jsonl",
      entryCount: entries.length,
      textPolicy: includeSummaries ? "tagged-eval-summaries-only" : "no-message-text",
    },
    redaction: {
      rawMessageBodiesCopied: false,
      rawToolPayloadsCopied: false,
      selectedMetadataOnly: true,
      metadataSanitized: true,
      anchorTextStored: false,
    },
    events,
  };
}

function jaccard(left, right) {
  const a = new Set(normalizedWords(left));
  const b = new Set(normalizedWords(right));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((value) => b.has(value)).length;
  return intersection / new Set([...a, ...b]).size;
}

function duplicateFacts(launches) {
  const exactAnchors = [];
  const nearAnchors = [];
  const exactLabels = [];
  const nearLabels = [];
  for (let left = 0; left < launches.length; left += 1) {
    for (let right = left + 1; right < launches.length; right += 1) {
      const a = launches[left];
      const b = launches[right];
      const pair = [a.id, b.id];
      if (a.anchorFingerprint && a.anchorFingerprint === b.anchorFingerprint) exactAnchors.push(pair);
      else if (hammingDistance(a.anchorSimilarity, b.anchorSimilarity) <= 10) nearAnchors.push(pair);
      if (a.labelFingerprint && a.labelFingerprint === b.labelFingerprint) exactLabels.push(pair);
      else if (jaccard(a.label, b.label) >= 0.75) nearLabels.push(pair);
    }
  }
  return { exactAnchors, nearAnchors, exactLabels, nearLabels };
}

export function analyzeTrace(normalized) {
  if (!isObject(normalized) || normalized.schemaVersion !== NORMALIZED_SCHEMA_VERSION || !Array.isArray(normalized.events)) {
    throw new Error(`Expected normalized trace schemaVersion ${NORMALIZED_SCHEMA_VERSION}`);
  }
  const events = normalized.events;
  const times = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
  let activeElapsedMs = 0;
  for (let index = 1; index < times.length; index += 1) {
    activeElapsedMs += Math.min(times[index] - times[index - 1], ACTIVE_GAP_LIMIT_MS);
  }

  const launches = events.filter((event) => event.kind === "worker_launch");
  const attempts = [];
  const openByWorker = new Map();
  const failedWorkers = new Set();
  const recoveredWorkers = new Set();
  for (const event of events) {
    if (event.kind === "worker_launch") {
      const attempt = { eventId: event.id, workerKey: event.workerKey, role: event.role ?? "unknown", action: event.action, status: "requested" };
      attempts.push(attempt);
      openByWorker.set(event.workerKey, attempt);
    } else if (["worker_launch_result", "worker_status"].includes(event.kind)) {
      const attempt = openByWorker.get(event.workerKey);
      if (!attempt) continue;
      attempt.status = event.status;
      if (event.status === "failed") failedWorkers.add(event.workerKey);
      if (event.status === "successful" && failedWorkers.has(event.workerKey) && attempt.action === "resume") recoveredWorkers.add(event.workerKey);
    }
  }
  const successfulByRole = {};
  for (const attempt of attempts.filter((value) => value.status === "successful")) {
    successfulByRole[attempt.role] = (successfulByRole[attempt.role] ?? 0) + 1;
  }

  const graphs = events.filter((event) => event.kind === "graph_plan");
  const allWaves = graphs.flatMap((graph) => graph.waves ?? []);
  const launchBatches = Object.values(Object.groupBy(launches.filter((event) => event.timestamp), (event) => event.timestamp))
    .filter((batch) => batch.length > 1)
    .map((batch) => ({ timestamp: batch[0].timestamp, width: batch.length, eventIds: batch.map((event) => event.id) }));
  const toolUsage = {};
  for (const event of events.filter((candidate) => ["tool_call", "graph_plan", "worker_launch"].includes(candidate.kind))) {
    toolUsage[event.toolName] = (toolUsage[event.toolName] ?? 0) + 1;
  }
  const duplicate = duplicateFacts(launches);
  const failedAttempts = attempts.filter((attempt) => attempt.status === "failed").length;

  return {
    schemaVersion: 1,
    diagnosticOnly: true,
    limitations: [
      "Trace metrics describe observable events; they do not prove outcome quality or prescribe an orchestration workflow.",
      "Active elapsed time caps each inter-event gap at five minutes and is only a workload proxy.",
      "Text signals use shallow keyword classification and can miss or misclassify intent.",
      "Near-duplicate fingerprints are heuristic and require human review.",
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
      failedLaunches: failedAttempts,
      resumedLaunches: attempts.filter((attempt) => attempt.action === "resume").length,
      recoveredWorkers: recoveredWorkers.size,
      recoveryRatio: failedWorkers.size ? recoveredWorkers.size / failedWorkers.size : null,
    },
    graphs: {
      count: graphs.length,
      dependencyWaves: allWaves.length,
      parallelWaves: allWaves.filter((wave) => wave.nodeIds?.length > 1).length,
      maxWaveWidth: Math.max(0, ...allWaves.map((wave) => wave.nodeIds?.length ?? 0)),
      launchBatches,
    },
    repetition: {
      exactAnchorPairs: duplicate.exactAnchors,
      nearAnchorPairs: duplicate.nearAnchors,
      exactLabelPairs: duplicate.exactLabels,
      nearLabelPairs: duplicate.nearLabels,
    },
    signals: {
      builderInvalidations: events.filter((event) => event.signals?.includes("builder_invalidation")).length,
      userRedirects: events.filter((event) => event.kind === "user_intervention" && event.signals?.includes("redirect")).length,
      userStops: events.filter((event) => event.kind === "user_intervention" && event.signals?.includes("stop")).length,
      authDataBoundaries: events.filter((event) => event.signals?.includes("auth_data_boundary")).length,
    },
  };
}

export function validateFixture(fixture, normalized) {
  const errors = [];
  if (!isObject(fixture)) return { valid: false, errors: ["Fixture must be an object"] };
  if (fixture.schemaVersion !== FIXTURE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${FIXTURE_SCHEMA_VERSION}`);
  if (typeof fixture.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(fixture.id)) errors.push("id must be a lowercase slug");
  if (typeof fixture.title !== "string" || !fixture.title.trim()) errors.push("title is required");
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
      if (typeof dimension?.weight !== "number" || dimension.weight <= 0) errors.push(`dimension ${dimension?.id ?? "unknown"} needs a positive weight`);
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
    for (const checkpoint of fixture.checkpoints) {
      const prefix = `checkpoint ${checkpoint?.id ?? "unknown"}`;
      if (typeof checkpoint?.id !== "string" || !checkpoint.id.trim()) errors.push(`${prefix} needs an id`);
      if (typeof checkpoint?.situation !== "string" || !checkpoint.situation.trim()) errors.push(`${prefix} needs a situation`);
      if (typeof checkpoint?.afterEvent !== "string") errors.push(`${prefix} needs afterEvent`);
      else if (normalized && !eventIds.has(checkpoint.afterEvent)) errors.push(`${prefix} references missing event ${checkpoint.afterEvent}`);
      if (!Array.isArray(checkpoint?.acceptableNextActions) || checkpoint.acceptableNextActions.length < 2) {
        errors.push(`${prefix} must allow at least two acceptable next actions`);
      } else {
        for (const action of checkpoint.acceptableNextActions) {
          if (typeof action?.description !== "string" || !action.description.trim()) errors.push(`${prefix} has an action without a description`);
          if (!Array.isArray(action?.supports) || !action.supports.length || action.supports.some((id) => !RUBRIC_DIMENSIONS.includes(id))) {
            errors.push(`${prefix} action ${action?.id ?? "unknown"} has invalid supports dimensions`);
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function createRubricPacket(fixture, normalized, metrics = analyzeTrace(normalized)) {
  const validation = validateFixture(fixture, normalized);
  if (!validation.valid) throw new Error(`Invalid fixture:\n- ${validation.errors.join("\n- ")}`);
  return {
    schemaVersion: 1,
    packetType: "advisor-rubric-judge-input",
    case: { id: fixture.id, title: fixture.title, description: fixture.description },
    metrics,
    rubric: fixture.rubric,
    checkpoints: fixture.checkpoints,
    sanitizedTrace: normalized,
    judgeBoundary: {
      implementation: "external",
      instruction: "Assess judgment against the rubric. Multiple checkpoint actions may be good; do not require one golden plan.",
      outputSchema: {
        dimensions: RUBRIC_DIMENSIONS.map((id) => ({ id, score: "number 0..4", rationale: "string", evidenceEventIds: "string[]" })),
        checkpointAssessments: "{ checkpointId, assessment, evidenceEventIds }[]",
        uncertainties: "string[]",
        overallAssessment: "string",
      },
    },
  };
}

export function compareMetrics(left, right) {
  const paths = [
    ["elapsed", "activeElapsedMs"],
    ["workers", "launches"],
    ["workers", "failedLaunches"],
    ["workers", "resumedLaunches"],
    ["workers", "recoveredWorkers"],
    ["graphs", "count"],
    ["graphs", "parallelWaves"],
    ["graphs", "maxWaveWidth"],
    ["signals", "builderInvalidations"],
    ["signals", "userRedirects"],
    ["signals", "userStops"],
  ];
  const read = (object, path) => path.reduce((value, key) => value?.[key], object);
  return {
    schemaVersion: 1,
    diagnosticOnly: true,
    deltas: paths.map((path) => {
      const leftValue = read(left, path);
      const rightValue = read(right, path);
      return { metric: path.join("."), left: leftValue, right: rightValue, delta: rightValue - leftValue };
    }),
    note: "Deltas are descriptive and do not establish that either trace used a better workflow.",
  };
}
