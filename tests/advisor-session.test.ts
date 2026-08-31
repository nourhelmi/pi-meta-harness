import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorSessionExtension from "../extensions/advisor-session.ts";

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

interface ToolCallEvent {
  toolName: string;
  input: unknown;
}

function installedAdvisorResumeRuntime(branch: unknown[]) {
  let sessionStart: ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>) | undefined;
  let beforeAgentStart:
    | ((event: BeforeAgentStartEvent, ctx: ExtensionContext) => { systemPrompt: string } | undefined)
    | undefined;
  let toolCall: ((event: ToolCallEvent) => { block: boolean; reason: string } | undefined) | undefined;
  let sessionName: string | undefined;
  const pi = {
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
        ) => { systemPrompt: string } | undefined;
      }
      if (name === "tool_call") {
        toolCall = handler as (event: ToolCallEvent) => { block: boolean; reason: string } | undefined;
      }
    },
    registerTool: () => undefined,
  } as unknown as ExtensionAPI;
  advisorSessionExtension(pi);
  assert.ok(sessionStart, "session_start handler is registered");
  assert.ok(beforeAgentStart, "before_agent_start handler is registered");
  assert.ok(toolCall, "tool_call handler is registered");
  const ctx = {
    cwd: process.cwd(),
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "session-12345678",
    },
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;
  return { beforeAgentStart, ctx, sessionStart, toolCall };
}

test("advisor doctrine routes locked execution without weakening decision boundaries", async () => {
  const source = await readFile(new URL("../skills/advisor/SKILL.md", import.meta.url), "utf8");
  assert.match(source, /decision load and risk/);
  assert.match(source, /locked execution packet/);
  assert.match(source, /stop and report evidence rather than invent or change a material product/);
  assert.match(source, /deterministic readiness checks/);
  assert.match(source, /check `bg_list`\s+once/);
  assert.match(source, /Coalesce a\s+routine settlement/);
  assert.match(source, /## Foreman delegation/);
  assert.match(source, /advisor stays at the boundaries[\s\S]+Checker economy/);
  assert.match(source, /foremen\s+are Pi-hosted[\s\S]+visible depth-1 delegation/);
  assert.match(source, /profile runs through Pi[\s\S]+provider-native CLI/);
  assert.match(source, /Deliberate criteria revision[\s\S]+new\s+packet revision/);
  assert.match(source, /criteria serve the\s+advisor's judgment, not the reverse/);
  assert.match(source, /## Worker transport recovery/);
  assert.match(source, /at most one fresh changed\s+retry/);
  assert.match(source, /bounded source reads itself[\s\S]+continue to the\s+maker/);
  assert.match(source, /explicit acceptance requirement[\s\S]+unsatisfied/);
});

test("advisor mode entrypoints select their worker harness before loading shared doctrine", async () => {
  const native = await readFile(new URL("../skills/advisor-native/SKILL.md", import.meta.url), "utf8");
  const pi = await readFile(new URL("../skills/advisor-pi/SKILL.md", import.meta.url), "utf8");

  assert.match(native, /advisor_session_init[\s\S]+workerHarness[^\n]+native/i);
  assert.match(native, /resolve `\.\.\/advisor\/SKILL\.md` relative[\s\S]+load it completely/);
  assert.match(native, /advisor-intelligence\.json[\s\S]+Do not call\s+`bg_agent` until both reads are complete/);
  assert.match(native, /every `bg_agent` launch[\s\S]+explicit `model` and `thinking`/);
  assert.match(pi, /advisor_session_init[\s\S]+workerHarness[^\n]+pi/i);
  assert.match(pi, /resolve `\.\.\/advisor\/SKILL\.md` relative[\s\S]+load it completely/);
  assert.match(pi, /advisor-intelligence\.json[\s\S]+Do not call\s+`bg_agent` until both reads are complete/);
  assert.match(pi, /every `bg_agent` launch[\s\S]+explicit `model` and `thinking`/);
});


test("resumed advisors receive current doctrine over stale expanded skill history", async () => {
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
  const result = beforeAgentStart({ systemPrompt: "base prompt" }, ctx);

  assert.ok(result);
  assert.match(result.systemPrompt, /Current Advisor Doctrine/);
  assert.match(result.systemPrompt, /never ask permission merely because/);
  assert.match(result.systemPrompt, /Roles do not pin or allowlist\s+a model/);
  assert.match(result.systemPrompt, /Session mode: \*\*native\*\*/);
  assert.match(result.systemPrompt, /OpenAI models route to Codex CLI/);
  assert.doesNotMatch(result.systemPrompt, /Model character notes are binding/);
  assert.deepEqual(
    toolCall({
      toolName: "bg_agent",
      input: { role: "scout", anchor: "findings are source-linked", harness: "pi" },
    }),
    {
      block: true,
      reason: "Advisor session worker harness is native; per-launch pi is not allowed.",
    },
  );
  assert.equal(
    toolCall({
      toolName: "bg_agent",
      input: { anchor: "summary cites exact file paths", label: "freeform aide" },
    }),
    undefined,
  );
  assert.equal(
    toolCall({
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
    toolCall({
      toolName: "bg_agent",
      input: { label: "freeform aide" },
    }),
    {
      block: true,
      reason: "New advisor workers require at least one concrete acceptance criterion (acceptance[] or anchor).",
    },
  );
});

test("resumed advisors do not duplicate the current expanded doctrine", async () => {
  const source = await readFile(new URL("../skills/advisor/SKILL.md", import.meta.url), "utf8");
  const currentDoctrine = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const branch = [
    {
      type: "message",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: `<skill name="advisor" location="/current/skills/advisor/SKILL.md">
References are relative to /current/skills/advisor.

${currentDoctrine}
</skill>`,
          },
        ],
      },
    },
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
  const { beforeAgentStart, ctx, sessionStart, toolCall } = installedAdvisorResumeRuntime(branch);

  await sessionStart({ reason: "resume" }, ctx);

  const result = beforeAgentStart({ systemPrompt: "base prompt" }, ctx);
  assert.ok(result);
  assert.doesNotMatch(result.systemPrompt, /Current Advisor Doctrine/);
  assert.match(result.systemPrompt, /Session mode: \*\*pi\*\*/);
  assert.deepEqual(
    toolCall({
      toolName: "bg_agent",
      input: { role: "checker", anchor: "review is evidence-backed", harness: "native" },
    }),
    {
      block: true,
      reason: "Advisor session worker harness is pi; per-launch native is not allowed.",
    },
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
    assert.match(result.content[0]?.text ?? "", /Required next actions before planning or delegation/);
    assert.match(result.content[0]?.text ?? "", /advisor\/SKILL\.md/);
    assert.match(result.content[0]?.text ?? "", /advisor-intelligence\.json/);
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
