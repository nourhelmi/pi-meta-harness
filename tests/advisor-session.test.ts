import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorSessionExtension, {
  advisorActiveTools,
  renderIntelligenceGuide,
  workstreamHotSection,
} from "../extensions/advisor-session.ts";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface AdvisorLaunchTool {
  name: string;
  execute(
    toolCallId: string,
    params: { cwd: string; workstream?: string; workerHarness?: "pi" | "native"; purpose?: string; prompt?: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<{ details: { tabId: string; paneId: string; label: string; cwd: string; workstream?: string; workerHarness?: "pi" | "native" } }>;
}

interface AdvisorInitTool {
  name: string;
  execute(
    toolCallId: string,
    params: { workstream?: string; workerHarness?: "pi" | "native" },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: { workstream: string; workerHarness: "pi" | "native"; stateRoot: string };
  }>;
}

function installedAdvisorLaunch(respond: (args: string[]) => ExecResult) {
  let tool: AdvisorLaunchTool | undefined;
  const calls: string[][] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      return respond(args);
    },
    on: () => undefined,
    registerTool: (candidate: AdvisorLaunchTool) => {
      if (candidate.name === "advisor_launch") tool = candidate;
    },
  } as unknown as ExtensionAPI;
  advisorSessionExtension(pi);
  assert.ok(tool, "advisor_launch is registered");
  return { calls, tool };
}

function installedAdvisorInit() {
  let tool: AdvisorInitTool | undefined;
  let sessionName: string | undefined;
  const entries: Array<{ customType: string; data: unknown }> = [];
  const calls: string[][] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    },
    getSessionName: () => sessionName,
    on: () => undefined,
    registerTool: (candidate: AdvisorInitTool) => {
      if (candidate.name === "advisor_session_init") tool = candidate;
    },
    setSessionName: (value: string) => {
      sessionName = value;
    },
  } as unknown as ExtensionAPI;
  advisorSessionExtension(pi);
  assert.ok(tool, "advisor_session_init is registered");
  return { calls, entries, getSessionName: () => sessionName, tool };
}


interface SessionStartEvent {
  reason: "resume";
}

interface BeforeAgentStartEvent {
  systemPrompt: string;
}

interface SessionCompactEvent {
  reason: "manual" | "threshold" | "overflow";
}

interface ToolCallEvent {
  toolName: string;
  input: unknown;
}

function installedAdvisorResumeRuntime(branch: unknown[]) {
  let sessionStart: ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>) | undefined;
  let beforeAgentStart:
    | ((event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<{ systemPrompt: string } | undefined>)
    | undefined;
  let sessionCompact: ((event: SessionCompactEvent, ctx: ExtensionContext) => void) | undefined;
  let toolCall: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<{ block: boolean; reason: string } | undefined>) | undefined;
  let sessionName: string | undefined;
  const pi = {
    getFlag: () => undefined,
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    getSessionName: () => sessionName,
    setSessionName: (value: string) => {
      sessionName = value;
    },
    on: (name: string, handler: unknown) => {
      if (name === "session_start") {
        sessionStart = handler as (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
      }
      if (name === "before_agent_start") {
        beforeAgentStart = handler as (
          event: BeforeAgentStartEvent,
          ctx: ExtensionContext,
        ) => Promise<{ systemPrompt: string } | undefined>;
      }
      if (name === "session_compact") {
        sessionCompact = handler as (event: SessionCompactEvent, ctx: ExtensionContext) => void;
      }
      if (name === "tool_call") {
        toolCall = handler as NonNullable<typeof toolCall>;
      }
    },
    registerTool: () => undefined,
  } as unknown as ExtensionAPI;
  advisorSessionExtension(pi);
  assert.ok(sessionStart, "session_start handler is registered");
  assert.ok(beforeAgentStart, "before_agent_start handler is registered");
  assert.ok(toolCall, "tool_call handler is registered");
  assert.ok(sessionCompact, "session_compact handler is registered");
  const ctx = {
    cwd: process.cwd(),
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "session-12345678",
    },
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;
  return { beforeAgentStart, ctx, sessionCompact, sessionStart, toolCall: (event: ToolCallEvent) => toolCall!(event, ctx) };
}

const REFERENCE_NAMES = ["graphs", "model-routing", "evidence", "transport-and-settlement"];
async function advisorDoctrine(): Promise<string> {
  const core = await readFile(new URL("../skills/advisor/doctrine.md", import.meta.url), "utf8");
  const references = await Promise.all(
    REFERENCE_NAMES.map((name) => readFile(new URL(`../skills/advisor/references/${name}.md`, import.meta.url), "utf8")),
  );
  return [core, ...references].join("\n\n");
}

test("advisor doctrine routes locked execution without weakening decision boundaries", async () => {
  const source = await advisorDoctrine();
  assert.match(source, /decision load and risk/);
  assert.match(source, /locked execution packet/);
  assert.match(source, /stop and report evidence rather\s+than invent or change a material product/);
  assert.match(source, /Assign task-shaped readiness to the maker or browser verifier and reuse current\s+proof/);
  assert.match(source, /missing safe target, credential or authority is a real\s+stop/);
  assert.match(source, /check `bg_list`\s+once/);
  assert.match(source, /Coalesce a\s+routine settlement/);
  assert.match(source, /## Child advisors/);
  assert.match(source, /pass only real user, authority, ownership and safety constraints/);
  assert.match(source, /no graph, delegation depth, role sequence or launch quota is\s+required/);
  assert.match(source, /Managed advisors are Pi-hosted, including in native specialist mode/);
  assert.match(source, /Arrange required independent checking of the integrated outcome/);
  assert.match(source, /Deliberate criteria\s+revision[\s\S]+new packet\s+revision/);
  assert.match(source, /criteria serve the advisor's\s+judgment, not the reverse/);
  assert.match(source, /## Worker transport recovery/);
  assert.match(source, /make at most one\s+changed retry, not an identical new launch/);
  assert.match(source, /perform the cohesive work directly only when ownership and authority are clear/);
  assert.match(source, /required independent review remains unsatisfied until actually obtained/);
  assert.match(source, /explicit acceptance requirement for a particular transport or worker stays\s+unsatisfied if bypassed by direct work/);
});

test("advisor mode entrypoints select their worker harness and defer to the injected doctrine", async () => {
  const native = await readFile(new URL("../skills/advisor-native/SKILL.md", import.meta.url), "utf8");
  const pi = await readFile(new URL("../skills/advisor-pi/SKILL.md", import.meta.url), "utf8");
  const entry = await readFile(new URL("../skills/advisor/SKILL.md", import.meta.url), "utf8");

  assert.match(native, /advisor_session_init[\s\S]+workerHarness[^\n]+native/i);
  assert.match(native, /do not read `\.\.\/advisor\/doctrine\.md` or\s+`advisor-intelligence\.json` with a tool/);
  assert.match(native, /every `bg_agent` launch[\s\S]+explicit `model` and `thinking`/);
  assert.match(pi, /advisor_session_init[\s\S]+workerHarness[^\n]+pi/i);
  assert.match(pi, /do not read `\.\.\/advisor\/doctrine\.md` or\s+`advisor-intelligence\.json` with a tool/);
  assert.match(pi, /every `bg_agent` launch[\s\S]+explicit `model` and `thinking`/);
  assert.match(entry, /Do not read the doctrine or the guide with a tool/);
  for (const skill of [native, pi, entry]) {
    assert.doesNotMatch(skill, /load it completely|Do not call\s+`bg_agent` until/);
  }
});


test("resumed advisors receive current doctrine over stale expanded skill history", async t => {
  const dir = await mkdtemp(join(tmpdir(), "advisor-resume-valid-"));
  const previous = process.env.ADVISOR_STATE_DIR; process.env.ADVISOR_STATE_DIR = dir;
  t.after(async () => { if (previous === undefined) delete process.env.ADVISOR_STATE_DIR; else process.env.ADVISOR_STATE_DIR = previous; await rm(dir, { recursive: true, force: true }); });
  await mkdir(join(dir, "workstreams"));
  await writeFile(join(dir, "workstreams/document-review.md"), "# Workstream: document-review\n- Owner session: `session-12345678`\n## Current state\nReview.");
  const staleSkill = `<skill name="advisor" location="/old/skills/advisor/SKILL.md">
References are relative to /old/skills/advisor.

# Advisor

Model character notes are binding. Fable takes no checker role.
</skill>

Review the current document.`;
  const branch = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: staleSkill }] },
    },
    {
      type: "custom",
      customType: "advisor-session",
      data: {
        workstream: "document-review",
        sessionId: "session-12345678",
        initializedAt: "2026-01-01T00:00:00.000Z",
        workerHarness: "native",
      },
    },
  ];
  const { beforeAgentStart, ctx, sessionStart, toolCall } = installedAdvisorResumeRuntime(branch);

  await sessionStart({ reason: "resume" }, ctx);
  const result = await beforeAgentStart({ systemPrompt: "base prompt" }, ctx);

  assert.ok(result);
  assert.match(result.systemPrompt, /^base prompt\n\n# Current Advisor Doctrine/);
  assert.match(result.systemPrompt, /\*\*Blocked\*\* means exactly one of four things/);
  assert.match(result.systemPrompt, /\*\*Direct\.\*\* You implement and verify with the same maker duties\.\s+First-class at every risk tier/);
  assert.match(result.systemPrompt, /Session mode: \*\*native\*\*/);
  assert.match(result.systemPrompt, /OpenAI models route to Codex CLI/);
  assert.doesNotMatch(result.systemPrompt, /Model character notes are binding/);
  assert.deepEqual(
    await toolCall({
      toolName: "bg_agent",
      input: { role: "builder", acceptance: ["tests pass"], prompt: "Implement this: [paste #1 +12 lines]" },
    }),
    {
      block: true,
      reason:
        "The prompt contains an unexpanded paste placeholder such as [paste #1 +12 lines]; include the pasted content in the prompt or reference it by path.",
    },
  );
  assert.deepEqual(
    await toolCall({
      toolName: "bg_agent",
      input: { role: "scout", anchor: "findings are source-linked", harness: "pi" },
    }),
    {
      block: true,
      reason: "Advisor session worker harness is native; per-launch pi is not allowed.",
    },
  );
  assert.deepEqual(
    await toolCall({
      toolName: "bg_agent",
      input: { agent: "claude", anchor: "plan is evidence-backed" },
    }),
    {
      block: true,
      reason:
        "Advisor session mode is native. Do not pass bg_agent.agent. To use Claude Code directly, " +
        "launch a configured semantic role with an explicit claude-bridge/* or anthropic/* model and " +
        "thinking level; bg_agent routes that role to Claude Code and preserves its managed result " +
        "artifact. Freeform workers remain Pi-hosted.",
    },
  );
  assert.equal(
    await toolCall({
      toolName: "bg_agent",
      input: { anchor: "summary cites exact file paths", label: "freeform aide" },
    }),
    undefined,
  );
  assert.equal(
    await toolCall({
      toolName: "bg_agent",
      input: {
        role: "builder",
        acceptance: ["focused suites pass", "diff stays inside packages/api"],
        label: "criteria builder",
      },
    }),
    undefined,
  );
  assert.deepEqual(
    await toolCall({
      toolName: "bg_agent",
      input: { label: "freeform aide" },
    }),
    {
      block: true,
      reason: "New advisor workers require at least one concrete acceptance criterion (acceptance[] or anchor).",
    },
  );
});

test("advisor sessions inject the doctrine once with the live guide and re-send the hot section after compaction", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "advisor-inject-state-"));
  const agentDir = await mkdtemp(join(tmpdir(), "advisor-inject-agent-"));
  const previous = {
    advisorStateDir: process.env.ADVISOR_STATE_DIR,
    agentDir: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.ADVISOR_STATE_DIR = stateDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const branch = [
    {
      type: "custom",
      customType: "advisor-session",
      data: {
        workstream: "document-review",
        sessionId: "session-12345678",
        initializedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  ];

  try {
    await mkdir(join(stateDir, "workstreams"), { recursive: true });
    await writeFile(
      join(stateDir, "workstreams", "document-review.md"),
      "# Workstream: document-review\n\n- Owner session: `session-12345678`\n\n## Goal\n\nReview the document.\n\n## Current state\nReviewing.\n\n## Next\n\nLaunch the reviewer.\n\n## Log\n\n- D1: an old decision that must not be re-sent\n",
      "utf8",
    );
    await writeFile(
      join(agentDir, "advisor-intelligence.json"),
      JSON.stringify({
        name: "test-guide",
        models: { "openai-codex/gpt-6-astra": { character: "Advisory: test character.", defaultThinking: "high" } },
        recommendations: { builder: [{ model: "openai-codex/gpt-6-astra", thinking: "high", fit: "Preferred." }] },
      }),
      "utf8",
    );
    const { beforeAgentStart, ctx, sessionCompact, sessionStart } = installedAdvisorResumeRuntime(branch);

    await sessionStart({ reason: "resume" }, ctx);
    const first = await beforeAgentStart({ systemPrompt: "base prompt" }, ctx);
    assert.ok(first);
    assert.equal(first.systemPrompt.match(/# Current Advisor Doctrine/g)?.length, 1);
    assert.match(first.systemPrompt, /# Active Intelligence Guide\n\nProfile: test-guide/);
    assert.match(first.systemPrompt, /- builder: openai-codex\/gpt-6-astra high \(Preferred\.\)/);
    assert.match(first.systemPrompt, /Session mode: \*\*pi\*\*/);
    assert.match(first.systemPrompt, /# Workstream Hot Section[\s\S]*Review the document\.[\s\S]*Launch the reviewer\./);
    assert.doesNotMatch(first.systemPrompt, /an old decision that must not be re-sent/);

    const second = await beforeAgentStart({ systemPrompt: "base prompt" }, ctx);
    assert.ok(second);
    assert.doesNotMatch(second.systemPrompt, /# Workstream Hot Section/);
    assert.match(second.systemPrompt, /# Current Advisor Doctrine/);

    sessionCompact({ reason: "threshold" }, ctx);
    const third = await beforeAgentStart({ systemPrompt: "base prompt" }, ctx);
    assert.ok(third);
    assert.match(third.systemPrompt, /# Workstream Hot Section[\s\S]*Review the document\./);
  } finally {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("ADVISOR_STATE_DIR", previous.advisorStateDir);
    restore("PI_CODING_AGENT_DIR", previous.agentDir);
    await rm(stateDir, { force: true, recursive: true });
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("advisor prompt helpers bound the hot section, render the guide, and trim the tool set", () => {
  const longLog = Array.from({ length: 120 }, (_, index) => `- entry ${index}`).join("\n");
  const bounded = workstreamHotSection(`# Workstream: x\n\n## Goal\n\nShip.\n\n${longLog}`);
  assert.match(bounded, /hot section truncated at 80 lines/);
  assert.equal(workstreamHotSection("# Workstream: x\n\n## Goal\n\nShip.\n\n## Log\n\n- history"), "# Workstream: x\n\n## Goal\n\nShip.");
  assert.equal(renderIntelligenceGuide("not json"), undefined);
  assert.match(renderIntelligenceGuide(JSON.stringify({ name: "g", recommendations: { scout: [{ model: "m", thinking: "low" }] } })) ?? "", /- scout: m low$/);
  assert.deepEqual(
    advisorActiveTools(["read", "mem_context", "RoutineCreate", "bg_agent", "mem_search", "goal_wait", "mem_save", "edit"]),
    ["read", "bg_agent", "mem_search", "mem_save", "edit"],
  );
});

test("resumed native advisors restore the repository-scoped result root", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "advisor-resume-root-"));
  const previous = {
    advisorStateDir: process.env.ADVISOR_STATE_DIR,
    advisorStateRoot: process.env.ADVISOR_STATE_ROOT,
    advisorWorkstream: process.env.ADVISOR_WORKSTREAM,
    workerHarness: process.env.PI_DETACH_WORKER_HARNESS,
  };
  process.env.ADVISOR_STATE_DIR = stateDir;
  process.env.ADVISOR_STATE_ROOT = "/tmp/stale-advisor-root";
  const branch = [
    {
      type: "custom",
      customType: "advisor-session",
      data: {
        workstream: "native-resume",
        sessionId: "session-12345678",
        initializedAt: "2026-01-01T00:00:00.000Z",
        workerHarness: "native",
      },
    },
  ];

  try {
    const { ctx, sessionStart } = installedAdvisorResumeRuntime(branch);
    await sessionStart({ reason: "resume" }, ctx);
    assert.equal(process.env.ADVISOR_STATE_ROOT, stateDir);
    assert.equal(process.env.ADVISOR_WORKSTREAM, "native-resume");
    assert.equal(process.env.PI_DETACH_WORKER_HARNESS, "native");
  } finally {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("ADVISOR_STATE_DIR", previous.advisorStateDir);
    restore("ADVISOR_STATE_ROOT", previous.advisorStateRoot);
    restore("ADVISOR_WORKSTREAM", previous.advisorWorkstream);
    restore("PI_DETACH_WORKER_HARNESS", previous.workerHarness);
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function withHerdrEnvironment<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  }
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

test("advisor_session_init asks once and persists native worker mode", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "advisor-native-mode-"));
  const previous = {
    advisorStateDir: process.env.ADVISOR_STATE_DIR,
    advisorStateRoot: process.env.ADVISOR_STATE_ROOT,
    advisorWorkstream: process.env.ADVISOR_WORKSTREAM,
    herdrEnvironment: process.env.HERDR_ENV,
    herdrPaneId: process.env.HERDR_PANE_ID,
    workerHarness: process.env.PI_DETACH_WORKER_HARNESS,
  };
  process.env.ADVISOR_STATE_DIR = stateDir;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";

  try {
    const { calls, entries, getSessionName, tool } = installedAdvisorInit();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "session-native-12345678",
      },
      ui: {
        notify: () => undefined,
        select: async () => "Native harnesses (Codex / Claude Code)",
      },
    } as unknown as ExtensionContext;

    const result = await tool.execute(
      "test-call",
      { workstream: "Native Routing" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.workstream, "native-routing");
    assert.equal(result.details.workerHarness, "native");
    assert.equal(result.details.stateRoot, stateDir);
    assert.match(result.content[0]?.text ?? "", /doctrine core and the active intelligence guide are in your system prompt/);
    assert.match(result.content[0]?.text ?? "", /skills\/advisor\/references/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /Required next actions|read .* completely/);
    assert.match(result.content[0]?.text ?? "", /## Workstream hot section[\s\S]*## Scope ledger/);
    const checkpoint = await readFile(join(stateDir, "workstreams/native-routing.md"), "utf8");
    assert.match(checkpoint, /Record material scope decisions and why/);
    assert.match(checkpoint, /maker owns remaining diagnosis, implementation and verification/);
    assert.doesNotMatch(checkpoint, /Fill after diagnosis|minimal fix|literal-reading surface/);
    assert.match(result.content[0]?.text ?? "", /Every bg_agent launch must include an explicit model and thinking level/);
    assert.match(result.content[0]?.text ?? "", /OpenAI models route to Codex CLI/);
    assert.equal(process.env.PI_DETACH_WORKER_HARNESS, "native");
    assert.equal(getSessionName(), "advisor-native-routing");
    assert.deepEqual(calls, [
      ["agent", "get", "w1:p1"],
      ["agent", "rename", "w1:p1", "advisor-native-routing"],
      ["pane", "rename", "w1:p1", "advisor · native routing"],
    ]);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      customType: "advisor-session",
      data: {
        initializedAt: (entries[0]?.data as { initializedAt: string }).initializedAt,
        sessionId: "session-native-12345678",
        workerHarness: "native",
        workstream: "native-routing",
      },
    });
  } finally {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("ADVISOR_STATE_DIR", previous.advisorStateDir);
    restore("ADVISOR_STATE_ROOT", previous.advisorStateRoot);
    restore("ADVISOR_WORKSTREAM", previous.advisorWorkstream);
    restore("HERDR_ENV", previous.herdrEnvironment);
    restore("HERDR_PANE_ID", previous.herdrPaneId);
    restore("PI_DETACH_WORKER_HARNESS", previous.workerHarness);
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("advisor_launch creates an unfocused tab and sends the advisor bootstrap", async () => {
  const { calls, tool } = installedAdvisorLaunch((args) => {
    if (args[0] === "tab" && args[1] === "create") {
      return ok(JSON.stringify({ result: { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } } }));
    }
    return ok();
  });

  await withHerdrEnvironment(async () => {
    const result = await tool.execute(
      "test-call",
      {
        cwd: ".",
        workstream: "Close Controls",
        workerHarness: "native",
        purpose: "advisor launch controls",
        prompt: "Inspect the final diff.",
      },
      undefined,
      undefined,
      { cwd: process.cwd() } as ExtensionContext,
    );
    assert.deepEqual(result.details, {
      tabId: "w1:t9",
      paneId: "w1:p9",
      label: "advisor · launch controls",
      cwd: process.cwd(),
      workstream: "close-controls",
      workerHarness: "native",
    });
  });

  assert.deepEqual(calls, [
    ["tab", "create", "--no-focus", "--cwd", process.cwd(), "--label", "advisor · launch controls"],
    ["pane", "rename", "w1:p9", "advisor · launch controls"],
    ["pane", "run", "w1:p9", "pi"],
    ["agent", "get", "w1:p9"],
    [
      "agent",
      "prompt",
      "w1:p9",
      "/skill:advisor-native\n\nCall advisor_session_init with workstream \"close-controls\" and workerHarness \"native\" before any other tool.\n\nAdditional instructions:\nInspect the final diff.",
    ],
  ]);
});

test("advisor_launch closes a created tab when its root pane is missing", async () => {
  const { calls, tool } = installedAdvisorLaunch((args) => {
    if (args[0] === "tab" && args[1] === "create") {
      return ok(JSON.stringify({ result: { tab: { tab_id: "w1:t9" }, root_pane: {} } }));
    }
    return ok();
  });

  await withHerdrEnvironment(async () => {
    await assert.rejects(
      tool.execute("test-call", { cwd: ".", purpose: "tab launch" }, undefined, undefined, { cwd: process.cwd() } as ExtensionContext),
      /did not return the new advisor root pane ID/,
    );
  });

  assert.deepEqual(calls, [
    ["tab", "create", "--no-focus", "--cwd", process.cwd(), "--label", "advisor · tab launch"],
    ["tab", "close", "w1:t9"],
  ]);
});

test('resume migrates legacy session notes to one pointer and missing checkpoint fences launch but not cancellation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'advisor-pointer-')); const previous = process.env.ADVISOR_STATE_DIR; process.env.ADVISOR_STATE_DIR = dir;
  t.after(async () => { if (previous === undefined) delete process.env.ADVISOR_STATE_DIR; else process.env.ADVISOR_STATE_DIR = previous; await rm(dir, { recursive: true, force: true }); });
  await mkdir(join(dir, 'workstreams')); await mkdir(join(dir, 'sessions'));
  const checkpoint = join(dir, 'workstreams/work.md'); const session = join(dir, 'sessions/session-12345678.md');
  await writeFile(checkpoint, '# Workstream: work\n- Owner session: `session-12345678`\n## Current state\nAccepted state.\n');
  const legacy = '# Session\n- Workstream: `work`\n## Current state\nOld diary.\n'; await writeFile(session, legacy);
  const runtime = installedAdvisorResumeRuntime([]); await runtime.sessionStart({ reason: 'resume' }, runtime.ctx);
  const pointer = await readFile(session, 'utf8'); assert.match(pointer, /- Checkpoint: `\.\.\/workstreams\/work.md`/); assert.doesNotMatch(pointer, /Old diary|## Current state/);
  assert.equal(await readFile(session + '.legacy', 'utf8'), legacy);
  await runtime.sessionStart({ reason: 'resume' }, runtime.ctx); assert.equal(await readFile(session, 'utf8'), pointer);
  await rm(checkpoint);
  assert.match((await runtime.toolCall({ toolName: 'bg_agent', input: { prompt: 'task', anchor: 'proof' } }))?.reason ?? '', /missing|unknown/);
  assert.equal(await runtime.toolCall({ toolName: 'bg_stop', input: { runId: 'owned' } }), undefined);
});
