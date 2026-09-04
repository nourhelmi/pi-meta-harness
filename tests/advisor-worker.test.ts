import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorWorkerExtension, { isBlockedStatus, resultStatusLine } from "../extensions/advisor-worker.ts";

interface HookMap {
  session_start?: (event: unknown, ctx: ExtensionContext) => Promise<void>;
	input?: (
		event: { text: string; images?: unknown[] },
		ctx: ExtensionContext,
	) => Promise<{ action: "transform"; text: string; images?: unknown[] } | undefined>;
  before_agent_start?: (event: { systemPrompt: string }, ctx: ExtensionContext) => { systemPrompt: string } | undefined;
  agent_start?: (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
  agent_end?: (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
  agent_settled?: (event: unknown, ctx: ExtensionContext) => Promise<void>;
}

function canonicalPrivateJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalPrivateJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalPrivateJson(record[key])}`)
		.join(",")}}`;
}

function installPrivateRegistry(): void {
	const consumers = new Map<string, (payload: any) => Promise<void>>();
	const canonicalJsonSha256 = (value: unknown) =>
		createHash("sha256").update(canonicalPrivateJson(value)).digest("hex");
	Reflect.set(globalThis, Symbol.for("get-bb.provider-session-initialization.v1"), {
		canonicalJsonSha256,
		register(pluginId: string, consume: (payload: any) => Promise<void>) {
			consumers.set(pluginId, consume);
			return { dispose() { consumers.delete(pluginId); } };
		},
		async consume(payload: any) {
			if (canonicalJsonSha256(payload.value) !== payload.descriptor.payloadSha256)
				throw new Error("PRIVATE_INITIALIZATION_RECEIPT_MISMATCH");
			const consume = consumers.get(payload.descriptor.pluginId);
			if (!consume) throw new Error("PRIVATE_INITIALIZATION_PLUGIN_UNAVAILABLE");
			await consume(payload);
			return { ...payload.descriptor, consumed: true };
		},
	});
}

test("worker runtime grants bounded delegation only when its launch flag allows it", async () => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-worker-delegation-"));
  const rolesPath = join(temp, "roles.json");
	await writeFile(
		rolesPath,
		`${JSON.stringify({
    profiles: {
      builder: { skill: "advisor-role-builder", maxTurns: 6 },
      foreman: { skill: "advisor-role-foreman", maxTurns: 6 },
    },
		})}\n`,
	);

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
	await writeFile(
		rolesPath,
		`${JSON.stringify({
    defaultAgent: "pi",
    profiles: { builder: { skill: "advisor-role-builder", maxTurns: 6 } },
		})}\n`,
	);

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
			getFlag: (name: string) => (name === "advisor-worker-role" ? "builder" : undefined),
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
	await writeFile(
		rolesPath,
		`${JSON.stringify({
    profiles: { builder: { skill: "advisor-role-builder", maxTurns: 6 } },
		})}\n`,
	);

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
			getFlag: (name: string) => (name === "advisor-worker-role" ? "builder" : undefined),
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
			{
				channel: "herdr:blocked",
				data: { active: true, label: "result: BLOCKED" },
			},
    ]);

    await hooks.agent_start?.({}, context);
    assert.deepEqual(emissions, [
			{
				channel: "herdr:blocked",
				data: { active: true, label: "result: BLOCKED" },
			},
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

test("BB worker consumes one private initialization before model input", async () => {
	installPrivateRegistry();
	const conformanceRegistry = Reflect.get(
		globalThis,
		Symbol.for("get-bb.provider-session-initialization.v1"),
	) as { canonicalJsonSha256(value: unknown): string };
	assert.equal(
		conformanceRegistry.canonicalJsonSha256({
			a: 1,
			A: -0,
			"!": 1e-7,
			z: [3, { b: true, B: null }],
		}),
		"d25162139adc954d97a2993bbdb93fd9845cc59a89241de56903bf3603332164",
	);
  const temp = await mkdtemp(join(tmpdir(), "advisor-worker-bb-"));
  const rolesPath = join(temp, "roles.json");
  const runDir = join(temp, "claimed-run");
	await writeFile(
		rolesPath,
		`${JSON.stringify({ profiles: { builder: { skill: "advisor-role-builder", maxTurns: 6 } } })}\n`,
	);
	const envNames = [
		"PI_DETACH_AGENT_PROFILES",
		"BB_THREAD_ID",
		"BB_PROJECT_ID",
		"BB_ENVIRONMENT_ID",
		"BB_SERVER_URL",
		"HERDR_ENV",
		"HERDR_PANE_ID",
		"HERDR_SOCKET_PATH",
	] as const;
	const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]])) as Record<
		(typeof envNames)[number],
		string | undefined
	>;
  Object.assign(process.env, {
    PI_DETACH_AGENT_PROFILES: rolesPath,
    BB_THREAD_ID: "worker-thread",
    BB_PROJECT_ID: "project-1",
    BB_ENVIRONMENT_ID: "worker-environment",
    BB_SERVER_URL: "http://127.0.0.1:38886",
  });
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_SOCKET_PATH;
  try {
    const install = () => {
      const hooks: HookMap = {};
      const entries: Array<{ type: string; data: unknown }> = [];
      const pi = {
        appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
        events: { emit: () => undefined },
			getFlag: () => undefined,
				on: (name: keyof HookMap, handler: HookMap[keyof HookMap]) => {
					if (name === "session_start" && hooks.session_start) {
						const previous = hooks.session_start;
						hooks.session_start = async (event, context) => {
							await previous(event, context);
							await (handler as NonNullable<HookMap["session_start"]>)(event, context);
						};
					} else {
						Object.assign(hooks, { [name]: handler });
					}
				},
        registerFlag: () => undefined,
      } as unknown as ExtensionAPI;
      advisorWorkerExtension(pi);
      return { hooks, entries };
    };
    const context = {
      cwd: temp,
      model: { provider: "openai", id: "gpt-5.6" },
      thinkingLevel: "high",
      sessionManager: { getSessionId: () => "worker-session" },
      ui: { notify: () => undefined, setStatus: () => undefined },
    } as unknown as ExtensionContext;

    const { hooks, entries } = install();
		await hooks.session_start?.({}, context);
		const privateValue = {
			role: "builder",
			runDir,
			resultPath: join(runDir, "result.md"),
			maxTurns: 9,
			launchModel: "openai/gpt-5.6",
			launchThinking: "high",
			allowSubagents: false,
			runId: "run-1",
		};
		const payloadSha256 = createHash("sha256")
			.update(canonicalPrivateJson(privateValue))
			.digest("hex");
		const registry = Reflect.get(globalThis, Symbol.for("get-bb.provider-session-initialization.v1")) as {
			consume(payload: unknown): Promise<unknown>;
		};
		await assert.rejects(
			registry.consume({
				descriptor: {
					version: 1,
					kind: "initial",
					pluginId: "meta-harness",
					reservationId: "reservation-1",
					threadId: "worker-thread",
					inputSha256: "a".repeat(64),
					generation: 1,
					payloadSha256: "0".repeat(64),
				},
				value: privateValue,
			}),
			/RECEIPT_MISMATCH/,
		);
		const receipt = await registry.consume({
			descriptor: {
				version: 1,
				kind: "initial",
				pluginId: "meta-harness",
				reservationId: "reservation-1",
				threadId: "worker-thread",
				inputSha256: "a".repeat(64),
				generation: 1,
				payloadSha256,
			},
			value: privateValue,
		});
		assert.deepEqual(receipt, {
			version: 1,
			kind: "initial",
			pluginId: "meta-harness",
			reservationId: "reservation-1",
			threadId: "worker-thread",
			inputSha256: "a".repeat(64),
			generation: 1,
			payloadSha256,
			consumed: true,
		});
		assert.equal(entries.length, 0, "private role state must not enter Pi session entries");
    const contract = hooks.before_agent_start?.({ systemPrompt: "base" }, context)?.systemPrompt ?? "";
    assert.match(contract, /You are the \*\*builder\*\* worker/);
    assert.match(contract, /at most 9 parent-prompt cycles/);
    assert.match(contract, /launch identity is `openai\/gpt-5\.6` with `high` reasoning/);
		const manifest = JSON.parse(await readFile(join(runDir, "worker-manifest.json"), "utf8")) as Record<
			string,
			unknown
		>;
    assert.equal(manifest.launchModel, "openai/gpt-5.6");
    assert.equal(manifest.maxPromptCycles, 9);
		await assert.rejects(
			registry.consume({
				descriptor: {
					version: 1,
					kind: "initial",
					pluginId: "meta-harness",
					reservationId: "reservation-1",
					threadId: "worker-thread",
					inputSha256: "a".repeat(64),
					generation: 1,
					payloadSha256,
				},
				value: privateValue,
			}),
			/REPLAY/,
		);
  } finally {
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(temp, { recursive: true, force: true });
  }
});
