import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { BbAgentStartResponseSchema as DetachStartResponseSchema } from "/Users/nour/Dev/pi-detach-worktrees/bb-adapter-poc/src/bb/protocol.ts";
import { BbStartResponseSchema, createBbSurfaceClient, detectBbSurfaceContext } from "../extensions/bb-surface.ts";

const full = {
  BB_THREAD_ID: "thread-1",
  BB_PROJECT_ID: "project-1",
  BB_ENVIRONMENT_ID: "environment-1",
  BB_SERVER_URL: "http://127.0.0.1:38886",
};

test("BB surface requires the complete mutually-exclusive loopback identity", () => {
  assert.deepEqual(detectBbSurfaceContext(full), {
    threadId: "thread-1",
    projectId: "project-1",
    environmentId: "environment-1",
    serverUrl: "http://127.0.0.1:38886",
  });
  assert.equal(detectBbSurfaceContext({}), undefined);
  assert.throws(() => detectBbSurfaceContext({ BB_THREAD_ID: "thread-1" }), /partial BB context/);
  assert.throws(() => detectBbSurfaceContext({ ...full, BB_SERVER_URL: "https://127.0.0.1" }), /loopback http/);
  assert.throws(() => detectBbSurfaceContext({ ...full, BB_SERVER_URL: "http://example.com" }), /loopback http/);
	assert.throws(
		() =>
			detectBbSurfaceContext({
				...full,
				BB_SERVER_URL: "http://127.0.0.1:38886/path",
			}),
		/loopback http/,
	);
  assert.throws(() => detectBbSurfaceContext({ ...full, HERDR_ENV: "1" }), /mutually exclusive/);
});

test("Meta and pi-detach accept and reject identical shared response fixtures", () => {
	const start = {
		version: "1",
		runId: "run-1",
		threadId: "thread-1",
		logicalParentThreadId: "parent-1",
		hostId: "host-1",
		projectId: "project-1",
		environmentId: "environment-1",
		providerId: "pi",
		model: "openai/gpt",
		reasoning: "high",
		cwd: "/worktree",
	};
  for (const fixture of [start, { ...start, extra: true }, { ...start, version: "2" }]) {
    assert.equal(Value.Check(BbStartResponseSchema, fixture), Value.Check(DetachStartResponseSchema, fixture));
  }
});

test("BB surface client uses only the fixed local route and fails closed on redirects and protocol drift", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const context = detectBbSurfaceContext(full);
  assert.ok(context);
	const response = {
		version: "1",
		runId: "run-1",
		threadId: "thread-1",
		logicalParentThreadId: "parent-1",
		hostId: "host-1",
		projectId: "project-1",
		environmentId: "environment-1",
		providerId: "pi",
		model: "openai/gpt",
		reasoning: "high",
		cwd: "/worktree",
	};
  const client = createBbSurfaceClient(context, async (input, init) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return Response.json(response);
  });
  await client.start({ version: "1" });
  assert.equal(calls[0]?.url, "http://127.0.0.1:38886/api/v1/plugins/meta-harness/http/v1/agents/start");
  assert.equal(calls[0]?.init?.redirect, "manual");
	assert.deepEqual(calls[0]?.init?.headers, {
		"content-type": "application/json",
	});

	const redirecting = createBbSurfaceClient(
		context,
		async () =>
			new Response(null, {
				status: 302,
				headers: { location: "http://evil.test" },
			}),
	);
  await assert.rejects(redirecting.start({}), /redirect rejected/);
  const drifting = createBbSurfaceClient(context, async () => Response.json({ ...response, extra: true }));
  await assert.rejects(drifting.start({}), /violated protocol/);
	const oversized = createBbSurfaceClient(
		context,
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
	start(controller) {
	  controller.enqueue(new Uint8Array(700_000));
	  controller.enqueue(new Uint8Array(700_000));
	  controller.close();
	},
				}),
			),
	);
	await assert.rejects(oversized.start({}), /too large/);
});
