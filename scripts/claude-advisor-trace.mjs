#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { advisorStateRoot } from "./advisor-core/advisor-state.mjs";
import { validateResultArtifact } from "./advisor-core/result-artifact.mjs";

const ROOT_NODE = "advisor";
const HOST = "claude-code";
const MAKER = "advisor-maker";
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

function parseRiskTier(prompt) {
  const match = prompt.match(/\brisk\s+tier\b[\s:*_`-]*(low|standard|high)\b/i)?.[1]?.toLowerCase();
  return match === "low" || match === "standard" || match === "high" ? match : "high";
}

function parseAcceptance(prompt) {
  const lines = prompt.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*(?:#{1,6}\s*)?ACCEPTANCE CRITERIA\s*:?\s*#*\s*$/i.test(line));
  if (start < 0) return ["result.md validates with the six required headings"];
  const criteria = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#{1,6}\s+|[A-Z][A-Z _-]+:\s*$)/.test(line) && criteria.length > 0) break;
    const match = /^\s*(?:-\s+|\d+[.)]\s+)(.+?)\s*$/.exec(line);
    if (match?.[1]) criteria.push(match[1]);
  }
  return criteria.length > 0 ? criteria : ["result.md validates with the six required headings"];
}

function blockedKind(text) {
  if (/\bcredential(?:s)?\b|\bapi[ -]?key\b|\bpassword\b|\bsecret\b|\bauth(?:entication)? token\b/i.test(text)) {
    return "credential";
  }
  if (/\bpermission\b|\bauthori[sz](?:e|ation)\b|\bapproval\b|\baccess grant\b/i.test(text)) {
    return "permission";
  }
  if (/\bexternal action\b|\bdeploy\b|\bpublish\b|\bpush\b|\bsend\b.+\b(message|email)\b/i.test(text)) {
    return "external-action";
  }
  return "decision";
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, path);
}

async function withLock(path, task) {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      handle = await open(path, "wx");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!handle) throw new Error(`timed out acquiring lock ${path}`);
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await task();
  } finally {
    await handle.close();
    await unlink(path).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function readTrace(path) {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function nextWakeGeneration(events, parent) {
  return events.reduce((generation, event) => {
    if (event.type !== "parent.awakened" || event.node !== parent) return generation;
    const candidate = event.data?.wakeGeneration;
    return typeof candidate === "number" ? Math.max(generation, candidate) : generation;
  }, 0) + 1;
}

async function appendTrace(root, runId, createDrafts) {
  const path = join(root, "traces", `${runId}.jsonl`);
  return withLock(`${path}.lock`, async () => {
    const events = await readTrace(path);
    const drafts = await createDrafts(events);
    if (drafts.length === 0) return events;
    const prior = Date.parse(events.at(-1)?.at ?? "");
    const at = new Date(Number.isFinite(prior) ? Math.max(Date.now(), prior) : Date.now()).toISOString();
    let seq = events.at(-1)?.seq ?? 0;
    const appended = drafts.map((draft) => ({
      v: 1,
      seq: ++seq,
      at,
      run: runId,
      host: HOST,
      ...draft,
    }));
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${appended.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    return [...events, ...appended];
  });
}

function sessionPaths(root, sessionId) {
  const directory = join(root, "hosts", HOST, sessionId);
  return {
    directory,
    lock: join(directory, "session.lock"),
    pending: join(directory, "pending-launch.json"),
    ordinal: join(directory, "current-run-ordinal.json"),
  };
}

function agentMappingPath(paths, agentId) {
  return join(paths.directory, "agents", `${hash(agentId, 32)}.json`);
}

function launchMappingPath(paths, toolUseId) {
  return join(paths.directory, "launches", `${hash(toolUseId, 32)}.json`);
}

async function reserveResult(path) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  await handle.close();
}

async function inspectArtifact(path) {
  let markdown;
  try {
    markdown = await readFile(path, "utf8");
  } catch (error) {
    const problem = error?.code === "ENOENT"
      ? "result artifact is missing"
      : `result artifact could not be read: ${error.message}`;
    return { present: false, validation: { valid: false, problems: [problem] } };
  }
  if (!markdown.trim()) {
    return { present: false, validation: { valid: false, problems: ["result artifact is empty"] } };
  }
  return { present: true, validation: validateResultArtifact(markdown) };
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

async function preToolUse(payload, root, paths) {
  if (payload.tool_name !== "Agent") return;
  const input = objectValue(payload.tool_input);
  const toolUseId = stringValue(payload.tool_use_id);
  const prompt = stringValue(input?.prompt);
  const description = stringValue(input?.description);
  const subagentType = stringValue(input?.subagent_type);
  const model = input?.model === undefined ? undefined : stringValue(input.model);
  if (!toolUseId || !prompt || !description || !subagentType || (input?.model !== undefined && !model)) return;
  await withLock(paths.lock, async () => {
    await writeJsonAtomic(paths.pending, {
      sessionId: payload.session_id,
      toolUseId,
      prompt,
      description,
      subagentType,
      ...(model ? { model } : {}),
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
      if (pending?.sessionId !== payload.session_id || pending?.subagentType !== MAKER) return undefined;
      const toolUseId = stringValue(pending.toolUseId);
      const prompt = stringValue(pending.prompt);
      const description = stringValue(pending.description);
      const cwd = stringValue(pending.cwd);
      if (!toolUseId || !prompt || !description || !cwd) return undefined;
      const ordinalState = objectValue(await readJson(paths.ordinal));
      const priorOrdinal = Number.isSafeInteger(ordinalState?.value) && ordinalState.value >= 0 ? ordinalState.value : 0;
      const ordinal = priorOrdinal + 1;
      const runId = `cc-${hash(payload.session_id)}-${ordinal}`;
      const nodeId = `advisor-maker-${hash(agentId)}`;
      const resultPath = join(root, "runs", HOST, runId, "result.md");
      mapping = {
        runId,
        nodeId,
        agentId,
        toolUseId,
        resultPath,
        prompt,
        description,
        cwd,
        model: stringValue(pending.model) ?? "unknown",
      };
      await writeJsonAtomic(paths.ordinal, { value: ordinal });
      await reserveResult(resultPath);
      await writeJsonAtomic(agentPath, mapping);
      await writeJsonAtomic(launchMappingPath(paths, toolUseId), mapping);
    }

    await reserveResult(mapping.resultPath);
    await appendTrace(root, mapping.runId, (events) => {
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
            label: mapping.description,
            harness: HOST,
            model: mapping.model,
            thinking: "unspecified",
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
    await appendTrace(root, mapping.runId, async (events) => {
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

async function writeRunNote(path, value) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
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

async function postToolUse(payload, root, paths) {
  if (payload.tool_name !== "Agent") return;
  const toolUseId = stringValue(payload.tool_use_id);
  const response = objectValue(payload.tool_response);
  if (!toolUseId || response?.status !== "completed") return;
  await withLock(paths.lock, async () => {
    const mapping = mappingFrom(await readJson(launchMappingPath(paths, toolUseId)));
    if (!mapping || mapping.toolUseId !== toolUseId) return;
    const responseAgentId = stringValue(response.agentId);
    if (responseAgentId && responseAgentId !== mapping.agentId) {
      await writeRunNote(join(root, "runs", HOST, mapping.runId, "agent-id-mismatch.json"), {
        note: "PostToolUse Agent tool_response.agentId did not match the SubagentStart agent_id.",
        expectedAgentId: mapping.agentId,
        responseAgentId,
        toolUseId,
      });
    }
    await appendTrace(root, mapping.runId, (events) => {
      const settlement = settledEvent(events, mapping.nodeId);
      return settlement ? wakeDraft(events, mapping, settlement) : [];
    });
  });
}

async function postToolUseFailure(payload, root, paths) {
  if (payload.tool_name !== "Agent") return;
  const toolUseId = stringValue(payload.tool_use_id);
  if (!toolUseId) return;
  await withLock(paths.lock, async () => {
    const mapping = mappingFrom(await readJson(launchMappingPath(paths, toolUseId)));
    if (!mapping || mapping.toolUseId !== toolUseId) return;
    await appendTrace(root, mapping.runId, (events) => {
      if (awakened(events, mapping.nodeId)) return [];
      const launch = events.find((event) => event.type === "node.launched" && event.node === mapping.nodeId);
      if (!launch) return [];
      const existing = settledEvent(events, mapping.nodeId);
      if (existing) return wakeDraft(events, mapping, existing);
      const reason = stringValue(payload.error) ?? "Claude Code Agent tool failed";
      const settlement = {
        type: "node.settled",
        node: mapping.nodeId,
        parent: ROOT_NODE,
        data: { status: "failed", reason },
      };
      return [settlement, ...wakeDraft([...events, { ...settlement, run: mapping.runId }], mapping, settlement)];
    });
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
      await postToolUse(payload, root, paths);
      return undefined;
    case "PostToolUseFailure":
      await postToolUseFailure(payload, root, paths);
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
