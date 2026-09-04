#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { advisorStateRoot } from "./advisor-core/advisor-state.mjs";
import {
  appendTrace,
  blockedKind,
  inspectArtifact,
  nextWakeGeneration,
  parseAcceptance,
  parseRiskTier,
  readJson,
  reserveResult,
  withLock,
  writeJsonAtomic,
} from "./advisor-core/host-binding.mjs";

const ROOT_NODE = "advisor";
const HOST = "codex";
const MAKER = "advisor-maker";
const SPAWN_TOOLS = new Set(["spawn_agent", "Agent", "multi_agent_v1.spawn_agent"]);
const WAIT_TOOLS = new Set(["wait_agent", "multi_agent_v1.wait_agent"]);
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hash(value, length = 16) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function sessionInput(payload) {
  const sessionId = stringValue(payload?.session_id);
  const cwd = stringValue(payload?.cwd);
  if (!sessionId || !SAFE_SESSION_ID.test(sessionId) || !cwd) return undefined;
  return { sessionId, cwd };
}

function sessionPaths(root, sessionId) {
  const directory = join(root, "hosts", HOST, sessionId);
  return {
    directory,
    lock: join(directory, "session.lock"),
    pending: join(directory, "pending-launch.json"),
    ordinal: join(directory, "current-run-ordinal.json"),
    agents: join(directory, "agents"),
    launches: join(directory, "launches"),
  };
}

function agentMappingPath(paths, agentId) {
  return join(paths.agents, `${hash(agentId, 32)}.json`);
}

function launchMappingPath(paths, toolUseId) {
  return join(paths.launches, `${hash(toolUseId, 32)}.json`);
}

function mappingFrom(value) {
  const mapping = objectValue(value);
  if (!mapping) return undefined;
  const runId = stringValue(mapping.runId);
  const nodeId = stringValue(mapping.nodeId);
  const agentId = stringValue(mapping.agentId);
  const toolUseId = stringValue(mapping.toolUseId);
  const resultPath = stringValue(mapping.resultPath);
  if (!runId || !nodeId || !agentId || !toolUseId || !resultPath) return undefined;
  return { ...mapping, runId, nodeId, agentId, toolUseId, resultPath };
}

async function writeMapping(paths, mapping) {
  await writeJsonAtomic(agentMappingPath(paths, mapping.agentId), mapping);
  await writeJsonAtomic(launchMappingPath(paths, mapping.toolUseId), mapping);
}

async function readMappings(paths) {
  let entries;
  try {
    entries = await readdir(paths.agents);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const mappings = await Promise.all(entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readJson(join(paths.agents, entry))));
  return mappings.map(mappingFrom).filter(Boolean).sort((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0));
}

function promptFrom(input) {
  const message = stringValue(input?.message);
  if (message) return message;
  if (!Array.isArray(input?.items)) return undefined;
  const text = input.items
    .map((item) => stringValue(objectValue(item)?.text))
    .filter(Boolean)
    .join("\n");
  return stringValue(text);
}

async function preToolUse(payload, root, paths) {
  if (!SPAWN_TOOLS.has(payload.tool_name)) return;
  const input = objectValue(payload.tool_input);
  const toolUseId = stringValue(payload.tool_use_id);
  const prompt = promptFrom(input);
  const agentType = stringValue(input?.agent_type);
  if (!toolUseId || !prompt || agentType !== MAKER) return;
  await withLock(paths.lock, async () => {
    await writeJsonAtomic(paths.pending, {
      sessionId: payload.session_id,
      toolUseId,
      prompt,
      agentType,
      taskName: stringValue(input?.task_name) ?? MAKER,
      model: stringValue(input?.model) ?? "unknown",
      thinking: stringValue(input?.reasoning_effort) ?? "unspecified",
      cwd: payload.cwd,
      stateRoot: root,
    });
  });
}

function startContext(resultPath) {
  return [
    "Advisor result contract:",
    `Write the complete durable result to exactly: ${resultPath}`,
    "Use the six top-level headings Status, Claims, Evidence, Files, Decisions, and Remaining Risk.",
    "The first nonempty line under Status must be terminal. Never leave IN PROGRESS as the final status.",
    "Do not spawn agents.",
  ].join("\n");
}

async function subagentStart(payload, root, paths) {
  if (payload.agent_type !== MAKER) return undefined;
  const agentId = stringValue(payload.agent_id);
  if (!agentId) return undefined;
  return withLock(paths.lock, async () => {
    const agentPath = agentMappingPath(paths, agentId);
    let mapping = mappingFrom(await readJson(agentPath));
    if (!mapping) {
      const pending = objectValue(await readJson(paths.pending));
      if (pending?.sessionId !== payload.session_id || pending?.agentType !== MAKER) return undefined;
      const toolUseId = stringValue(pending.toolUseId);
      const prompt = stringValue(pending.prompt);
      const cwd = stringValue(pending.cwd);
      if (!toolUseId || !prompt || !cwd) return undefined;
      const ordinalState = objectValue(await readJson(paths.ordinal));
      const priorOrdinal = Number.isSafeInteger(ordinalState?.value) && ordinalState.value >= 0 ? ordinalState.value : 0;
      const ordinal = priorOrdinal + 1;
      const runId = `cx-${hash(payload.session_id)}-${ordinal}`;
      const nodeId = `advisor-maker-${hash(agentId)}`;
      const resultPath = join(root, "runs", HOST, runId, "result.md");
      mapping = {
        runId,
        nodeId,
        ordinal,
        agentId,
        toolUseId,
        resultPath,
        prompt,
        cwd,
        label: stringValue(pending.taskName) ?? MAKER,
        model: stringValue(pending.model) ?? "unknown",
        thinking: stringValue(pending.thinking) ?? "unspecified",
      };
      await writeJsonAtomic(paths.ordinal, { value: ordinal });
      await reserveResult(resultPath);
      await writeMapping(paths, mapping);
    }

    await reserveResult(mapping.resultPath);
    await appendTrace(root, mapping.runId, HOST, (events) => {
      if (events.length > 0) return [];
      return [
        {
          type: "run.created",
          node: null,
          parent: null,
          data: {
            workstream: stringValue(process.env.ADVISOR_WORKSTREAM) ?? HOST,
            goal: mapping.prompt,
            stateRoot: root,
            root: { node: ROOT_NODE, session: payload.session_id },
          },
        },
        {
          type: "node.launched",
          node: mapping.nodeId,
          parent: ROOT_NODE,
          data: {
            role: "builder",
            label: mapping.label,
            harness: HOST,
            model: mapping.model,
            thinking: mapping.thinking,
            cwd: mapping.cwd,
            riskTier: parseRiskTier(mapping.prompt),
            acceptance: parseAcceptance(mapping.prompt),
            resultPath: mapping.resultPath,
            launchRef: {
              sessionId: payload.session_id,
              agentId: mapping.agentId,
              toolUseId: mapping.toolUseId,
            },
          },
        },
      ];
    });
    await unlink(paths.pending).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return mapping.resultPath;
  });
}

function settledEvent(events, nodeId) {
  return events.find((event) => event.type === "node.settled" && event.node === nodeId);
}

function awakened(events, nodeId) {
  return events.some((event) => event.type === "parent.awakened" && event.data?.child === nodeId);
}

async function subagentStop(payload, root, paths) {
  if (payload.agent_type !== MAKER) return;
  const agentId = stringValue(payload.agent_id);
  if (!agentId) return;
  await withLock(paths.lock, async () => {
    const mapping = mappingFrom(await readJson(agentMappingPath(paths, agentId)));
    if (!mapping || mapping.agentId !== agentId) return;
    await appendTrace(root, mapping.runId, HOST, async (events) => {
      if (settledEvent(events, mapping.nodeId)) return [];
      const launch = events.find((event) => event.type === "node.launched" && event.node === mapping.nodeId);
      if (!launch) return [];
      const artifact = await inspectArtifact(mapping.resultPath);
      const valid = artifact.validation.valid;
      const blocked = valid && /^BLOCKED\b/i.test(artifact.validation.status ?? "");
      const status = valid ? (blocked ? "blocked" : "done") : "stalled";
      const drafts = [];
      if (blocked) {
        const text = artifact.validation.statusBody ?? "Advisor maker is blocked and needs a decision.";
        drafts.push({
          type: "node.blocked",
          node: mapping.nodeId,
          parent: ROOT_NODE,
          data: { request: { kind: blockedKind(text), text } },
        });
      }
      if (artifact.present) {
        drafts.push({
          type: "node.result.written",
          node: mapping.nodeId,
          parent: ROOT_NODE,
          data: { path: mapping.resultPath },
        });
        drafts.push({
          type: "node.result.validated",
          node: mapping.nodeId,
          parent: ROOT_NODE,
          data: {
            path: mapping.resultPath,
            valid,
            problems: artifact.validation.problems,
            ...(valid && artifact.validation.status ? { status: artifact.validation.status } : {}),
          },
        });
      }
      const reason = valid
        ? `agent settled ${status} with a valid result artifact`
        : `result artifact is invalid: ${artifact.validation.problems.join("; ")}`;
      drafts.push({
        type: "node.settled",
        node: mapping.nodeId,
        parent: ROOT_NODE,
        data: {
          status,
          reason,
          ...(valid && artifact.validation.status ? { resultStatus: artifact.validation.status } : {}),
        },
      });
      return drafts;
    });
  });
}

async function postSpawn(payload, paths) {
  if (stringValue(objectValue(payload.tool_input)?.agent_type) !== MAKER) return;
  const toolUseId = stringValue(payload.tool_use_id);
  const response = objectValue(payload.tool_response);
  if (!toolUseId || !response) return;
  await withLock(paths.lock, async () => {
    const mapping = mappingFrom(await readJson(launchMappingPath(paths, toolUseId)));
    if (!mapping || mapping.toolUseId !== toolUseId) return;
    const updated = {
      ...mapping,
      ...(stringValue(response.agent_id) ? { nativeAgentId: stringValue(response.agent_id) } : {}),
      ...(stringValue(response.task_name) ? { nativeTaskName: stringValue(response.task_name) } : {}),
      ...(stringValue(response.nickname) ? { nickname: stringValue(response.nickname) } : {}),
    };
    await writeMapping(paths, updated);
  });
}

function wakeDraft(events, mapping, settlement) {
  if (awakened(events, mapping.nodeId)) return [];
  const written = events.some((event) => event.type === "node.result.written" && event.node === mapping.nodeId);
  return [{
    type: "parent.awakened",
    node: ROOT_NODE,
    parent: null,
    data: {
      child: mapping.nodeId,
      childStatus: settlement.data.status,
      wakeGeneration: nextWakeGeneration(events, ROOT_NODE),
      ...(written ? { resultPath: mapping.resultPath } : {}),
    },
  }];
}

function failureSettlement(status) {
  const value = objectValue(status);
  const error = stringValue(value?.errored);
  if (error) return { status: "failed", reason: error };
  if (status === "interrupted" || status === "shutdown") {
    return { status: "cancelled", reason: `wait_agent reported ${status}` };
  }
  return undefined;
}

function statusForMapping(statuses, mapping) {
  const targets = new Set([
    mapping.agentId,
    stringValue(mapping.nativeAgentId),
    stringValue(mapping.nativeTaskName),
  ].filter(Boolean));
  return Object.entries(statuses).find(([target]) => targets.has(target))?.[1];
}

async function deliverV1Wait(root, paths, response) {
  const statuses = objectValue(response.status);
  if (!statuses || Object.keys(statuses).length === 0) return;
  for (const mapping of await readMappings(paths)) {
    const nativeStatus = statusForMapping(statuses, mapping);
    if (nativeStatus === undefined) continue;
    await appendTrace(root, mapping.runId, HOST, (events) => {
      const existing = settledEvent(events, mapping.nodeId);
      if (existing) return wakeDraft(events, mapping, existing);
      const failure = failureSettlement(nativeStatus);
      const launch = events.find((event) => event.type === "node.launched" && event.node === mapping.nodeId);
      if (!failure || !launch) return [];
      const settlement = {
        type: "node.settled",
        node: mapping.nodeId,
        parent: ROOT_NODE,
        data: failure,
      };
      return [
        settlement,
        ...wakeDraft([...events, { ...settlement, run: mapping.runId }], mapping, settlement),
      ];
    });
  }
}

async function deliverV2Wait(root, paths, response) {
  if (/^Wait interrupted by new input\./i.test(stringValue(response.message) ?? "")) return;
  for (const mapping of await readMappings(paths)) {
    let delivered = false;
    await appendTrace(root, mapping.runId, HOST, (events) => {
      const settlement = settledEvent(events, mapping.nodeId);
      const drafts = settlement ? wakeDraft(events, mapping, settlement) : [];
      delivered = drafts.length > 0;
      return drafts;
    });
    if (delivered) return;
  }
}

async function postWait(payload, root, paths) {
  const response = objectValue(payload.tool_response);
  if (!response || response.timed_out !== false) return;
  await withLock(paths.lock, async () => {
    if (payload.tool_name === "multi_agent_v1.wait_agent") {
      await deliverV1Wait(root, paths, response);
    } else {
      await deliverV2Wait(root, paths, response);
    }
  });
}

async function handle(payload) {
  const input = sessionInput(payload);
  const event = stringValue(payload?.hook_event_name);
  if (!input || !event) return undefined;
  const root = await advisorStateRoot(input.cwd);
  const paths = sessionPaths(root, input.sessionId);
  switch (event) {
    case "PreToolUse":
      await preToolUse(payload, root, paths);
      return undefined;
    case "SubagentStart":
      return subagentStart(payload, root, paths);
    case "SubagentStop":
      await subagentStop(payload, root, paths);
      return undefined;
    case "PostToolUse":
      if (SPAWN_TOOLS.has(payload.tool_name)) await postSpawn(payload, paths);
      if (WAIT_TOOLS.has(payload.tool_name)) await postWait(payload, root, paths);
      return undefined;
    default:
      return undefined;
  }
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const resultPath = await handle(objectValue(payload));
  if (resultPath) {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext: startContext(resultPath),
      },
    })}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {});
}
