import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../src/server.js";

const startInput = {
  version: "1",
  runId: "run-1",
  logicalParentThreadId: "parent-1",
  projectId: "project-1",
  environmentId: "environment-parent",
  hostId: "host-1",
  cwd: "/tmp/worktree",
  label: "builder · node-1",
	prompt: "ROLE: builder\nGRAPH: graph-1\nBuild it.",
  providerId: "pi",
  model: "openai-codex/gpt-5.6-luna",
  reasoning: "low",
  resultPath: "/tmp/advisor/runs/run-1/result.md",
  bootstrap: { role: "builder", maxTurns: 32, allowSubagents: true },
} as const;

interface WorkerSpec {
	projectId: string;
	providerId: string;
	model: string;
	reasoningLevel: string;
	hostId: string;
	cwd: string;
	prompt: string;
	originPluginId: string | null;
}

function inputSha256(prompt: string): string {
	return createHash("sha256")
		.update(`[{"mentions":[],"text":${JSON.stringify(prompt)},"type":"text"}]`)
		.digest("hex");
}

async function createHarness() {
	const workers = new Map<string, WorkerSpec>();
  const privateRoleStates = new Map<string, string>();
  let nextThread = 1;
  let spawnCount = 0;
	let resolver: ((context: Record<string, any>) => Promise<Record<string, any>>) | undefined;
	let held = false;
	let release: (() => void) | undefined;
	let entered: (() => void) | undefined;
	const enteredPromise = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let loseResponse = false;
	let activeReservationId: string | undefined;
	let fake: ReturnType<typeof createFakePluginHost>;

	fake = createFakePluginHost({
    pluginId: "meta-harness",
		dataDir: await mkdtemp(join(tmpdir(), "meta-private-plugin-")),
    sdk: {
      threads: {
        get: ({ threadId }: { threadId: string }) => {
					if (threadId === "parent-1")
            return {
              id: threadId,
              projectId: "project-1",
              environmentId: "environment-parent",
							status: "idle",
            };
					const spec = workers.get(threadId);
          if (!spec) throw new Error(`unknown thread ${threadId}`);
					const environment = {
						id: `environment-${threadId}`,
						projectId: spec.projectId,
						hostId: spec.hostId,
						path: spec.cwd,
						workspaceProvisionType: "unmanaged",
					};
          return {
						id: threadId,
						projectId: spec.projectId,
						providerId: spec.providerId,
						environmentId: environment.id,
						parentThreadId: null,
						originKind: null,
						originPluginId: spec.originPluginId,
						visibility: "visible",
						status: "idle",
						environment,
            host: { id: spec.hostId },
          };
        },
        spawn: async (args: Record<string, any>) => {
          spawnCount += 1;
          const threadId = `worker-${nextThread++}`;
					const spec: WorkerSpec = {
            projectId: args.projectId,
            providerId: args.providerId,
            model: args.model,
            reasoningLevel: args.reasoningLevel,
						hostId: args.environment.hostId,
						cwd: args.environment.workspace.path,
            prompt: args.prompt,
            originPluginId: args.originPluginId ?? null,
          };
					workers.set(threadId, spec);
					entered?.();
					if (held)
						await new Promise<void>((resolve) => {
							release = resolve;
						});
					if (!resolver || !activeReservationId) throw new Error("private initialization was not wired");
					const resolution = await resolver({
						version: 1,
						kind: "initial",
						pluginId: "meta-harness",
						reservationId: activeReservationId,
						threadId,
						inputSha256: inputSha256(args.prompt),
						generation: 1,
						projectId: args.projectId,
						environmentId: `environment-${threadId}`,
						hostId: spec.hostId,
						providerId: spec.providerId,
						model: spec.model,
						reasoning: spec.reasoningLevel,
					});
					if (resolution.action !== "provide") throw new Error(String(resolution.code));
					if (loseResponse) {
						loseResponse = false;
						throw new Error("response lost after authenticated binding");
          }
          return { id: threadId };
        },
        promptHistory: () => [],
				send: () => ({ mode: "sent" }),
        stop: () => ({ stopped: true }),
				wait: ({ threadId, status }: { threadId: string; status: string }) => ({
          threadId,
          matched: true,
					target: { kind: "status", status },
					thread: { id: threadId, status },
        }),
      },
      hosts: { list: () => [{ id: "host-1", status: "connected" }] },
    },
		experimental_callHostRpc(call: { method: string; input?: Record<string, unknown> }) {
			if (call.method === "materializePrivateRoleState") {
        const input = call.input as {
          runId: string;
          resultPath: string;
          content: string;
          expectedSha256: string;
        };
        expect(createHash("sha256").update(input.content).digest("hex")).toBe(
          input.expectedSha256,
        );
        const locator = join(dirname(input.resultPath), "private-role-state.json");
        privateRoleStates.set(locator, input.content);
        return { locator };
      }
			if (call.method === "readPrivateRoleState") {
        const input = call.input as {
          locator: string;
          expectedSha256: string;
        };
        const content = privateRoleStates.get(input.locator);
        if (content === undefined) throw new Error("missing private role state");
        expect(createHash("sha256").update(content).digest("hex")).toBe(
          input.expectedSha256,
        );
        return { content };
      }
			if (call.method === "snapshotGraph")
        return {
					path: "/tmp/graph.json",
					content: JSON.stringify({ graphId: "graph-1", nodes: [], waves: [] }),
        };
			if (call.method === "snapshotRun") throw new Error("no canonical run in transport test");
			if (call.method === "tailLog") return { path: "/tmp/log", content: "" };
			if (call.method === "readReservedResult") return { path: "/tmp/result", content: "" };
			if (call.method === "watchRun") return { watching: true, root: "/tmp/run" };
      throw new Error(`unexpected host RPC ${call.method}`);
    },
	} as never);

	Object.assign(fake.bb, {
		experimental_privateThreadInitialization: {
			version: 1,
			registerResolver(next: typeof resolver) {
				if (resolver) throw new Error("duplicate private resolver");
				resolver = next;
  return {
					dispose() {
						resolver = undefined;
    },
				};
    },
			async spawn(args: Record<string, any>) {
				activeReservationId = args.privateInitialization.reservationId;
				try {
					const { privateInitialization: _privateInitialization, ...threadArgs } = args;
					return await fake.bb.sdk.threads.spawn(threadArgs as never);
				} finally {
					activeReservationId = undefined;
				}
    },
    },
      });
	await plugin(fake.bb);

	async function post(body: unknown) {
		const response = await fake.harness.fetchHttp("POST", "/v1/agents/start", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
  };
}
	return {
		fake,
		workers,
		privateRoleStates,
		post,
		get spawnCount() {
			return spawnCount;
		},
		hold() {
			held = true;
		},
		waitForEntry() {
			return enteredPromise;
		},
		release() {
			held = false;
			release?.();
		},
		loseResponse() {
			loseResponse = true;
		},
  };
}

describe("private Meta transport", () => {
	it("registers the private resolver and removes the bootstrap claim route", async () => {
    const harness = await createHarness();
		expect(harness.fake.harness.registrations.httpRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /v1/agents/start",
      "POST /v1/agents/wait",
      "POST /v1/agents/stop",
      "POST /v1/wakes/authorize",
    ]);
		expect(harness.fake.harness.registrations.hooks["message.dispatch"]).not.toBeNull();
		expect(harness.fake.harness.registrations.threadEventHandlers["thread.active"]).toBe(1);
  });

	it("spawns one visible unparented root with marker-free input and identifier-only state", async () => {
    const harness = await createHarness();
		const started = await harness.post(startInput);
		expect(started.response.status, JSON.stringify(started.body)).toBe(200);
		expect(started.body).toMatchObject({
      threadId: "worker-1",
      environmentId: "environment-worker-1",
    });
		expect(harness.spawnCount).toBe(1);
		const spec = harness.workers.get("worker-1");
		expect(spec).toMatchObject({
      providerId: "pi",
			model: startInput.model,
      reasoningLevel: "low",
        hostId: "host-1",
			cwd: "/tmp/worktree",
			prompt: startInput.prompt,
			originPluginId: "meta-harness",
    });
		expect(spec?.prompt).not.toContain("[[" + "bb-meta-worker:");
		const db = harness.fake.bb.storage.database();
		const row = db
			.prepare("SELECT * FROM meta_harness_private_launch_reservation WHERE run_id='run-1'")
			.get() as Record<string, unknown>;
    expect(row).toMatchObject({
      thread_id: "worker-1",
      environment_id: "environment-worker-1",
			generation: 1,
			initialization_state: "resolving",
		});
		expect(Object.keys(row).join(" ")).not.toMatch(/token|bearer/u);
		expect(Object.keys(row)).not.toContain("role_state_json");
		expect(row.role_state_locator).toBe(
			"/tmp/advisor/runs/run-1/private-role-state.json",
		);
		expect(row.role_state_sha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(JSON.stringify(row)).not.toContain(startInput.prompt);
		expect(harness.privateRoleStates.get(String(row.role_state_locator))).toContain(
			'"role":"builder"',
		);
		await harness.fake.harness.emitThreadEvent("thread.active", {
			thread: {
				id: "worker-1",
				projectId: "project-1",
				providerId: "pi",
				status: "active",
			},
		} as never);
    expect(
			db.prepare("SELECT initialization_state FROM meta_harness_private_launch_reservation WHERE run_id='run-1'").get(),
		).toEqual({ initialization_state: "initialized" });
    });

	it("deduplicates concurrent reservation admission and rejects changed requests", async () => {
    const harness = await createHarness();
		harness.hold();
		const first = harness.post(startInput);
		await harness.waitForEntry();
		const duplicate = await harness.post(startInput);
		expect(duplicate.response.status).toBe(503);
		expect(duplicate.body).toMatchObject({
			error: "LAUNCH_OUTCOME_UNKNOWN",
			state: "reserved",
  });
		harness.release();
		expect((await first).response.status).toBe(200);
		const changed = await harness.post({
      ...startInput,
      prompt: `${startInput.prompt}\nchanged`,
    });
    expect(changed.response.status).toBe(409);
    expect(changed.body.error).toBe("LAUNCH_FINGERPRINT_MISMATCH");
    expect(harness.spawnCount).toBe(1);
	});

	it("maps response loss to unknown and never replays the launch", async () => {
		const harness = await createHarness();
		harness.loseResponse();
		expect((await harness.post(startInput)).response.status).toBe(500);
		const retry = await harness.post(startInput);
    expect(retry.response.status).toBe(503);
		expect(retry.body).toMatchObject({
      error: "LAUNCH_OUTCOME_UNKNOWN",
      state: "unknown",
    });
    expect(harness.spawnCount).toBe(1);
  });
});
