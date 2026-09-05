import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  FIXTURES_DIR,
  loadSchema,
  parseTrace,
  projectTrace,
  validateTrace,
} from "../scripts/advisor-trace.mjs";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/codex-advisor-trace.mjs", import.meta.url));
const CLAUDE_SCRIPT = fileURLToPath(new URL("../scripts/claude-advisor-trace.mjs", import.meta.url));
const HOOK_FIXTURES = fileURLToPath(new URL("./fixtures/codex-hooks", import.meta.url));
const LIVE_CAPTURE = join(HOOK_FIXTURES, "live-capture.jsonl");
const CLAUDE_FIXTURES = fileURLToPath(new URL("./fixtures/claude-code-hooks", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function fixture(directory, name) {
  return JSON.parse(await readFile(join(directory, name), "utf8"));
}

async function capturedPayloads() {
  const payloads = (await readFile(LIVE_CAPTURE, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const pre = payloads.find((payload) => payload.hook_event_name === "PreToolUse");
  const start = payloads.find((payload) => payload.hook_event_name === "SubagentStart");
  const postSpawn = payloads.find((payload) => payload.hook_event_name === "PostToolUse");
  const stop = payloads.find((payload) => payload.hook_event_name === "SubagentStop");
  assert.ok(pre && start && postSpawn && stop);
  assert.equal(typeof postSpawn.tool_response, "string");
  return {
    pre,
    start,
    postSpawn,
    stop,
    sequence: payloads,
    sessionId: pre.session_id,
    agentId: start.agent_id,
    spawnToolUseId: pre.tool_use_id,
  };
}

async function recordedPayloads(version = "v2", suffix = "001") {
  const names = version === "v1"
    ? ["pre-tool-use-spawn-v1.json", "post-tool-use-spawn-v1.json", "post-tool-use-wait-v1.json"]
    : ["pre-tool-use-spawn-v2.json", "post-tool-use-spawn-v2.json", "post-tool-use-wait-v2.json"];
  const [pre, postSpawn, wait, start, stop] = await Promise.all([
    ...names.map((name) => fixture(HOOK_FIXTURES, name)),
    fixture(HOOK_FIXTURES, "subagent-start.json"),
    fixture(HOOK_FIXTURES, "subagent-stop.json"),
  ]);
  const sessionId = `session-recorded-${suffix}`;
  const agentId = `agent-recorded-${suffix}`;
  const spawnToolUseId = `call-spawn-${version}-${suffix}`;
  const waitToolUseId = `call-wait-${version}-${suffix}`;
  for (const payload of [pre, postSpawn, wait, start, stop]) {
    payload.session_id = sessionId;
    if (payload.agent_id) payload.agent_id = agentId;
  }
  pre.tool_use_id = spawnToolUseId;
  postSpawn.tool_use_id = spawnToolUseId;
  wait.tool_use_id = waitToolUseId;
  if (version === "v1") {
    postSpawn.tool_response.agent_id = agentId;
    wait.tool_input.targets = [agentId];
    wait.tool_response.status = { [agentId]: { completed: null } };
  } else {
    pre.tool_input.task_name = `codex_trace_${suffix}`;
    postSpawn.tool_input.task_name = pre.tool_input.task_name;
    postSpawn.tool_response.task_name = `/root/${pre.tool_input.task_name}`;
  }
  return { pre, start, postSpawn, stop, wait, sessionId, agentId, spawnToolUseId };
}

async function runHook(payload, root, script = SCRIPT, { workstream = "codex-host-test" } = {}) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const env = { ...process.env, ADVISOR_STATE_DIR: root };
  if (workstream === null) delete env.ADVISOR_WORKSTREAM;
  else env.ADVISOR_WORKSTREAM = workstream;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

function runId(sessionId, ordinal = 1, prefix = "cx") {
  const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `${prefix}-${sessionHash}-${ordinal}`;
}

function resultMarkdown(status = "PASS", { claims = true, statusBody } = {}) {
  return `# Status\n\n${status}${statusBody ? `\n\n${statusBody}` : ""}\n\n${claims ? "# Claims\n\nAC1 maps to direct evidence.\n\n" : ""}# Evidence\n\nThe recorded hook sequence passed.\n\n# Files\n\nOnly the packet surface changed.\n\n# Decisions\n\nAdvisor Core owns settlement.\n\n# Remaining Risk\n\nNo live Codex session was run.\n`;
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "codex-advisor-trace-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function validated(root, id) {
  const path = join(root, "traces", `${id}.jsonl`);
  const text = await readFile(path, "utf8");
  const events = parseTrace(text);
  const result = validateTrace(events, await loadSchema());
  assert.deepEqual(result, { ok: true, problems: [] }, JSON.stringify(result.problems));
  return { path, text, events, projection: projectTrace(events) };
}

async function startRun(root, payloads, ordinal = 1, options) {
  assert.equal((await runHook(payloads.pre, root, SCRIPT, options)).stdout, "");
  const id = runId(payloads.sessionId, ordinal);
  await assert.rejects(access(join(root, "traces", `${id}.jsonl`)), { code: "ENOENT" });
  await assert.rejects(access(join(root, "runs", "codex", id, "result.md")), { code: "ENOENT" });
  const started = await runHook(payloads.start, root, SCRIPT, options);
  const output = JSON.parse(started.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "SubagentStart");
  const match = output.hookSpecificOutput.additionalContext.match(/exactly: (.+)/);
  assert.ok(match?.[1]);
  await validated(root, id);
  return { id, resultPath: match[1], startOutput: output };
}

async function complete(root, payloads, markdown = resultMarkdown(), options) {
  const started = await startRun(root, payloads, 1, options);
  assert.equal((await runHook(payloads.postSpawn, root, SCRIPT, options)).stdout, "");
  await writeFile(started.resultPath, markdown, "utf8");
  assert.equal((await runHook(payloads.stop, root, SCRIPT, options)).stdout, "");
  assert.equal((await runHook(payloads.wait, root, SCRIPT, options)).stdout, "");
  return { ...started, ...(await validated(root, started.id)) };
}

function reducedLifecycle(events) {
  const projection = projectTrace(events);
  return {
    nodes: projection.nodes.map(({ state, settledStatus, resultStatus, resultValid }) => ({
      state,
      settledStatus,
      resultStatus,
      resultValid,
    })),
    wakeCount: projection.wakes.length,
    eventTypes: events.map((event) => event.type).filter((type) => type !== "node.progress"),
  };
}

async function completeClaude(root) {
  const [pre, start, stop, post] = await Promise.all([
    fixture(CLAUDE_FIXTURES, "pre-tool-use-agent.json"),
    fixture(CLAUDE_FIXTURES, "subagent-start.json"),
    fixture(CLAUDE_FIXTURES, "subagent-stop.json"),
    fixture(CLAUDE_FIXTURES, "post-tool-use-agent.json"),
  ]);
  assert.equal((await runHook(pre, root, CLAUDE_SCRIPT, { workstream: "conformance" })).stdout, "");
  const started = await runHook(start, root, CLAUDE_SCRIPT, { workstream: "conformance" });
  const resultPath = JSON.parse(started.stdout).hookSpecificOutput.additionalContext.match(/exactly: (.+)/)?.[1];
  assert.ok(resultPath);
  await writeFile(resultPath, resultMarkdown(), "utf8");
  assert.equal((await runHook(stop, root, CLAUDE_SCRIPT, { workstream: "conformance" })).stdout, "");
  assert.equal((await runHook(post, root, CLAUDE_SCRIPT, { workstream: "conformance" })).stdout, "");
  return validated(root, runId(pre.session_id, 1, "cc"));
}

test("real captured Codex hooks emit one valid done trace and a SubagentStop generation-1 wake", async () => {
  await withRoot(async (root) => {
    const payloads = await capturedPayloads();
    const started = await startRun(root, payloads);
    assert.equal((await runHook(payloads.postSpawn, root)).stdout, "");
    await writeFile(started.resultPath, resultMarkdown(), "utf8");
    assert.equal((await runHook(payloads.stop, root)).stdout, "");
    const { events, projection } = await validated(root, started.id);
    const { startOutput, resultPath } = started;
    assert.match(startOutput.hookSpecificOutput.additionalContext, new RegExp(resultPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(projection.run.host, "codex");
    assert.equal(projection.nodes.length, 1);
    assert.deepEqual(projection.nodes[0], {
      ...projection.nodes[0],
      host: "codex",
      state: "settled",
      settledStatus: "done",
      resultStatus: "PASS",
      resultValid: true,
    });
    assert.equal(projection.wakes.length, 1);
    assert.equal(projection.wakes[0].generation, 1);
    const launch = events.find((event) => event.type === "node.launched");
    assert.deepEqual(launch.data, {
      ...launch.data,
      role: "builder",
      label: "live-trace-proof-3",
      harness: "codex",
      model: "unknown",
      thinking: "unspecified",
      cwd: payloads.pre.cwd,
      riskTier: "low",
      resultPath,
    });
    const launchHash = createHash("sha256").update(payloads.spawnToolUseId).digest("hex").slice(0, 32);
    const mapping = JSON.parse(await readFile(join(
      root,
      "hosts",
      "codex",
      payloads.sessionId,
      "launches",
      launchHash + ".json",
    ), "utf8"));
    assert.equal(mapping.nativeAgentId, payloads.agentId);
    assert.equal(mapping.nickname, "Maxwell");
  });
});

test("real captured hook order preserves spawn identity when PostToolUse precedes SubagentStart", async () => {
  await withRoot(async (root) => {
    const payloads = await capturedPayloads();
    assert.deepEqual(payloads.sequence.map(({ hook_event_name }) => hook_event_name), [
      "PreToolUse",
      "PostToolUse",
      "SubagentStart",
      "SubagentStop",
    ]);
    assert.equal((await runHook(payloads.pre, root)).stdout, "");
    assert.equal((await runHook(payloads.postSpawn, root)).stdout, "");
    const started = await runHook(payloads.start, root);
    const resultPath = JSON.parse(started.stdout).hookSpecificOutput.additionalContext.match(/exactly: (.+)/)?.[1];
    assert.ok(resultPath);
    await writeFile(resultPath, resultMarkdown(), "utf8");
    assert.equal((await runHook(payloads.stop, root)).stdout, "");
    await validated(root, runId(payloads.sessionId));

    const launchHash = createHash("sha256").update(payloads.spawnToolUseId).digest("hex").slice(0, 32);
    const mapping = JSON.parse(await readFile(join(
      root,
      "hosts",
      "codex",
      payloads.sessionId,
      "launches",
      launchHash + ".json",
    ), "utf8"));
    assert.equal(mapping.nativeAgentId, payloads.agentId);
    assert.equal(mapping.nickname, "Maxwell");
  });
});

test("blocked, lenient, blank, and missing artifacts settle as fixed", async () => {
  await withRoot(async (root) => {
    const blocked = await complete(
      root,
      await recordedPayloads("v2", "blocked"),
      resultMarkdown("BLOCKED", { statusBody: "Choose the product storage boundary." }),
    );
    assert.ok(blocked.events.findIndex((event) => event.type === "node.blocked") < blocked.events.findIndex((event) => event.type === "node.result.written"));
    assert.equal(blocked.projection.nodes[0].settledStatus, "blocked");

    const lenient = await complete(
      root,
      await recordedPayloads("v2", "lenient"),
      "Status\nPASS\n",
    );
    assert.equal(lenient.projection.nodes[0].settledStatus, "done");
    assert.equal(lenient.projection.nodes[0].resultStatus, "PASS");
    const validation = lenient.events.find((event) => event.type === "node.result.validated");
    assert.equal(validation.data.valid, true);
    assert.deepEqual(validation.data.problems, [
      "missing Claims",
      "missing Evidence",
      "missing Files",
      "missing Decisions",
      "missing Remaining Risk",
    ]);

    const blankPayloads = await recordedPayloads("v2", "blank");
    const blankStart = await startRun(root, blankPayloads);
    await runHook(blankPayloads.postSpawn, root);
    await runHook(blankPayloads.stop, root);
    const blank = await validated(root, blankStart.id);
    assert.equal(blank.projection.nodes[0].settledStatus, "stalled");

    const missingPayloads = await recordedPayloads("v2", "missing");
    const missingStart = await startRun(root, missingPayloads);
    await runHook(missingPayloads.postSpawn, root);
    await unlink(missingStart.resultPath);
    await runHook(missingPayloads.stop, root);
    const missing = await validated(root, missingStart.id);
    assert.equal(missing.projection.nodes[0].settledStatus, "stalled");
    assert.equal(missing.events.some((event) => event.type === "node.result.written"), false);
  });
});

test("done lifecycle conforms to Pi and a Claude Code trace produced in this test", async () => {
  await withRoot(async (root) => {
    const codex = await complete(join(root, "codex"), await recordedPayloads("v2", "conformance"));
    const claude = await completeClaude(join(root, "claude"));
    const piEvents = parseTrace(await readFile(join(FIXTURES_DIR, "one-worker-done.jsonl"), "utf8"));
    const piValidation = validateTrace(piEvents, await loadSchema());
    assert.deepEqual(piValidation, { ok: true, problems: [] });
    assert.deepEqual(reducedLifecycle(codex.events), reducedLifecycle(piEvents));
    assert.deepEqual(reducedLifecycle(codex.events), reducedLifecycle(claude.events));
  });
});

test("non-maker launches stay untraced, replay and wait are inert, and V1 conforms to V2", async () => {
  await withRoot(async (root) => {
    const other = await recordedPayloads("v2", "other");
    other.pre.tool_input.agent_type = "explorer";
    other.start.agent_type = "explorer";
    other.postSpawn.tool_input.agent_type = "explorer";
    assert.equal((await runHook(other.pre, root)).stdout, "");
    assert.equal((await runHook(other.start, root)).stdout, "");
    assert.equal((await runHook(other.postSpawn, root)).stdout, "");
    await assert.rejects(access(join(root, "traces")), { code: "ENOENT" });
    await assert.rejects(access(join(root, "runs", "codex")), { code: "ENOENT" });

    const replayPayloads = await recordedPayloads("v2", "replay");
    const first = await complete(root, replayPayloads);
    const before = await readFile(first.path, "utf8");
    await runHook(replayPayloads.pre, root);
    assert.match((await runHook(replayPayloads.start, root)).stdout, /SubagentStart/);
    await runHook(replayPayloads.postSpawn, root);
    await runHook(replayPayloads.stop, root);
    await runHook(replayPayloads.wait, root);
    assert.equal(await readFile(first.path, "utf8"), before);
    await validated(root, first.id);

    const v2Payloads = await recordedPayloads("v2", "v2-shape");
    const v2 = await complete(root, v2Payloads);
    const v1 = await complete(root, await recordedPayloads("v1", "v1-shape"));
    assert.deepEqual(reducedLifecycle(v1.events), reducedLifecycle(v2.events));
    const waitBefore = await readFile(v2.path, "utf8");
    await runHook(v2Payloads.wait, root);
    assert.equal(await readFile(v2.path, "utf8"), waitBefore);
  });
});

test("only SubagentStart emits context, malformed stdin is inert, and packet defaults are frozen", async () => {
  await withRoot(async (root) => {
    const payloads = await recordedPayloads("v2", "stdout");
    const started = await startRun(root, payloads);
    assert.match(started.startOutput.hookSpecificOutput.additionalContext, /Status, Claims, Evidence, Files, Decisions, and Remaining Risk/);
    assert.equal((await runHook(payloads.postSpawn, root)).stdout, "");
    await writeFile(started.resultPath, resultMarkdown(), "utf8");
    assert.equal((await runHook(payloads.stop, root)).stdout, "");
    assert.equal((await runHook(payloads.wait, root)).stdout, "");
    await validated(root, started.id);

    const malformedRoot = join(root, "malformed");
    const malformed = await runHook("{not-json", malformedRoot);
    assert.equal(malformed.stdout, "");
    await assert.rejects(access(malformedRoot), { code: "ENOENT" });

    const defaults = await recordedPayloads("v1", "defaults");
    defaults.pre.tool_input.items = [{ type: "text", text: "Execute the bounded maker packet." }];
    delete defaults.pre.tool_input.model;
    delete defaults.pre.tool_input.reasoning_effort;
    delete defaults.postSpawn.tool_input.model;
    delete defaults.postSpawn.tool_input.reasoning_effort;
    const defaultRun = await complete(root, defaults, resultMarkdown(), { workstream: null });
    const launch = defaultRun.events.find((event) => event.type === "node.launched");
    assert.equal(defaultRun.projection.run.workstream, "codex");
    assert.equal(launch.data.riskTier, "high");
    assert.deepEqual(launch.data.acceptance, ["result.md validates with the six required headings"]);
    assert.equal(launch.data.model, "unknown");
    assert.equal(launch.data.thinking, "unspecified");
    assert.equal(launch.data.label, "advisor-maker");
  });
});

test("spawn identity state and concurrent duplicate settlement and delivery stay idempotent", async () => {
  await withRoot(async (root) => {
    const payloads = await recordedPayloads("v2", "concurrent");
    const started = await startRun(root, payloads);
    await runHook(payloads.postSpawn, root);
    const launchHash = createHash("sha256").update(payloads.spawnToolUseId).digest("hex").slice(0, 32);
    const mapping = JSON.parse(await readFile(join(
      root,
      "hosts",
      "codex",
      payloads.sessionId,
      "launches",
      `${launchHash}.json`,
    ), "utf8"));
    assert.equal(mapping.nativeTaskName, `/root/${payloads.pre.tool_input.task_name}`);
    assert.equal(mapping.nickname, "Trace");

    await writeFile(started.resultPath, resultMarkdown(), "utf8");
    await Promise.all([runHook(payloads.stop, root), runHook(payloads.stop, root)]);
    await Promise.all([runHook(payloads.wait, root), runHook(payloads.wait, root)]);
    const trace = await validated(root, started.id);
    const counts = trace.events.reduce((result, event) => {
      result[event.type] = (result[event.type] ?? 0) + 1;
      return result;
    }, {});
    assert.deepEqual(counts, {
      "run.created": 1,
      "node.launched": 1,
      "node.result.written": 1,
      "node.result.validated": 1,
      "node.settled": 1,
      "parent.awakened": 1,
    });
  });
});

test("shipped Codex hooks and advisor-maker TOML satisfy the four-group contract", async () => {
  const hooksPath = fileURLToPath(new URL("../config/advisor-core/hosts/codex/hooks.json", import.meta.url));
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  assert.deepEqual(Object.keys(hooks.hooks), ["PreToolUse", "SubagentStart", "SubagentStop", "PostToolUse"]);
  const groups = Object.entries(hooks.hooks).flatMap(([event, entries]) => entries.map((entry) => ({ event, ...entry })));
  assert.deepEqual(groups.map(({ event, matcher }) => [event, matcher]), [
    ["PreToolUse", "^(spawn_agent|Agent|multi_agent_v1\\.spawn_agent)$"],
    ["SubagentStart", "advisor-maker"],
    ["SubagentStop", "advisor-maker"],
    ["PostToolUse", "^(spawn_agent|Agent|multi_agent_v1\\.spawn_agent)$"],
  ]);
  for (const group of groups) {
    assert.deepEqual(group.hooks, [{ type: "command", command: "node scripts/codex-advisor-trace.mjs" }]);
  }

  const agentPath = fileURLToPath(new URL("../config/advisor-core/hosts/codex/agents/advisor-maker.toml", import.meta.url));
  const python = [
    "import json, pathlib, sys, tomllib",
    "print(json.dumps(tomllib.loads(pathlib.Path(sys.argv[1]).read_text())))",
  ].join("; ");
  const parsed = JSON.parse((await run("python3", ["-c", python, agentPath])).stdout);
  assert.equal(parsed.name, "advisor-maker");
  assert.ok(parsed.description);
  assert.equal(parsed.agents.enabled, false);
  for (const heading of ["Status", "Claims", "Evidence", "Files", "Decisions", "Remaining Risk"]) {
    assert.match(parsed.developer_instructions, new RegExp(`\\b${heading}\\b`));
  }
  const trackedCodexConfig = await run("git", ["ls-files", ".codex"], { cwd: REPO_ROOT });
  assert.equal(trackedCodexConfig.stdout, "");
});

test("protocol documents the Codex binding, limitations, trust, installation, and capabilities", async () => {
  const protocol = await readFile(new URL("../docs/advisor-protocol.md", import.meta.url), "utf8");
  assert.match(protocol, /^## Codex host binding$/m);
  for (const hook of ["PreToolUse", "SubagentStart", "SubagentStop", "PostToolUse"]) {
    assert.match(protocol, new RegExp("`" + hook + "`"));
  }
  for (const matcher of [
    "^(spawn_agent|Agent|multi_agent_v1\\.spawn_agent)$",
    "advisor-maker",
  ]) assert.ok(protocol.includes(matcher), `protocol lacks matcher ${matcher}`);
  for (const phrase of [
    "cx-<first 16 hex of sha256(session_id)>-<launch ordinal>",
    "lazy",
    "exactly four hook groups",
    "JSON string response",
    "parent.awakened",
    "wait_agent",
    "remains unsettled",
    "node.progress",
    "/hooks",
    "project trust",
    "notify",
  ]) assert.match(protocol, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.equal(protocol.includes("^(wait_agent|multi_agent_v1\\.wait_agent)$"), false);
  for (const capability of [
    "backgroundWorkers: true",
    "visibleWorkers: partial",
    "independentControl: partial",
    "interactiveBlockedState: partial",
    "durableResults: partial",
    "restartRecovery: partial",
    "nestedDelegation: true",
  ]) assert.match(protocol, new RegExp(capability));
  assert.match(protocol, /\| 5\. Codex host adapter with the same conformance tests \| done \|/);

  const runtime = await readFile(new URL("../docs/advisor-runtime.md", import.meta.url), "utf8");
  assert.match(runtime, /\[Codex host binding\]\(advisor-protocol\.md#codex-host-binding\)/);
});
