import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorWorkerExtension, { isBlockedStatus, resultStatusLine } from "../extensions/advisor-worker.ts";

interface HookMap {
  session_start?: (event: unknown, ctx: ExtensionContext) => Promise<void>;
  before_agent_start?: (event: { systemPrompt: string }, ctx: ExtensionContext) => { systemPrompt: string } | undefined;
  agent_start?: (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
  agent_end?: (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
  agent_settled?: (event: unknown, ctx: ExtensionContext) => Promise<void>;
}

test("worker runtime grants bounded delegation only when its launch flag allows it", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-worker-delegation-"));
  const rolesPath = join(temp, "roles.json");
  await writeFile(rolesPath, `${JSON.stringify({
    profiles: {
      builder: { skill: "advisor-role-builder", maxTurns: 6 },
      foreman: { skill: "advisor-role-foreman", maxTurns: 6 },
    },
  })}\n`);

  const previousProfiles = process.env.PI_DETACH_AGENT_PROFILES;
  const previousState = process.env.ADVISOR_STATE_DIR;
  process.env.PI_DETACH_AGENT_PROFILES = rolesPath;
  process.env.ADVISOR_STATE_DIR = join(temp, "state");
  try {
    const contractFor = async (role: "builder" | "foreman") => {
      const hooks: HookMap = {};
      const pi = {
        appendEntry: () => undefined,
        events: { emit: () => undefined },
        getFlag: (name: string) => {
          if (name === "advisor-worker-role") return role;
          if (name === "advisor-worker-allow-subagents") return role === "foreman";
          return undefined;
        },
        on: (name: keyof HookMap, handler: HookMap[keyof HookMap]) => {
          Object.assign(hooks, { [name]: handler });
        },
        registerFlag: () => undefined,
      } as unknown as ExtensionAPI;
      advisorWorkerExtension(pi);
      const context = {
        cwd: temp,
        model: { provider: "test", id: "model" },
        thinkingLevel: "low",
        sessionManager: { getSessionId: () => `${role}-session` },
        ui: { notify: () => undefined, setStatus: () => undefined },
      } as unknown as ExtensionContext;
      await hooks.session_start?.({}, context);
      return hooks.before_agent_start?.({ systemPrompt: "base" }, context)?.systemPrompt ?? "";
    };

    const builderContract = await contractFor("builder");
    assert.match(builderContract, /advisor_session_init, another agent, a graph/);
    assert.doesNotMatch(builderContract, /depth-1 visible subagents/);

    const foremanContract = await contractFor("foreman");
    assert.match(foremanContract, /only depth-1 visible subagents through bg_agent/);
    assert.match(foremanContract, /each subagent that it must never launch another agent, graph, orchestrator/);
    assert.doesNotMatch(foremanContract, /advisor_session_init, another agent, a graph/);
  } finally {
    if (previousProfiles === undefined) delete process.env.PI_DETACH_AGENT_PROFILES;
    else process.env.PI_DETACH_AGENT_PROFILES = previousProfiles;
    if (previousState === undefined) delete process.env.ADVISOR_STATE_DIR;
    else process.env.ADVISOR_STATE_DIR = previousState;
    await rm(temp, { recursive: true, force: true });
  }
});

test("worker accepts launch and changed identities outside advisor recommendations", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-worker-"));
  const rolesPath = join(temp, "roles.json");
  await writeFile(rolesPath, `${JSON.stringify({
    defaultAgent: "pi",
    profiles: { builder: { skill: "advisor-role-builder", maxTurns: 6 } },
  })}\n`);

  const previousProfiles = process.env.PI_DETACH_AGENT_PROFILES;
  const previousState = process.env.ADVISOR_STATE_DIR;
  process.env.PI_DETACH_AGENT_PROFILES = rolesPath;
  process.env.ADVISOR_STATE_DIR = join(temp, "state");
  try {
    const hooks: HookMap = {};
    const statuses: string[] = [];
    const pi = {
      appendEntry: () => undefined,
      events: { emit: () => undefined },
      getFlag: (name: string) => name === "advisor-worker-role" ? "builder" : undefined,
      on: (name: keyof HookMap, handler: HookMap[keyof HookMap]) => {
        Object.assign(hooks, { [name]: handler });
      },
      registerFlag: () => undefined,
    } as unknown as ExtensionAPI;
    advisorWorkerExtension(pi);

    const context = {
      cwd: temp,
      model: { provider: "outside-guide", id: "custom-model" },
      thinkingLevel: "low",
      sessionManager: { getSessionId: () => "session-one" },
      ui: {
        notify: () => undefined,
        setStatus: (_key: string, value: string) => statuses.push(value),
      },
    } as unknown as ExtensionContext;

    await hooks.session_start?.({}, context);
    const contract = hooks.before_agent_start?.({ systemPrompt: "base" }, context);
    assert.match(contract?.systemPrompt ?? "", /Load each REQUIRED SKILLS entry before task work/);
    assert.equal("input" in hooks, false);

    Object.assign(context, {
      model: { provider: "another-provider", id: "another-model" },
      thinkingLevel: "max",
    });
    await hooks.agent_settled?.({}, context);

    const [worktree] = await readdir(join(temp, "state", "runs"));
    assert.ok(worktree);
    const manifest = JSON.parse(
      await readFile(join(temp, "state", "runs", worktree, "session-one", "worker-manifest.json"), "utf8"),
    );
    assert.equal(manifest.launchModel, "outside-guide/custom-model");
    assert.equal(manifest.launchThinking, "low");
    assert.equal(manifest.currentModel, "another-provider/another-model");
    assert.equal(manifest.currentThinking, "max");
    assert(statuses.at(-1)?.includes("launch outside-guide/custom-model/low"));
    assert(statuses.at(-1)?.includes("current another-provider/another-model/max"));
  } finally {
    if (previousProfiles === undefined) delete process.env.PI_DETACH_AGENT_PROFILES;
    else process.env.PI_DETACH_AGENT_PROFILES = previousProfiles;
    if (previousState === undefined) delete process.env.ADVISOR_STATE_DIR;
    else process.env.ADVISOR_STATE_DIR = previousState;
    await rm(temp, { recursive: true, force: true });
  }
});

test("extracts and classifies worker result status lines", () => {
  assert.equal(resultStatusLine("# Status\n\n**BLOCKED**\n\n# Claims"), "BLOCKED");
  assert.equal(resultStatusLine("### status\n\n_Blocked — missing approval_"), "Blocked — missing approval");
  assert.equal(resultStatusLine("## Status\n`PASS`"), "PASS");
  assert.equal(resultStatusLine("## Status\n\n## Claims\nBLOCKED"), undefined);
  assert.equal(isBlockedStatus("Blocked — missing approval"), true);
  assert.equal(isBlockedStatus("IN PROGRESS"), false);
});

test("signals a blocked result once and clears it on the next agent start", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-worker-blocked-"));
  const rolesPath = join(temp, "roles.json");
  await writeFile(rolesPath, `${JSON.stringify({
    profiles: { builder: { skill: "advisor-role-builder", maxTurns: 6 } },
  })}\n`);

  const previousProfiles = process.env.PI_DETACH_AGENT_PROFILES;
  const previousState = process.env.ADVISOR_STATE_DIR;
  process.env.PI_DETACH_AGENT_PROFILES = rolesPath;
  process.env.ADVISOR_STATE_DIR = join(temp, "state");
  try {
    const hooks: HookMap = {};
    const emissions: Array<{ channel: string; data: unknown }> = [];
    let runDir: string | undefined;
    const pi = {
      appendEntry: (_type: string, data: unknown) => {
        runDir = (data as { runDir: string }).runDir;
      },
      events: {
        emit: (channel: string, data: unknown) => emissions.push({ channel, data }),
      },
      getFlag: (name: string) => name === "advisor-worker-role" ? "builder" : undefined,
      on: (name: keyof HookMap, handler: HookMap[keyof HookMap]) => {
        Object.assign(hooks, { [name]: handler });
      },
      registerFlag: () => undefined,
    } as unknown as ExtensionAPI;
    advisorWorkerExtension(pi);

    const context = {
      cwd: temp,
      model: { provider: "test", id: "model" },
      thinkingLevel: "low",
      sessionManager: { getSessionId: () => "blocked-session" },
      ui: { notify: () => undefined, setStatus: () => undefined },
    } as unknown as ExtensionContext;
    await hooks.session_start?.({}, context);
    assert.ok(runDir);

    await hooks.agent_end?.({}, context);
    assert.deepEqual(emissions, []);

    await writeFile(join(runDir, "result.md"), "# Status\n\nIN PROGRESS\n");
    await hooks.agent_end?.({}, context);
    await writeFile(join(runDir, "result.md"), "# Status\n\nPASS\n");
    await hooks.agent_end?.({}, context);
    assert.deepEqual(emissions, []);

    await writeFile(join(runDir, "result.md"), "# Status\n\n**BLOCKED** — missing approval\n");
    await hooks.agent_end?.({}, context);
    await hooks.agent_end?.({}, context);
    assert.deepEqual(emissions, [
      { channel: "herdr:blocked", data: { active: true, label: "result: BLOCKED" } },
    ]);

    await hooks.agent_start?.({}, context);
    assert.deepEqual(emissions, [
      { channel: "herdr:blocked", data: { active: true, label: "result: BLOCKED" } },
      { channel: "herdr:blocked", data: { active: false } },
    ]);
  } finally {
    if (previousProfiles === undefined) delete process.env.PI_DETACH_AGENT_PROFILES;
    else process.env.PI_DETACH_AGENT_PROFILES = previousProfiles;
    if (previousState === undefined) delete process.env.ADVISOR_STATE_DIR;
    else process.env.ADVISOR_STATE_DIR = previousState;
    await rm(temp, { recursive: true, force: true });
  }
});
