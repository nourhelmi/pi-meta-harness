import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorWorkerExtension from "../extensions/advisor-worker.ts";

interface HookMap {
  session_start?: (event: unknown, ctx: ExtensionContext) => Promise<void>;
  before_agent_start?: (event: { systemPrompt: string }, ctx: ExtensionContext) => { systemPrompt: string } | undefined;
  agent_settled?: (event: unknown, ctx: ExtensionContext) => Promise<void>;
}

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
