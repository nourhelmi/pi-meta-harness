import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIXTURES_DIR,
  loadSchema,
  parseTrace,
  projectTrace,
  validateTrace,
} from "../scripts/advisor-trace.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/claude-advisor-trace.mjs", import.meta.url));
const HOOK_FIXTURES = fileURLToPath(new URL("./fixtures/claude-code-hooks", import.meta.url));

async function fixture(name) {
  return JSON.parse(await readFile(join(HOOK_FIXTURES, name), "utf8"));
}

async function recordedPayloads(suffix = "001") {
  const [pre, start, stop, post, failure] = await Promise.all([
    fixture("pre-tool-use-agent.json"),
    fixture("subagent-start.json"),
    fixture("subagent-stop.json"),
    fixture("post-tool-use-agent.json"),
    fixture("post-tool-use-failure-agent.json"),
  ]);
  const sessionId = `session-recorded-${suffix}`;
  const agentId = `agent-recorded-${suffix}`;
  const toolUseId = `toolu_recorded_${suffix}`;
  for (const payload of [pre, start, stop, post, failure]) {
    payload.session_id = sessionId;
    payload.tool_use_id = payload.tool_use_id ? toolUseId : undefined;
    if (payload.agent_id) payload.agent_id = agentId;
    if (payload.tool_response?.agentId) payload.tool_response.agentId = agentId;
  }
  return { pre, start, stop, post, failure, sessionId, agentId, toolUseId };
}

async function runHook(payload, root) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, ADVISOR_STATE_DIR: root, ADVISOR_WORKSTREAM: "claude-host-test" },
      stdio: ["pipe", "pipe", "pipe"],
    });
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

function runId(sessionId, ordinal = 1) {
  const prefix = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `cc-${prefix}-${ordinal}`;
}

function resultMarkdown(status = "PASS", { claims = true, statusBody } = {}) {
  return `# Status\n\n${status}${statusBody ? `\n\n${statusBody}` : ""}\n\n${claims ? "# Claims\n\nAC1 maps to direct evidence.\n\n" : ""}# Evidence\n\nThe recorded hook sequence passed.\n\n# Files\n\nOnly the packet surface changed.\n\n# Decisions\n\nAdvisor Core owns settlement.\n\n# Remaining Risk\n\nNo live Claude session was run.\n`;
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "claude-advisor-trace-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function startRun(root, payloads, ordinal = 1) {
  const preOutput = await runHook(payloads.pre, root);
  assert.equal(preOutput.stdout, "");
  const id = runId(payloads.sessionId, ordinal);
  await assert.rejects(access(join(root, "traces", `${id}.jsonl`)), { code: "ENOENT" });
  const started = await runHook(payloads.start, root);
  const output = JSON.parse(started.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "SubagentStart");
  const match = output.hookSpecificOutput.additionalContext.match(/exactly: (.+)/);
  assert.ok(match?.[1]);
  return { id, resultPath: match[1], startOutput: output };
}

async function validated(root, id) {
  const path = join(root, "traces", `${id}.jsonl`);
  const text = await readFile(path, "utf8");
  const events = parseTrace(text);
  const result = validateTrace(events, await loadSchema());
  assert.deepEqual(result, { ok: true, problems: [] }, JSON.stringify(result.problems));
  return { path, text, events, projection: projectTrace(events) };
}

async function complete(root, payloads, markdown = resultMarkdown()) {
  const started = await startRun(root, payloads);
  await writeFile(started.resultPath, markdown, "utf8");
  const stopped = await runHook(payloads.stop, root);
  const posted = await runHook(payloads.post, root);
  assert.equal(stopped.stdout, "");
  assert.equal(posted.stdout, "");
  return { ...started, ...(await validated(root, started.id)) };
}

function conformanceProjection(events) {
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

test("recorded foreground hook payloads emit one valid done trace and generation-1 wake", async () => {
  await withRoot(async (root) => {
    const payloads = await recordedPayloads("done");
    const { events, projection, startOutput, resultPath } = await complete(root, payloads);
    assert.match(startOutput.hookSpecificOutput.additionalContext, new RegExp(resultPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(projection.run.host, "claude-code");
    assert.equal(projection.nodes.length, 1);
    assert.equal(projection.nodes[0].host, "claude-code");
    assert.equal(projection.nodes[0].resultValid, true);
    assert.deepEqual(projection.nodes[0], {
      ...projection.nodes[0],
      state: "settled",
      settledStatus: "done",
      resultStatus: "PASS",
    });
    assert.equal(projection.wakes.length, 1);
    assert.equal(projection.wakes[0].generation, 1);
    const launch = events.find((event) => event.type === "node.launched");
    assert.deepEqual(launch.data, {
      ...launch.data,
      role: "builder",
      label: "Emit canonical advisor trace",
      harness: "claude-code",
      model: "claude-sonnet-4-5",
      thinking: "unspecified",
      cwd: "/Users/example/Dev/example-repo",
      riskTier: "standard",
      acceptance: ["The result artifact validates.", "The parent receives one wake."],
      resultPath,
    });
  });
});

test("blocked, lenient, blank, missing, and Agent failure settlements all validate", async () => {
  await withRoot(async (root) => {
    const blockedPayloads = await recordedPayloads("blocked");
    const blocked = await complete(
      root,
      blockedPayloads,
      resultMarkdown("BLOCKED", { statusBody: "Choose the product storage boundary." }),
    );
    assert.ok(blocked.events.findIndex((event) => event.type === "node.blocked") < blocked.events.findIndex((event) => event.type === "node.result.written"));
    assert.equal(blocked.projection.nodes[0].settledStatus, "blocked");

    const lenientPayloads = await recordedPayloads("lenient");
    const lenient = await complete(root, lenientPayloads, "Status\nPASS\n");
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

    const blankPayloads = await recordedPayloads("blank");
    const blank = await complete(root, blankPayloads, "");
    assert.equal(blank.projection.nodes[0].settledStatus, "stalled");

    const missingPayloads = await recordedPayloads("missing");
    const missingStart = await startRun(root, missingPayloads);
    await unlink(missingStart.resultPath);
    assert.equal((await runHook(missingPayloads.stop, root)).stdout, "");
    assert.equal((await runHook(missingPayloads.post, root)).stdout, "");
    const missing = await validated(root, missingStart.id);
    assert.equal(missing.projection.nodes[0].settledStatus, "stalled");
    assert.equal(missing.events.some((event) => event.type === "node.result.written"), false);

    const failurePayloads = await recordedPayloads("failure");
    const failureStart = await startRun(root, failurePayloads);
    // Agent failure replaces the successful SubagentStop/PostToolUse path. Per
    // fixed decision 3, it settles failed only while the child is unsettled.
    assert.equal((await runHook(failurePayloads.failure, root)).stdout, "");
    const failure = await validated(root, failureStart.id);
    assert.equal(failure.projection.nodes[0].settledStatus, "failed");
    assert.equal(failure.projection.wakes.length, 1);
    assert.equal(failure.projection.wakes[0].generation, 1);
  });
});

test("Agent failure does not override a settlement already emitted by SubagentStop", async () => {
  await withRoot(async (root) => {
    const payloads = await recordedPayloads("failure-after-stop");
    const started = await startRun(root, payloads);
    await writeFile(started.resultPath, resultMarkdown(), "utf8");
    await runHook(payloads.stop, root);
    await runHook(payloads.failure, root);
    const trace = await validated(root, started.id);
    assert.equal(trace.projection.nodes[0].settledStatus, "done");
    assert.equal(trace.projection.wakes[0].childStatus, "done");
  });
});

test("a PostToolUse agent-id mismatch is noted outside the canonical trace", async () => {
  await withRoot(async (root) => {
    const payloads = await recordedPayloads("mismatch");
    const started = await startRun(root, payloads);
    await writeFile(started.resultPath, resultMarkdown(), "utf8");
    await runHook(payloads.stop, root);
    payloads.post.tool_response.agentId = "different-agent-id";
    await runHook(payloads.post, root);
    const trace = await validated(root, started.id);
    assert.equal(trace.projection.wakes.length, 1);
    assert.equal(trace.events.some((event) => JSON.stringify(event).includes("different-agent-id")), false);
    const note = JSON.parse(await readFile(join(root, "runs", "claude-code", started.id, "agent-id-mismatch.json"), "utf8"));
    assert.equal(note.expectedAgentId, payloads.agentId);
    assert.equal(note.responseAgentId, "different-agent-id");
  });
});

test("done lifecycle conforms to the Pi fixture with progress removed", async () => {
  await withRoot(async (root) => {
    const claude = await complete(root, await recordedPayloads("conformance"));
    const pi = parseTrace(await readFile(join(FIXTURES_DIR, "one-worker-done.jsonl"), "utf8"));
    assert.deepEqual(conformanceProjection(claude.events), conformanceProjection(pi));
  });
});

test("non-maker sessions stay untraced and full replay appends nothing", async () => {
  await withRoot(async (root) => {
    const other = await recordedPayloads("other");
    other.pre.tool_input.subagent_type = "Explore";
    other.start.agent_type = "Explore";
    other.post.tool_input.subagent_type = "Explore";
    assert.equal((await runHook(other.pre, root)).stdout, "");
    assert.equal((await runHook(other.start, root)).stdout, "");
    assert.equal((await runHook(other.post, root)).stdout, "");
    await assert.rejects(access(join(root, "traces")), { code: "ENOENT" });
    await assert.rejects(access(join(root, "runs", "claude-code")), { code: "ENOENT" });

    const payloads = await recordedPayloads("replay");
    const first = await complete(root, payloads);
    const before = await readFile(first.path, "utf8");
    assert.equal((await runHook(payloads.pre, root)).stdout, "");
    assert.match((await runHook(payloads.start, root)).stdout, /SubagentStart/);
    assert.equal((await runHook(payloads.stop, root)).stdout, "");
    assert.equal((await runHook(payloads.post, root)).stdout, "");
    assert.equal(await readFile(first.path, "utf8"), before);
  });
});

test("a second maker gets a new ordinal and packet fields use their frozen defaults", async () => {
  await withRoot(async (root) => {
    const firstPayloads = await recordedPayloads("ordinal");
    await complete(root, firstPayloads);

    const secondPayloads = await recordedPayloads("ordinal-second");
    for (const payload of Object.values(secondPayloads)) {
      if (payload && typeof payload === "object") payload.session_id = firstPayloads.sessionId;
    }
    secondPayloads.sessionId = firstPayloads.sessionId;
    secondPayloads.pre.tool_input.prompt = "Execute the bounded maker packet.";
    secondPayloads.pre.tool_input.description = "Second maker";
    delete secondPayloads.pre.tool_input.model;
    const started = await startRun(root, secondPayloads, 2);
    assert.equal(started.id, runId(firstPayloads.sessionId, 2));
    const second = await validated(root, started.id);
    const launch = second.events.find((event) => event.type === "node.launched");
    assert.equal(launch.data.riskTier, "high");
    assert.deepEqual(launch.data.acceptance, ["result.md validates with the six required headings"]);
    assert.equal(launch.data.model, "unknown");
    assert.equal(launch.data.label, "Second maker");
    assert.equal(second.projection.run.workstream, "claude-host-test");
  });
});

test("concurrent duplicate settlement and wake payloads append once under the locks", async () => {
  await withRoot(async (root) => {
    const payloads = await recordedPayloads("concurrent");
    const started = await startRun(root, payloads);
    await writeFile(started.resultPath, resultMarkdown(), "utf8");
    await Promise.all([runHook(payloads.stop, root), runHook(payloads.stop, root)]);
    await Promise.all([runHook(payloads.post, root), runHook(payloads.post, root)]);
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

test("only SubagentStart emits context; malformed stdin exits zero and writes nothing", async () => {
  await withRoot(async (root) => {
    const payloads = await recordedPayloads("stdout");
    const started = await startRun(root, payloads);
    assert.match(started.startOutput.hookSpecificOutput.additionalContext, /Status, Claims, Evidence, Files, Decisions, and Remaining Risk/);
    assert.equal((await runHook(payloads.stop, root)).stdout, "");
    assert.equal((await runHook(payloads.post, root)).stdout, "");
    assert.equal((await runHook(payloads.failure, root)).stdout, "");
    await validated(root, started.id);

    const malformedRoot = join(root, "malformed");
    const malformed = await runHook("{not-json", malformedRoot);
    assert.equal(malformed.stdout, "");
    await assert.rejects(access(malformedRoot), { code: "ENOENT" });
  });
});

test("shipped Claude Code hooks and advisor-maker definition satisfy the contract", async () => {
  const hooksPath = new URL("../config/advisor-core/hosts/claude-code/hooks.json", import.meta.url);
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  assert.deepEqual(hooks.env, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
  const expected = {
    PreToolUse: "Agent",
    SubagentStart: "advisor-maker",
    SubagentStop: "advisor-maker",
    PostToolUse: "Agent",
    PostToolUseFailure: "Agent",
  };
  assert.deepEqual(Object.keys(hooks.hooks), Object.keys(expected));
  for (const [event, matcher] of Object.entries(expected)) {
    assert.equal(hooks.hooks[event].length, 1);
    assert.equal(hooks.hooks[event][0].matcher, matcher);
    assert.deepEqual(hooks.hooks[event][0].hooks, [{
      type: "command",
      command: "node scripts/claude-advisor-trace.mjs",
    }]);
  }

  const agent = await readFile(new URL("../config/advisor-core/hosts/claude-code/agents/advisor-maker.md", import.meta.url), "utf8");
  assert.match(agent, /^---\nname: advisor-maker\n/);
  const body = agent.replace(/^---\n[\s\S]*?\n---\n/, "");
  for (const heading of ["Status", "Claims", "Evidence", "Files", "Decisions", "Remaining Risk"]) {
    assert.match(body, new RegExp(`\\b${heading}\\b`));
  }
  assert.match(agent, /background: false/);
  assert.match(agent, /does not force foreground execution/);
  assert.match(agent, /CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1.*required/s);
  assert.match(agent, /disallowedTools: Agent/);
});

test("protocol documents the Claude Code binding and marks migration step 4 done", async () => {
  const protocol = await readFile(new URL("../docs/advisor-protocol.md", import.meta.url), "utf8");
  assert.match(protocol, /^## Claude Code host binding$/m);
  for (const hook of ["PreToolUse", "SubagentStart", "SubagentStop", "PostToolUse", "PostToolUseFailure"]) {
    assert.match(protocol, new RegExp("`" + hook + "`"));
  }
  assert.match(protocol, /CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1[\s\S]*required/);
  assert.match(protocol, /background: false[\s\S]*does not force foreground execution/);
  for (const capability of [
    "backgroundWorkers: true",
    "visibleWorkers: partial",
    "independentControl: partial",
    "interactiveBlockedState: partial",
    "durableResults: partial",
    "restartRecovery: partial",
    "nestedDelegation: true",
  ]) {
    assert.match(protocol, new RegExp(capability));
  }
  assert.match(protocol, /\| 4\. Claude Code host adapter, one maker only \| done \|/);

  const runtime = await readFile(new URL("../docs/advisor-runtime.md", import.meta.url), "utf8");
  assert.match(runtime, /\[Claude Code host binding\]\(advisor-protocol\.md#claude-code-host-binding\)/);
});
