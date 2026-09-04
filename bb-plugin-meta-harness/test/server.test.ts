import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  createCorrelationStore,
  fingerprint,
  tokenHash,
  type LaunchReservation,
} from "../src/correlation-store.js";
import plugin from "../src/server.js";

const generation = "a".repeat(64);

interface SpawnedSpec {
  projectId: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  hostId: string;
  cwd: string;
  prompt: string;
  origin: string;
  originPluginId: string | null;
}

type DispatchContext = Record<string, any>;

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
  model: "openai-codex/gpt-5.6-luna",
  reasoning: "low",
  resultPath: "/tmp/advisor/runs/run-1/result.md",
  bootstrap: { role: "builder", maxTurns: 32, allowSubagents: true },
} as const;

function state(
  runId: string,
  threadId: string,
  hostId = "host-1",
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    version: 1,
    runId,
    kind: "agent",
    backend: "bb",
    label: runId,
    cwd: "/tmp/worktree",
    status: "running",
    surface: {
      kind: "bb",
      threadId,
      logicalParentThreadId: "parent-1",
      hostId,
    },
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

function threadAndEnvironment(threadId: string, spec: SpawnedSpec) {
  const environment = {
    id: `environment-${threadId}`,
    projectId: spec.projectId,
    hostId: spec.hostId,
    path: spec.cwd,
    workspaceProvisionType: "unmanaged",
  };
  const thread = {
    id: threadId,
    projectId: spec.projectId,
    providerId: spec.providerId,
    environmentId: environment.id,
    parentThreadId: null,
    originKind: null,
    originPluginId: spec.originPluginId,
    visibility: "visible",
    status: "pending",
  };
  return { environment, thread };
}

function dispatchContext(
  threadId: string,
  spec: SpawnedSpec,
  text = spec.prompt,
  overrides: Record<string, unknown> = {},
): DispatchContext {
  const { environment, thread } = threadAndEnvironment(threadId, spec);
  return {
    thread,
    project: { id: spec.projectId },
    environment,
    host: { id: spec.hostId },
    input: { blocks: [{ type: "text", text, mentions: [] }], text },
    requestedExecution: {
      providerId: spec.providerId,
      model: spec.model,
      reasoningLevel: spec.reasoningLevel,
      serviceTier: null,
      permissionMode: null,
    },
    executionSources: {},
    attempt: "start-turn",
    queuedMessage: null,
    origin: spec.origin,
    originPluginId: spec.originPluginId,
    startedOnBehalfOf: null,
    parentThreadId: null,
    ...overrides,
  };
}

async function createHarness() {
  const spawned = new Map<string, SpawnedSpec>();
  const statuses = new Map<string, string>();
  const runStates = new Map<string, string | Error>();
  const dispatchDecisions: Array<{ action: string }> = [];
  const reservationObservedBeforeDispatch: boolean[] = [];
  let nextThread = 1;
  let spawnCount = 0;
  let defaultExecutionOptionsCount = 0;
  let failSend = false;
  let failBeforeDispatch = false;
  let loseSpawnResponse = false;
  let dispatchMutation:
    | ((context: DispatchContext) => DispatchContext)
    | undefined;
  let releaseDispatch: (() => void) | undefined;
  let dispatchBarrier: Promise<void> | undefined;
  let resolveSpawnEntered: (() => void) | undefined;
  let spawnEntered = new Promise<void>((resolve) => {
    resolveSpawnEntered = resolve;
  });
  let currentFake: ReturnType<typeof createFakePluginHost>;

  const options = {
    pluginId: "meta-harness",
    dataDir: await mkdtemp(join(tmpdir(), "meta-plugin-")),
    sdk: {
      threads: {
        get: ({ threadId }: { threadId: string }) => {
          if (threadId === "parent-1") {
            return {
              id: threadId,
              projectId: "project-1",
              environmentId: "environment-parent",
              status: statuses.get(threadId) ?? "idle",
            };
          }
          const spec = spawned.get(threadId);
          if (!spec) throw new Error(`unknown thread ${threadId}`);
          const value = threadAndEnvironment(threadId, spec);
          return {
            ...value.thread,
            status: statuses.get(threadId) ?? "idle",
            environment: value.environment,
            host: { id: spec.hostId },
          };
        },
        spawn: async (args: Record<string, any>) => {
          spawnCount += 1;
          const threadId = `worker-${nextThread++}`;
          const environment = args.environment;
          if (
            environment?.type !== "host" ||
            environment.workspace.type !== "unmanaged"
          ) {
            throw new Error("unexpected environment");
          }
          if (
            !args.providerId ||
            !args.model ||
            !args.reasoningLevel ||
            !environment.hostId ||
            !environment.workspace.path
          ) {
            throw new Error("incomplete exact launch");
          }
          const spec: SpawnedSpec = {
            projectId: args.projectId,
            providerId: args.providerId,
            model: args.model,
            reasoningLevel: args.reasoningLevel,
            hostId: environment.hostId,
            cwd: environment.workspace.path,
            prompt: args.prompt,
            origin: args.origin,
            originPluginId: args.originPluginId ?? null,
          };
          spawned.set(threadId, spec);
          statuses.set(threadId, "idle");
          const database = currentFake.bb.storage.database();
          const row = database
            .prepare(
              "SELECT state FROM meta_harness_bootstrap_launch_reservation WHERE state = 'reserved' LIMIT 1",
            )
            .get();
          reservationObservedBeforeDispatch.push(row !== undefined);
          resolveSpawnEntered?.();
          if (dispatchBarrier) await dispatchBarrier;
          if (failBeforeDispatch) {
            failBeforeDispatch = false;
            throw new Error("transport failed before dispatch outcome was observable");
          }
          let context = dispatchContext(threadId, spec);
          if (dispatchMutation) context = dispatchMutation(context);
          const hook = currentFake.harness.registrations.hooks["message.dispatch"];
          if (!hook) throw new Error("dispatch hook missing");
          const decision = await hook(context as never);
          dispatchDecisions.push(decision);
          if (decision.action === "reject") {
            throw new Error(`dispatch rejected: ${decision.message}`);
          }
          if (loseSpawnResponse) {
            loseSpawnResponse = false;
            throw new Error("transport response lost after provider admission");
          }
          return { id: threadId };
        },
        defaultExecutionOptions: () => {
          defaultExecutionOptionsCount += 1;
          return { model: "openai-codex/gpt-5.6-sol", reasoningLevel: "high" };
        },
        promptHistory: () => [],
        send: () => {
          if (failSend) throw new Error("provider acceptance unknown");
          return { mode: "sent" };
        },
        stop: () => ({ stopped: true }),
        wait: ({ threadId, status: requested }: { threadId: string; status: string }) => ({
          threadId,
          matched: true,
          target: { kind: "status", status: requested },
          thread: { id: threadId, status: requested },
        }),
      },
      hosts: { list: () => [{ id: "host-1", status: "connected" }] },
    },
    experimental_callHostRpc(call: { method: string; input: unknown }) {
      if (call.method === "snapshotRun") {
        const runId = (call.input as { runId: string }).runId;
        const value = runStates.get(runId);
        if (value instanceof Error) throw value;
        if (!value) throw new Error(`missing run ${runId}`);
        return { path: `/tmp/detach/runs/${runId}/state.json`, content: value };
      }
      if (call.method === "snapshotGraph") {
        const graphId = (call.input as { graphId: string }).graphId;
        return {
          path: `/tmp/advisor/graphs/${graphId}.json`,
          content: JSON.stringify({ graphId, nodes: [], waves: [] }),
        };
      }
      if (call.method === "tailLog") {
        return { path: "/tmp/detach/output.log", content: "" };
      }
      if (call.method === "readReservedResult") {
        return { path: "/tmp/advisor/result.md", content: "result" };
      }
      if (call.method === "watchRun") {
        return {
          watching: true,
          root: `/tmp/detach/runs/${(call.input as { runId: string }).runId}`,
        };
      }
      throw new Error(`unexpected host RPC ${call.method}`);
    },
  };

  currentFake = createFakePluginHost(options as never);
  await plugin(currentFake.bb);

  return {
    get fake() {
      return currentFake;
    },
    runStates,
    statuses,
    spawned,
    dispatchDecisions,
    reservationObservedBeforeDispatch,
    get spawnCount() {
      return spawnCount;
    },
    get defaultExecutionOptionsCount() {
      return defaultExecutionOptionsCount;
    },
    setFailSend(value: boolean) {
      failSend = value;
    },
    loseNextSpawnResponse() {
      loseSpawnResponse = true;
    },
    failNextSpawnBeforeDispatch() {
      failBeforeDispatch = true;
    },
    mutateNextDispatch(
      mutation: (context: DispatchContext) => DispatchContext,
    ) {
      dispatchMutation = mutation;
    },
    holdDispatch() {
      dispatchBarrier = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
    },
    releaseDispatch() {
      releaseDispatch?.();
      releaseDispatch = undefined;
      dispatchBarrier = undefined;
    },
    waitForSpawnEntry() {
      return spawnEntered;
    },
    resetSpawnEntry() {
      spawnEntered = new Promise<void>((resolve) => {
        resolveSpawnEntered = resolve;
      });
    },
    async reload() {
      currentFake = await currentFake.harness.reload(plugin);
    },
    contextFor(threadId: string, text?: string, overrides?: Record<string, unknown>) {
      const spec = spawned.get(threadId);
      if (!spec) throw new Error(`unknown thread ${threadId}`);
      return dispatchContext(threadId, spec, text, overrides);
    },
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function post(
  fake: Harness["fake"],
  path: string,
  body: unknown,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fake.harness.fetchHttp("POST", path, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function reserveForHook(harness: Harness, token: string, runId = "reserved-run") {
  const now = Date.now();
  const value: LaunchReservation = {
    runId,
    bootstrapTokenHash: tokenHash(token),
    requestFingerprint: fingerprint({ runId }),
    logicalParentThreadId: "parent-1",
    logicalParentEnvironmentId: "environment-parent",
    graphId: "graph-1",
    nodeId: "node-1",
    projectId: "project-1",
    hostId: "host-1",
    cwd: "/tmp/worktree",
    providerId: "pi",
    model: "openai-codex/gpt-5.6-luna",
    reasoning: "low",
    expectedOrigin: "plugin",
    expectedOriginPluginId: "meta-harness",
    expectedVisibility: "visible",
    expectedParentThreadId: null,
    expectedOriginKind: null,
    expectedWorkspaceProvisionType: "unmanaged",
    bootstrapRequired: true,
    state: "reserved",
    createdAt: now,
    updatedAt: now,
  };
  createCorrelationStore(harness.fake.bb.storage.database()).reserve(value);
  const spec: SpawnedSpec = {
    projectId: value.projectId,
    providerId: value.providerId,
    model: value.model,
    reasoningLevel: value.reasoning,
    hostId: value.hostId,
    cwd: value.cwd,
    prompt: `[[bb-meta-worker:v1:${token}]]\nwork`,
    origin: "plugin",
    originPluginId: "meta-harness",
  };
  return { spec, value };
}

describe("server registration and transport", () => {
  it("registers only the exact local routes, typed RPC, lifecycle observers, and dispatch fence", async () => {
    const harness = await createHarness();
    const { fake } = harness;
    expect(
      fake.harness.registrations.httpRoutes.map(
        (route) => `${route.method} ${route.path}`,
      ),
    ).toEqual([
      "POST /v1/agents/start",
      "POST /v1/agents/wait",
      "POST /v1/agents/stop",
      "POST /v1/bootstrap/claim",
      "POST /v1/wakes/authorize",
    ]);
    expect(
      fake.harness.registrations.httpRoutes.every((route) => route.auth === "local"),
    ).toBe(true);
    expect(fake.harness.registrations.rpcMethods.sort()).toEqual([
      "answerBlocked",
      "message",
      "retryWake",
      "skipWake",
      "snapshot",
      "stop",
    ]);
    expect(fake.harness.registrations.hooks["message.dispatch"]).not.toBeNull();
    for (const event of [
      "thread.created",
      "thread.active",
      "thread.idle",
      "thread.failed",
      "thread.deleted",
    ] as const) {
      expect(fake.harness.registrations.threadEventHandlers[event]).toBe(1);
    }
  });

  it("binds in real dispatch ordering before spawn resolves and ignores future project defaults", async () => {
    const harness = await createHarness();
    const first = await post(harness.fake, "/v1/agents/start", startInput);
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({
      runId: "run-1",
      threadId: "worker-1",
      projectId: "project-1",
      environmentId: "environment-worker-1",
      providerId: "pi",
      model: "openai-codex/gpt-5.6-luna",
      reasoning: "low",
      cwd: "/tmp/worktree",
    });
    expect(harness.reservationObservedBeforeDispatch).toEqual([true]);
    expect(harness.dispatchDecisions).toEqual([{ action: "proceed" }]);
    expect(harness.defaultExecutionOptionsCount).toBe(0);

    const spawn = harness.fake.harness.sdk.callsTo("threads.spawn")[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(spawn).toMatchObject({
      projectId: "project-1",
      title: "builder · node-1",
      providerId: "pi",
      model: "openai-codex/gpt-5.6-luna",
      reasoningLevel: "low",
      visibility: "visible",
      origin: "plugin",
      originPluginId: "meta-harness",
      originKind: null,
      environment: {
        type: "host",
        hostId: "host-1",
        workspace: { type: "unmanaged", path: "/tmp/worktree" },
      },
    });
    expect(Object.hasOwn(spawn, "parentThreadId")).toBe(false);
    const prompt = String(spawn.prompt);
    const token = /^\[\[bb-meta-worker:v1:([A-Za-z0-9_-]+)\]\]/u.exec(prompt)?.[1];
    expect(token).toBeTruthy();

    const row = harness.fake.bb.storage.database().prepare(
      "SELECT * FROM meta_harness_bootstrap_launch_reservation WHERE run_id = ?",
    ).get("run-1") as Record<string, unknown>;
    expect(row).toMatchObject({
      run_id: "run-1",
      state: "bound",
      thread_id: "worker-1",
      environment_id: "environment-worker-1",
      bootstrap_token_hash: tokenHash(token!),
    });
    expect(String(row.bootstrap_token_hash)).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(row)).not.toContain(token!);

    const hook = harness.fake.harness.registrations.hooks["message.dispatch"]!;
    await expect(
      hook(harness.contextFor("worker-1", prompt) as never),
    ).resolves.toEqual({ action: "proceed" });
    await expect(
      hook(harness.contextFor("worker-1", "worker input without marker") as never),
    ).resolves.toMatchObject({ action: "reject" });
    await expect(
      hook(
        harness.contextFor(
          "worker-1",
          `[[bb-meta-worker:v1:${"z".repeat(32)}]]\nspoof`,
        ) as never,
      ),
    ).resolves.toMatchObject({ action: "reject" });
    await expect(
      hook(
        harness.contextFor(
          "worker-1",
          "[[bb-meta-worker:v1:not-valid!]]\nmalformed",
        ) as never,
      ),
    ).resolves.toMatchObject({ action: "reject" });
    await expect(
      hook(
        harness.contextFor("worker-1", prompt, {
          originPluginId: "different-plugin",
        }) as never,
      ),
    ).resolves.toMatchObject({ action: "reject" });
    const workerSpec = harness.spawned.get("worker-1")!;
    await expect(
      hook(dispatchContext("wrong-thread", workerSpec, prompt) as never),
    ).resolves.toMatchObject({ action: "reject" });

    const wrong = await post(harness.fake, "/v1/bootstrap/claim", {
      version: "1",
      token,
      threadId: "wrong",
    });
    expect(wrong.response.status).toBe(409);
    const claim = await post(harness.fake, "/v1/bootstrap/claim", {
      version: "1",
      token,
      threadId: "worker-1",
    });
    expect(claim.response.status).toBe(200);
    expect(claim.body).toMatchObject({
      role: "builder",
      runDir: "/tmp/advisor/runs/run-1",
      maxTurns: 32,
      launchModel: "openai-codex/gpt-5.6-luna",
      launchThinking: "low",
      allowSubagents: true,
    });
    expect(
      (
        await post(harness.fake, "/v1/bootstrap/claim", {
          version: "1",
          token,
          threadId: "worker-1",
        })
      ).response.status,
    ).toBe(409);
    await expect(
      hook(harness.contextFor("worker-1", prompt) as never),
    ).resolves.toMatchObject({ action: "reject" });

    const retry = await post(harness.fake, "/v1/agents/start", startInput);
    expect(retry.body.threadId).toBe("worker-1");
    expect(harness.spawnCount).toBe(1);
  });

  it("keeps one root across concurrent starts and eight lost-response retries", async () => {
    const concurrent = await createHarness();
    concurrent.holdDispatch();
    const firstPending = post(concurrent.fake, "/v1/agents/start", startInput);
    await concurrent.waitForSpawnEntry();
    const competing = await post(concurrent.fake, "/v1/agents/start", startInput);
    expect(competing.response.status).toBe(503);
    expect(competing.body).toMatchObject({
      error: "LAUNCH_IN_PROGRESS",
      state: "reserved",
    });
    expect(concurrent.spawnCount).toBe(1);
    concurrent.releaseDispatch();
    expect((await firstPending).response.status).toBe(200);
    expect(concurrent.spawnCount).toBe(1);

    const lost = await createHarness();
    lost.loseNextSpawnResponse();
    const lostResponse = await post(lost.fake, "/v1/agents/start", startInput);
    expect(lostResponse.response.status).toBe(500);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const retry = await post(lost.fake, "/v1/agents/start", startInput);
      expect(retry.response.status).toBe(200);
      expect(retry.body.threadId).toBe("worker-1");
    }
    expect(lost.spawnCount).toBe(1);
    expect(lost.spawned.size).toBe(1);
  });

  it("binds through a replacement plugin generation without respawning", async () => {
    const harness = await createHarness();
    harness.holdDispatch();
    const generationA = post(harness.fake, "/v1/agents/start", startInput);
    await harness.waitForSpawnEntry();
    await harness.reload();
    harness.releaseDispatch();
    expect((await generationA).response.status).toBe(500);

    const retry = await post(harness.fake, "/v1/agents/start", startInput);
    expect(retry.response.status).toBe(200);
    expect(retry.body.threadId).toBe("worker-1");
    expect(harness.spawnCount).toBe(1);
    const row = harness.fake.bb.storage.database().prepare(
      "SELECT state, thread_id FROM meta_harness_bootstrap_launch_reservation WHERE run_id = ?",
    ).get("run-1");
    expect(row).toEqual({ state: "bound", thread_id: "worker-1" });
  });

  it("rejects changed fingerprints and preserves failed or unbound-unknown reservations", async () => {
    const harness = await createHarness();
    expect((await post(harness.fake, "/v1/agents/start", startInput)).response.status).toBe(200);
    const changed = await post(harness.fake, "/v1/agents/start", {
      ...startInput,
      prompt: `${startInput.prompt}\nchanged`,
    });
    expect(changed.response.status).toBe(409);
    expect(changed.body.error).toBe("LAUNCH_FINGERPRINT_MISMATCH");
    expect(harness.spawnCount).toBe(1);

    const unknown = await createHarness();
    unknown.mutateNextDispatch((context) => ({
      ...context,
      requestedExecution: { ...context.requestedExecution, model: "wrong/model" },
    }));
    const rejected = await post(unknown.fake, "/v1/agents/start", startInput);
    expect(rejected.response.status).toBe(500);
    const retry = await post(unknown.fake, "/v1/agents/start", startInput);
    expect(retry.response.status).toBe(503);
    expect(retry.body.state).toBe("failed");
    expect(unknown.spawnCount).toBe(1);
    const snapshot = (await unknown.fake.harness.callRpc("snapshot", {
      graphId: "graph-1",
    })) as { launchReservations: Array<{ runId: string; state: string }> };
    expect(snapshot.launchReservations).toContainEqual(
      expect.objectContaining({ runId: "run-1", state: "failed" }),
    );

    const ambiguous = await createHarness();
    ambiguous.failNextSpawnBeforeDispatch();
    expect(
      (await post(ambiguous.fake, "/v1/agents/start", startInput)).response.status,
    ).toBe(500);
    await ambiguous.reload();
    const ambiguousRetry = await post(
      ambiguous.fake,
      "/v1/agents/start",
      startInput,
    );
    expect(ambiguousRetry.response.status).toBe(503);
    expect(ambiguousRetry.body).toMatchObject({
      error: "LAUNCH_OUTCOME_UNKNOWN",
      state: "unknown",
    });
    expect(ambiguous.spawnCount).toBe(1);
    expect(
      createCorrelationStore(ambiguous.fake.bb.storage.database()).getByRun("run-1"),
    ).toBeUndefined();
  });

  it("rejects spoofed dispatch identity and bind persistence failure before proceed", async () => {
    const mismatches: Array<[
      string,
      (context: DispatchContext) => DispatchContext,
    ]> = [
      ["project", (context) => ({ ...context, project: { id: "other" } })],
      ["host", (context) => ({ ...context, host: { id: "other" } })],
      [
        "cwd",
        (context) => ({
          ...context,
          environment: { ...context.environment, path: "/tmp/other" },
        }),
      ],
      [
        "provider",
        (context) => ({
          ...context,
          requestedExecution: {
            ...context.requestedExecution,
            providerId: "other",
          },
        }),
      ],
      [
        "model",
        (context) => ({
          ...context,
          requestedExecution: { ...context.requestedExecution, model: "other/model" },
        }),
      ],
      [
        "reasoning",
        (context) => ({
          ...context,
          requestedExecution: {
            ...context.requestedExecution,
            reasoningLevel: "high",
          },
        }),
      ],
      ["origin", (context) => ({ ...context, originPluginId: "other" })],
      [
        "parent",
        (context) => ({
          ...context,
          parentThreadId: "parent-1",
          thread: { ...context.thread, parentThreadId: "parent-1" },
        }),
      ],
      [
        "visibility",
        (context) => ({
          ...context,
          thread: { ...context.thread, visibility: "hidden" },
        }),
      ],
    ];

    for (const [name, mutate] of mismatches) {
      const harness = await createHarness();
      const token = `${name.padEnd(32, "x")}`;
      const { spec } = reserveForHook(harness, token, `reserved-${name}`);
      const hook = harness.fake.harness.registrations.hooks["message.dispatch"]!;
      const context = mutate(dispatchContext(`thread-${name}`, spec));
      await expect(hook(context as never), name).resolves.toMatchObject({
        action: "reject",
      });
      expect(createCorrelationStore(harness.fake.bb.storage.database()).list()).toHaveLength(0);
    }

    const persistence = await createHarness();
    const token = "p".repeat(32);
    const { spec } = reserveForHook(persistence, token);
    persistence.fake.bb.storage.database().exec(`
      CREATE TRIGGER reject_bootstrap_bind
      BEFORE UPDATE OF state ON meta_harness_bootstrap_launch_reservation
      WHEN NEW.state = 'bound'
      BEGIN
        SELECT RAISE(ABORT, 'bind denied');
      END;
    `);
    const hook = persistence.fake.harness.registrations.hooks["message.dispatch"]!;
    await expect(
      hook(dispatchContext("thread-persistence", spec) as never),
    ).resolves.toMatchObject({ action: "reject", message: expect.stringMatching(/persistence/u) });
    expect(createCorrelationStore(persistence.fake.bb.storage.database()).list()).toHaveLength(0);
  });

  it("fails closed when the durable reservation cannot be written", async () => {
    const harness = await createHarness();
    harness.fake.bb.storage.database().exec(`
      CREATE TRIGGER reject_bootstrap_reservation
      BEFORE INSERT ON meta_harness_bootstrap_launch_reservation
      BEGIN
        SELECT RAISE(ABORT, 'reservation denied');
      END;
    `);
    const response = await post(harness.fake, "/v1/agents/start", startInput);
    expect(response.response.status).toBe(500);
    expect(harness.spawnCount).toBe(0);
  });

  it("fails closed when the one-time claim cannot be persisted", async () => {
    const harness = await createHarness();
    expect((await post(harness.fake, "/v1/agents/start", startInput)).response.status).toBe(200);
    const spawn = harness.fake.harness.sdk.callsTo("threads.spawn")[0]?.[0] as {
      prompt: string;
    };
    const token = /^\[\[bb-meta-worker:v1:([A-Za-z0-9_-]+)\]\]/u.exec(
      spawn.prompt,
    )?.[1];
    harness.fake.bb.storage.database().exec(`
      CREATE TRIGGER reject_bootstrap_claim
      BEFORE UPDATE OF bootstrap_claimed_at ON meta_harness_correlation
      BEGIN
        SELECT RAISE(ABORT, 'claim denied');
      END;
    `);
    const claim = await post(harness.fake, "/v1/bootstrap/claim", {
      version: "1",
      token,
      threadId: "worker-1",
    });
    expect(claim.response.status).toBe(500);
    const row = harness.fake.bb.storage.database().prepare(
      "SELECT bootstrap_claimed_at FROM meta_harness_correlation WHERE run_id = 'run-1'",
    ).get();
    expect(row).toEqual({ bootstrap_claimed_at: null });
    const hook = harness.fake.harness.registrations.hooks["message.dispatch"]!;
    await expect(
      hook(harness.contextFor("worker-1", "marker was not stripped") as never),
    ).resolves.toMatchObject({ action: "reject" });
    expect(harness.fake.harness.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("claims once, resumes the same run/thread, and leaves unmarked advisor roots usable", async () => {
    const harness = await createHarness();
    await post(harness.fake, "/v1/agents/start", startInput);
    const spawn = harness.fake.harness.sdk.callsTo("threads.spawn")[0]?.[0] as {
      prompt: string;
    };
    const token = /^\[\[bb-meta-worker:v1:([A-Za-z0-9_-]+)\]\]/u.exec(
      spawn.prompt,
    )?.[1];
    await post(harness.fake, "/v1/bootstrap/claim", {
      version: "1",
      token,
      threadId: "worker-1",
    });
    harness.runStates.set("run-1", state("run-1", "worker-1"));

    const hook = harness.fake.harness.registrations.hooks["message.dispatch"]!;
    await expect(
      hook(harness.contextFor("worker-1", "wrong blocked answer") as never),
    ).resolves.toMatchObject({ action: "reject" });
    await expect(
      hook(harness.contextFor("worker-1", "BB-POC-CONTINUE") as never),
    ).resolves.toMatchObject({ action: "reject" });
    await expect(
      harness.fake.harness.callRpc("message", {
        threadId: "worker-1",
        text: "BB-POC-CONTINUE",
      }),
    ).rejects.toThrow(/typed answer control/u);

    expect(
      (
        await post(harness.fake, "/v1/agents/start", {
          ...startInput,
          continuation: true,
          prompt: "wrong",
        })
      ).response.status,
    ).toBe(409);
    expect(
      (
        await post(harness.fake, "/v1/agents/start", {
          ...startInput,
          continuation: true,
          prompt: "BB-POC-CONTINUE",
          model: "openai-codex/gpt-5.6-sol",
        })
      ).response.status,
    ).toBe(409);
    expect(harness.fake.harness.sdk.callsTo("threads.send")).toHaveLength(0);

    const continued = await post(harness.fake, "/v1/agents/start", {
      ...startInput,
      continuation: true,
      prompt: "BB-POC-CONTINUE",
    });
    expect(continued.response.status).toBe(200);
    expect(continued.body.threadId).toBe("worker-1");
    expect(harness.fake.harness.sdk.callsTo("threads.send").at(-1)?.[0]).toEqual({
      threadId: "worker-1",
      mode: "auto",
      input: [{ type: "text", text: "BB-POC-CONTINUE", mentions: [] }],
    });
    expect(
      (
        await post(harness.fake, "/v1/agents/start", {
          ...startInput,
          continuation: true,
          prompt: "BB-POC-CONTINUE",
        })
      ).response.status,
    ).toBe(500);
    expect(harness.spawnCount).toBe(1);

    const advisor = await post(harness.fake, "/v1/agents/start", {
      ...startInput,
      runId: "advisor-1",
      label: "advisor · proof",
      prompt: "/skill:advisor-pi\n\nCall advisor_session_init.",
      resultPath: undefined,
      bootstrap: undefined,
    });
    expect(advisor.response.status).toBe(200);
    const advisorSpawn = harness.fake.harness.sdk.callsTo("threads.spawn")[1]?.[0] as {
      prompt: string;
      parentThreadId?: string;
    };
    expect(advisorSpawn.prompt).not.toContain("[[bb-meta-worker:");
    expect(Object.hasOwn(advisorSpawn, "parentThreadId")).toBe(false);
    await expect(
      hook(harness.contextFor("worker-2", "ordinary advisor input") as never),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("admits only canonical terminal/no-descendant settlement and sends once", async () => {
    const harness = await createHarness();
    await post(harness.fake, "/v1/agents/start", startInput);
    const wake = {
      version: "1",
      runId: "run-1",
      threadId: "worker-1",
      logicalParentThreadId: "parent-1",
      settlementGeneration: generation,
    };

    harness.runStates.set("run-1", new Error("missing artifact projection"));
    expect(
      (await post(harness.fake, "/v1/wakes/authorize", wake)).response.status,
    ).toBe(409);
    for (const resultStatus of [
      "missing result.md",
      "stale result.md",
      "invalid headings",
      "IN PROGRESS",
    ]) {
      harness.runStates.set(
        "run-1",
        state("run-1", "worker-1", "host-1", {
          transportState: "finished",
          settlementDecision: "finish",
          agentState: "stalled",
          resultStatus,
        }),
      );
      expect(
        (await post(harness.fake, "/v1/wakes/authorize", wake)).response.status,
      ).toBe(409);
    }
    harness.runStates.set(
      "run-1",
      state("run-1", "worker-1", "host-1", {
        transportState: "finished",
        settlementDecision: "finish",
        agentState: "done",
        resultStatus: "PASS",
        settlementGeneration: "b".repeat(64),
      }),
    );
    expect(
      (await post(harness.fake, "/v1/wakes/authorize", wake)).response.status,
    ).toBe(409);

    await post(harness.fake, "/v1/agents/start", {
      ...startInput,
      runId: "run-child",
      logicalParentThreadId: "worker-1",
      environmentId: "environment-worker-1",
      label: "checker · child",
      resultPath: "/tmp/advisor/runs/run-child/result.md",
      bootstrap: { role: "checker", maxTurns: 5, allowSubagents: false },
    });
    harness.statuses.set("worker-2", "active");
    harness.runStates.set(
      "run-1",
      state("run-1", "worker-1", "host-1", {
        transportState: "finished",
        settlementDecision: "finish",
        agentState: "done",
        resultStatus: "PASS",
      }),
    );
    expect(
      (await post(harness.fake, "/v1/wakes/authorize", wake)).response.status,
    ).toBe(409);
    expect(harness.fake.harness.sdk.callsTo("threads.send")).toHaveLength(0);

    harness.statuses.set("worker-2", "idle");
    harness.runStates.set(
      "run-child",
      state("run-child", "worker-2", "host-1", {
        transportState: "finished",
        settlementDecision: "finish",
        agentState: "done",
        resultStatus: "PASS",
      }),
    );
    const delivered = await post(harness.fake, "/v1/wakes/authorize", wake);
    expect(delivered.response.status).toBe(200);
    expect(delivered.body.state).toBe("sent");
    const duplicate = await post(harness.fake, "/v1/wakes/authorize", wake);
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body.state).toBe("sent");
    expect(harness.fake.harness.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("persists uncertain provider acceptance as unknown across reload", async () => {
    const harness = await createHarness();
    await post(harness.fake, "/v1/agents/start", startInput);
    harness.runStates.set(
      "run-1",
      state("run-1", "worker-1", "host-1", {
        transportState: "finished",
        settlementDecision: "finish",
        agentState: "done",
        resultStatus: "PASS",
      }),
    );
    harness.setFailSend(true);
    const response = await post(harness.fake, "/v1/wakes/authorize", {
      version: "1",
      runId: "run-1",
      threadId: "worker-1",
      logicalParentThreadId: "parent-1",
      settlementGeneration: generation,
    });
    expect(response.response.status).toBe(503);
    expect(response.body.state).toBe("unknown");
    await harness.reload();
    const snapshot = (await harness.fake.harness.callRpc("snapshot", {
      graphId: "graph-1",
    })) as { wakeAdmissions: Array<{ state: string }> };
    expect(snapshot.wakeAdmissions).toEqual([
      expect.objectContaining({ state: "unknown", runId: "run-1" }),
    ]);

    harness.runStates.set(
      "run-1",
      state("run-1", "worker-1", "host-1", {
        transportState: "finished",
        settlementDecision: "finish",
        agentState: "stalled",
        resultStatus: "stale result.md",
      }),
    );
    await expect(
      harness.fake.harness.callRpc("retryWake", {
        logicalParentThreadId: "parent-1",
        settlementGeneration: generation,
      }),
    ).rejects.toThrow(/does not authorize/u);

    harness.runStates.set(
      "run-1",
      state("run-1", "worker-1", "host-1", {
        transportState: "finished",
        settlementDecision: "finish",
        agentState: "done",
        resultStatus: "PASS",
      }),
    );
    harness.setFailSend(false);
    await expect(
      harness.fake.harness.callRpc("retryWake", {
        logicalParentThreadId: "parent-1",
        settlementGeneration: generation,
      }),
    ).resolves.toEqual({ ok: true });
  });
});
