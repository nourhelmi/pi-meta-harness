import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../src/server.js";

const generation = "a".repeat(64);

interface SpawnedSpec {
  projectId: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  hostId: string;
  cwd: string;
}

function state(runId: string, threadId: string, hostId = "host-1", overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    runId,
    kind: "agent",
    backend: "bb",
    label: runId,
    cwd: "/tmp/worktree",
    status: "running",
    surface: { kind: "bb", threadId, logicalParentThreadId: "parent-1", hostId },
    logPath: `/tmp/detach/runs/${runId}/output.log`,
    resultPath: `/tmp/advisor/runs/${runId}/result.md`,
    resultStatus: "BLOCKED awaiting input",
    agentState: "blocked",
    transportState: "paused",
    settlementDecision: "pause",
    settlementGeneration: generation,
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}

async function createHarness() {
  const spawned = new Map<string, SpawnedSpec>();
  const statuses = new Map<string, string>();
  const runStates = new Map<string, string | Error>();
  let nextThread = 1;
  let failSend = false;
  const fake = createFakePluginHost({
    pluginId: "meta-harness",
    dataDir: await mkdtemp(join(tmpdir(), "meta-plugin-")),
    sdk: {
      threads: {
        get: ({ threadId }) => {
		  if (threadId === "parent-1") return { id: threadId, projectId: "project-1", environmentId: "environment-parent", status: statuses.get(threadId) ?? "idle" };
          const spec = spawned.get(threadId);
          if (!spec) throw new Error(`unknown thread ${threadId}`);
          return {
            id: threadId,
            projectId: spec.projectId,
            providerId: spec.providerId,
            environmentId: `environment-${threadId}`,
            parentThreadId: null,
            originKind: null,
            visibility: "visible",
            status: statuses.get(threadId) ?? "idle",
            environment: { hostId: spec.hostId, path: spec.cwd, workspaceProvisionType: "unmanaged" },
          };
        },
        spawn: (args) => {
          const threadId = `worker-${nextThread++}`;
          const environment = args.environment;
          if (environment?.type !== "host" || environment.workspace.type !== "unmanaged") throw new Error("unexpected environment");
          if (!args.providerId || !args.model || !args.reasoningLevel || !environment.hostId || !environment.workspace.path) throw new Error("incomplete exact launch");
          spawned.set(threadId, {
            projectId: args.projectId,
            providerId: args.providerId,
            model: args.model,
            reasoningLevel: args.reasoningLevel,
            hostId: environment.hostId,
            cwd: environment.workspace.path,
          });
          statuses.set(threadId, "idle");
          return { id: threadId };
        },
        defaultExecutionOptions: ({ threadId }) => {
          const spec = spawned.get(threadId);
          if (!spec) throw new Error("missing execution spec");
          return { model: spec.model, reasoningLevel: spec.reasoningLevel };
        },
        promptHistory: () => [],
        send: () => {
          if (failSend) throw new Error("provider acceptance unknown");
          return { mode: "sent" };
        },
        stop: () => ({ stopped: true }),
        wait: ({ threadId, status: requested }) => ({ threadId, matched: true, target: { kind: "status", status: requested }, thread: { id: threadId, status: requested } }),
      },
      hosts: { list: () => [{ id: "host-1", status: "connected" }] },
    },
    experimental_callHostRpc(call) {
      if (call.method === "snapshotRun") {
        const runId = (call.input as { runId: string }).runId;
        const value = runStates.get(runId);
        if (value instanceof Error) throw value;
        if (!value) throw new Error(`missing run ${runId}`);
        return { path: `/tmp/detach/runs/${runId}/state.json`, content: value };
      }
      if (call.method === "snapshotGraph") {
        const graphId = (call.input as { graphId: string }).graphId;
        return { path: `/tmp/advisor/graphs/${graphId}.json`, content: JSON.stringify({ graphId, nodes: [], waves: [] }) };
      }
      if (call.method === "tailLog") return { path: "/tmp/detach/output.log", content: "" };
      if (call.method === "readReservedResult") return { path: "/tmp/advisor/result.md", content: "result" };
	  if (call.method === "watchRun") return { watching: true, root: `/tmp/detach/runs/${(call.input as { runId: string }).runId}` };
      throw new Error(`unexpected host RPC ${call.method}`);
    },
  });
  await plugin(fake.bb);
  return {
    fake,
    runStates,
    statuses,
    spawned,
    setFailSend(value: boolean) { failSend = value; },
  };
}

const startInput = {
  version: "1",
  runId: "run-1",
  logicalParentThreadId: "parent-1",
  projectId: "project-1",
  environmentId: "environment-parent",
  hostId: "host-1",
  cwd: "/tmp/worktree",
  label: "builder · node-1",
  prompt: "ROLE: builder\nGRAPH: graph-1\nTURN CAP: 32\nallowSubagents: true\nBuild it.",
  providerId: "pi",
  model: "openai/gpt-5.6",
  reasoning: "high",
  resultPath: "/tmp/advisor/runs/run-1/result.md",
	bootstrap: { role: "builder", maxTurns: 32, allowSubagents: true },
} as const;

async function post(fake: Awaited<ReturnType<typeof createHarness>>["fake"], path: string, body: unknown): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fake.harness.fetchHttp("POST", path, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

describe("server registration and transport", () => {
  it("registers only the exact local routes, typed RPC, lifecycle observers, and dispatch fence", async () => {
    const { fake } = await createHarness();
    expect(fake.harness.registrations.httpRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /v1/agents/start",
      "POST /v1/agents/wait",
      "POST /v1/agents/stop",
      "POST /v1/bootstrap/claim",
      "POST /v1/wakes/authorize",
    ]);
    expect(fake.harness.registrations.httpRoutes.every((route) => route.auth === "local")).toBe(true);
    expect(fake.harness.registrations.rpcMethods.sort()).toEqual(["answerBlocked", "message", "retryWake", "skipWake", "snapshot", "stop"]);
    expect(fake.harness.registrations.hooks["message.dispatch"]).not.toBeNull();
    for (const event of ["thread.created", "thread.active", "thread.idle", "thread.failed", "thread.deleted"] as const) {
      expect(fake.harness.registrations.threadEventHandlers[event]).toBe(1);
    }
  });

  it("spawns one visible unparented exact Pi root, binds and claims its bootstrap once, and resumes the same run/thread", async () => {
    const { fake, runStates } = await createHarness();
    const first = await post(fake, "/v1/agents/start", startInput);
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({ runId: "run-1", threadId: "worker-1", projectId: "project-1", environmentId: "environment-worker-1", providerId: "pi", model: "openai/gpt-5.6", reasoning: "high", cwd: "/tmp/worktree" });

    const spawn = fake.harness.sdk.callsTo("threads.spawn")[0]?.[0] as Record<string, unknown>;
    expect(spawn).toMatchObject({
      projectId: "project-1",
      title: "builder · node-1",
      providerId: "pi",
      model: "openai/gpt-5.6",
      reasoningLevel: "high",
      visibility: "visible",
      originKind: null,
      environment: { type: "host", hostId: "host-1", workspace: { type: "unmanaged", path: "/tmp/worktree" } },
    });
    expect(Object.hasOwn(spawn, "parentThreadId")).toBe(false);
    const prompt = String(spawn.prompt);
    const token = /^\[\[bb-meta-worker:v1:([A-Za-z0-9_-]+)\]\]/u.exec(prompt)?.[1];
    expect(token).toBeTruthy();

    const hook = fake.harness.registrations.hooks["message.dispatch"]!;
    await expect(hook({ input: { text: `[[bb-meta-worker:v1:${"z".repeat(32)}]]\nspoof` }, thread: { id: "worker-1" } } as never)).resolves.toMatchObject({ action: "reject" });
	await expect(hook({ input: { text: "worker input without marker" }, thread: { id: "worker-1" } } as never)).resolves.toMatchObject({ action: "reject" });
	await expect(hook({ input: { text: prompt }, thread: { id: "worker-1" } } as never)).resolves.toEqual({ action: "proceed" });
	await expect(hook({ input: { text: prompt }, thread: { id: "worker-1" }, originPluginId: null, queuedMessage: { id: "queued" } } as never)).resolves.toEqual({ action: "proceed" });
    await expect(hook({ input: { text: prompt }, thread: { id: "worker-1" }, originPluginId: "meta-harness" } as never)).resolves.toEqual({ action: "proceed" });
	await expect(hook({ input: { text: prompt }, thread: { id: "worker-1" }, originPluginId: "different-plugin" } as never)).resolves.toMatchObject({ action: "reject" });
    await expect(hook({ input: { text: prompt }, thread: { id: "wrong" }, originPluginId: "meta-harness" } as never)).resolves.toMatchObject({ action: "reject" });
    const wrong = await post(fake, "/v1/bootstrap/claim", { version: "1", token, threadId: "wrong" });
    expect(wrong.response.status).toBe(409);
    const claim = await post(fake, "/v1/bootstrap/claim", { version: "1", token, threadId: "worker-1" });
    expect(claim.response.status).toBe(200);
    expect(claim.body).toMatchObject({ role: "builder", runDir: "/tmp/advisor/runs/run-1", maxTurns: 32, launchModel: "openai/gpt-5.6", launchThinking: "high", allowSubagents: true });
    expect((await post(fake, "/v1/bootstrap/claim", { version: "1", token, threadId: "worker-1" })).response.status).toBe(409);
    await expect(hook({ input: { text: prompt }, thread: { id: "worker-1" } } as never)).resolves.toMatchObject({ action: "reject" });

    const retry = await post(fake, "/v1/agents/start", startInput);
    expect(retry.body.threadId).toBe("worker-1");
    expect(fake.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect((await post(fake, "/v1/agents/start", { ...startInput, continuation: true, prompt: "wrong" })).response.status).toBe(409);

    runStates.set("run-1", state("run-1", "worker-1"));
	await expect(hook({ input: { text: "wrong blocked answer" }, thread: { id: "worker-1" } } as never)).resolves.toMatchObject({ action: "reject" });
	await expect(hook({ input: { text: "BB-POC-CONTINUE" }, thread: { id: "worker-1" } } as never)).resolves.toMatchObject({ action: "reject" });
	await expect(hook({ input: { text: "BB-POC-CONTINUE" }, thread: { id: "worker-1" }, originPluginId: "different-plugin" } as never)).resolves.toMatchObject({ action: "reject" });
	await expect(fake.harness.callRpc("message", { threadId: "worker-1", text: "wrong blocked answer" })).rejects.toThrow(/typed answer control/);
	await expect(fake.harness.callRpc("message", { threadId: "worker-1", text: "BB-POC-CONTINUE" })).rejects.toThrow(/typed answer control/);
	await expect(fake.harness.callRpc("answerBlocked", { runId: "run-1", threadId: "wrong", answer: "BB-POC-CONTINUE" })).rejects.toThrow(/run\/thread mismatch/);
    const continued = await post(fake, "/v1/agents/start", { ...startInput, continuation: true, prompt: "BB-POC-CONTINUE" });
    expect(continued.response.status).toBe(200);
    expect(continued.body.threadId).toBe("worker-1");
    expect(fake.harness.sdk.callsTo("threads.send").at(-1)?.[0]).toEqual({
      threadId: "worker-1",
      mode: "auto",
      input: [{ type: "text", text: "BB-POC-CONTINUE", mentions: [] }],
    });
    expect((await post(fake, "/v1/agents/start", { ...startInput, continuation: true, prompt: "BB-POC-CONTINUE" })).response.status).toBe(500);
    expect(fake.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

	it("leaves an unmarked advisor root usable while keeping it visible and unparented", async () => {
	  const { fake } = await createHarness();
	  const hook = fake.harness.registrations.hooks["message.dispatch"]!;
	  await expect(hook({ input: { text: "ordinary manual root input" }, thread: { id: "manual-root" } } as never)).resolves.toEqual({ action: "proceed" });
	  const advisor = await post(fake, "/v1/agents/start", { ...startInput, runId: "advisor-1", label: "advisor · proof", prompt: "/skill:advisor-pi\n\nCall advisor_session_init.", resultPath: undefined, bootstrap: undefined });
	  expect(advisor.response.status).toBe(200);
	  const spawn = fake.harness.sdk.callsTo("threads.spawn")[0]?.[0] as Record<string, unknown>;
	  expect(String(spawn.prompt)).not.toContain("[[bb-meta-worker:");
	  expect(Object.hasOwn(spawn, "parentThreadId")).toBe(false);
	  await expect(hook({ input: { text: "ordinary advisor input" }, thread: { id: "worker-1" } } as never)).resolves.toEqual({ action: "proceed" });
	});

  it("admits only canonical terminal/no-descendant settlement and sends once on duplicate completion", async () => {
    const { fake, runStates, statuses } = await createHarness();
    await post(fake, "/v1/agents/start", startInput);
    const wake = { version: "1", runId: "run-1", threadId: "worker-1", logicalParentThreadId: "parent-1", settlementGeneration: generation };

    runStates.set("run-1", new Error("missing artifact projection"));
    expect((await post(fake, "/v1/wakes/authorize", wake)).response.status).toBe(409);
    for (const resultStatus of ["missing result.md", "stale result.md", "invalid headings", "IN PROGRESS"]) {
      runStates.set("run-1", state("run-1", "worker-1", "host-1", { transportState: "finished", settlementDecision: "finish", agentState: "stalled", resultStatus }));
      expect((await post(fake, "/v1/wakes/authorize", wake)).response.status).toBe(409);
    }
    runStates.set("run-1", state("run-1", "worker-1", "host-1", { transportState: "finished", settlementDecision: "finish", agentState: "done", resultStatus: "PASS", settlementGeneration: "b".repeat(64) }));
    expect((await post(fake, "/v1/wakes/authorize", wake)).response.status).toBe(409);

	await post(fake, "/v1/agents/start", { ...startInput, runId: "run-child", logicalParentThreadId: "worker-1", environmentId: "environment-worker-1", label: "checker · child", resultPath: "/tmp/advisor/runs/run-child/result.md", bootstrap: { role: "checker", maxTurns: 5, allowSubagents: false } });
    statuses.set("worker-2", "active");
    runStates.set("run-1", state("run-1", "worker-1", "host-1", { transportState: "finished", settlementDecision: "finish", agentState: "done", resultStatus: "PASS" }));
    expect((await post(fake, "/v1/wakes/authorize", wake)).response.status).toBe(409);
    expect(fake.harness.sdk.callsTo("threads.send")).toHaveLength(0);

    statuses.set("worker-2", "idle");
	runStates.set("run-child", state("run-child", "worker-2", "host-1", { transportState: "finished", settlementDecision: "finish", agentState: "done", resultStatus: "PASS" }));
    const delivered = await post(fake, "/v1/wakes/authorize", wake);
    expect(delivered.response.status).toBe(200);
    expect(delivered.body.state).toBe("sent");
    const duplicate = await post(fake, "/v1/wakes/authorize", wake);
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body.state).toBe("sent");
    expect(fake.harness.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(fake.harness.sdk.callsTo("threads.send")[0]?.[0]).toEqual({
      threadId: "parent-1",
      mode: "auto",
      input: [{ type: "text", text: "[meta-harness] run run-1 settled. Read its canonical pi-detach result and continue.", mentions: [] }],
    });
  });

  it("persists uncertain provider acceptance as unknown across reload", async () => {
    const harness = await createHarness();
    await post(harness.fake, "/v1/agents/start", startInput);
    harness.runStates.set("run-1", state("run-1", "worker-1", "host-1", { transportState: "finished", settlementDecision: "finish", agentState: "done", resultStatus: "PASS" }));
    harness.setFailSend(true);
    const response = await post(harness.fake, "/v1/wakes/authorize", { version: "1", runId: "run-1", threadId: "worker-1", logicalParentThreadId: "parent-1", settlementGeneration: generation });
    expect(response.response.status).toBe(503);
    expect(response.body.state).toBe("unknown");
    const reloaded = await harness.fake.harness.reload(plugin);
    const snapshot = await reloaded.harness.callRpc("snapshot", { graphId: "graph-1" }) as { wakeAdmissions: Array<{ state: string }> };
    expect(snapshot.wakeAdmissions).toEqual([expect.objectContaining({ state: "unknown", runId: "run-1" })]);

	harness.runStates.set("run-1", state("run-1", "worker-1", "host-1", { transportState: "finished", settlementDecision: "finish", agentState: "stalled", resultStatus: "stale result.md" }));
	await expect(reloaded.harness.callRpc("retryWake", { logicalParentThreadId: "parent-1", settlementGeneration: generation })).rejects.toThrow(/does not authorize/);
	const stillUnknown = await reloaded.harness.callRpc("snapshot", { graphId: "graph-1" }) as { wakeAdmissions: Array<{ state: string }> };
	expect(stillUnknown.wakeAdmissions).toEqual([expect.objectContaining({ state: "unknown", runId: "run-1" })]);

	harness.runStates.set("run-1", state("run-1", "worker-1", "host-1", { transportState: "finished", settlementDecision: "finish", agentState: "done", resultStatus: "PASS" }));
	harness.setFailSend(false);
	await expect(reloaded.harness.callRpc("retryWake", { logicalParentThreadId: "parent-1", settlementGeneration: generation })).resolves.toEqual({ ok: true });
  });
});
