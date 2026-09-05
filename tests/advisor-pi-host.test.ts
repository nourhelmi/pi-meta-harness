import assert from "node:assert/strict";
import fs from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorPiHostExtension from "../extensions/advisor-pi-host.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface TraceTools {
	loadSchema(): Promise<unknown>;
	parseTrace(text: string): Array<Record<string, unknown>>;
	projectTrace(events: Array<Record<string, unknown>>): {
		nodes: Array<{ state: string; settledStatus: string | null; resultStatus: string | null; cancelRequested: boolean }>;
		wakes: Array<{ generation: number }>;
	};
	validateTrace(
		events: Array<Record<string, unknown>>,
		schema: unknown,
	): { ok: boolean; problems: Array<Record<string, unknown>> };
}

const TRACE_TOOLS_URL = new URL("../scripts/advisor-trace.mjs", import.meta.url).href;

async function traceTools(): Promise<TraceTools> {
	return await import(TRACE_TOOLS_URL) as TraceTools;
}

function advisorBranch(sessionId = "advisor-session-1234") {
	return [{
		type: "custom",
		customType: "advisor-session",
		data: {
			workstream: "pi-host-adapter",
			sessionId,
			initializedAt: "2026-09-04T20:00:00.000Z",
			workerHarness: "pi",
		},
	}];
}

function installedHost(branch: unknown[] = advisorBranch()) {
	const handlers = new Map<string, Handler[]>();
	const busHandlers = new Map<string, Set<(value: unknown) => unknown>>();
	const busInvocations: Promise<void>[] = [];
	const eventBus = createEventBus();
	let registerToolCalls = 0;
	const pi = {
		on: (event: string, handler: Handler) => {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerTool: () => {
			registerToolCalls += 1;
		},
		events: {
			on(channel: string, handler: (value: unknown) => unknown) {
				const current = busHandlers.get(channel) ?? new Set();
				const trackedHandler = (value: unknown) => {
					const invocation = Promise.resolve(handler(value)).then(() => undefined);
					busInvocations.push(invocation);
					return invocation;
				};
				current.add(trackedHandler);
				busHandlers.set(channel, current);
				const unsubscribe = eventBus.on(channel, trackedHandler);
				return () => {
					unsubscribe();
					current.delete(trackedHandler);
				};
			},
			emit(channel: string, value: unknown) {
				eventBus.emit(channel, value);
			},
		},
	} as unknown as ExtensionAPI;
	advisorPiHostExtension(pi);
	const ctx = {
		cwd: process.cwd(),
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => branch,
			getSessionId: () => "advisor-session-1234",
		},
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
	return {
		dispatch: async (event: string, value: unknown) => {
			for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
		},
		emitBus: (value: unknown) => {
			const invocationIndex = busInvocations.length;
			eventBus.emit("pi-detach:agent-settled", value);
			return Promise.all(busInvocations.slice(invocationIndex)).then(() => undefined);
		},
		listenerCount: () => busHandlers.get("pi-detach:agent-settled")?.size ?? 0,
		get registerToolCalls() {
			return registerToolCalls;
		},
	};
}

async function waitUntil(assertion: () => Promise<void> | void, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw lastError;
}

async function withStateRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "advisor-pi-host-"));
	const previous = process.env.ADVISOR_STATE_DIR;
	process.env.ADVISOR_STATE_DIR = root;
	try {
		await run(root);
	} finally {
		if (previous === undefined) delete process.env.ADVISOR_STATE_DIR;
		else process.env.ADVISOR_STATE_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}

function resultMarkdown(status = "PASS", options: { claims?: boolean; statusBody?: string } = {}): string {
	const claims = options.claims === false
		? ""
		: "# Claims\n\n## AC1\n\nThe adapter emitted a valid trace.\n\n";
	return `# Status\n\n${status}${options.statusBody ? `\n\n${options.statusBody}` : ""}\n\n${claims}# Evidence\n\nThe task-shaped test passed.\n\n# Files\n\nThe packet surface only.\n\n# Decisions\n\nAdvisor Core owns validation.\n\n# Remaining Risk\n\nNone for this fixture.\n`;
}

async function writeResult(root: string, name: string, markdown: string): Promise<string> {
	const path = join(root, "artifacts", name, "result.md");
	await mkdir(join(root, "artifacts", name), { recursive: true });
	await writeFile(path, markdown, "utf8");
	return path;
}

async function writeGraphManifest(root: string, graphId: string, waves: string[][]): Promise<void> {
	await mkdir(join(root, "graphs"), { recursive: true });
	await writeFile(join(root, "graphs", `${graphId}.json`), JSON.stringify({
		version: 1,
		graphId,
		goal: `Exercise graph ${graphId}.`,
		advisorSessionId: "advisor-session-1234",
		workstream: "pi-host-adapter",
		maxParallel: 2,
		maxRepairLoops: 1,
		allowParallelBuilders: false,
		nodes: waves.flat().map((id) => ({ id, role: "builder", task: id, acceptance: [`${id} settles.`], requiredSkills: [] })),
		waves,
		warnings: [],
		createdAt: "2026-09-05T10:00:00.000Z",
	}), "utf8");
}

function graphPrompt(graph: string, node: string, wave: number): string {
	return `RISK TIER: Standard. Execute the graph node.\n\nGRAPH:\n  graph: ${graph}\n  node: ${node}\n  wave: ${wave}\n  repair: 0\n  upstream:\n  downstream:\n\nACCEPTANCE CRITERIA:\n1. The graph trace validates.`;
}

function launchInput(overrides: Record<string, unknown> = {}) {
	return {
		prompt: "RISK TIER: Standard. Emit the canonical advisor trace.",
		role: "builder",
		label: "Pi host adapter",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "high",
		acceptance: ["The canonical trace validates with zero problems."],
		...overrides,
	};
}

function promotedDetails(runId: string, resultPath: string, overrides: Record<string, unknown> = {}) {
	return {
		runId,
		promoted: true,
		status: "running",
		role: "builder",
		runtime: "pi",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		thinking: "high",
		resultPath,
		agentName: `builder-${runId}`,
		paneId: `pane-${runId}`,
		...overrides,
	};
}

function settlementMessage(runId: string, resultPath: string, agentState: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "message_end",
		message: {
			role: "custom",
			customType: "detach_agent_settled",
			content: `[detach] agent ${runId} settled ${agentState}`,
			display: true,
			timestamp: Date.now(),
			details: {
				id: runId,
				kind: "agent",
				status: "exited",
				agentState,
				resultPath,
				resultStatus: agentState === "blocked" ? "BLOCKED" : "PASS",
				closeOnSettle: true,
				agentName: `builder-${runId}`,
				paneId: `pane-${runId}`,
				...overrides,
			},
		},
	};
}

function killedSignal(runId: string, overrides: Record<string, unknown> = {}) {
	return {
		v: 1,
		id: runId,
		kind: "agent",
		promoted: true,
		status: "killed",
		endedAt: Date.now(),
		agentName: `builder-${runId}`,
		paneId: `pane-${runId}`,
		settlementNote: "sent esc to interrupt the turn; the agent is still alive in its pane",
		closeOnSettle: false,
		...overrides,
	};
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((value) => {
		resolve = value;
	});
	return { promise, resolve };
}

async function seedRunningTrace(root: string, runId: string): Promise<string> {
	const tracePath = join(root, "traces", `${runId}.jsonl`);
	await mkdir(join(root, "traces"), { recursive: true });
	const events = [
		{
			v: 1,
			seq: 1,
			at: "2026-09-05T00:00:00.000Z",
			run: runId,
			node: null,
			parent: null,
			host: "pi",
			type: "run.created",
			data: {
				workstream: "pi-host-adapter",
				stateRoot: root,
				root: { node: "advisor", session: "advisor-session-1234" },
			},
		},
		{
			v: 1,
			seq: 2,
			at: "2026-09-05T00:00:01.000Z",
			run: runId,
			node: `builder-${runId}`,
			parent: "advisor",
			host: "pi",
			type: "node.launched",
			data: {
				role: "builder",
				label: "builder · cancellation race",
				harness: "pi",
				model: "openai-codex/gpt-5.6-sol",
				thinking: "high",
				cwd: process.cwd(),
				riskTier: "high",
				acceptance: ["Cancellation ordering survives asynchronous host boundaries."],
				launchRef: { detachRunId: runId, agentName: `builder-${runId}` },
			},
		},
	];
	await writeFile(tracePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
	return tracePath;
}

async function launchPromoted(
	host: ReturnType<typeof installedHost>,
	runId: string,
	resultPath: string,
	input = launchInput(),
	detailOverrides: Record<string, unknown> = {},
): Promise<void> {
	await host.dispatch("tool_call", { type: "tool_call", toolName: "bg_agent", toolCallId: `call-${runId}`, input });
	await host.dispatch("tool_result", {
		type: "tool_result",
		toolName: "bg_agent",
		toolCallId: `call-${runId}`,
		input,
		content: [{ type: "text", text: "Agent promoted." }],
		isError: false,
		details: promotedDetails(runId, resultPath, detailOverrides),
	});
}

async function validatedTrace(path: string) {
	const tools = await traceTools();
	const events = tools.parseTrace(await readFile(path, "utf8"));
	const validation = tools.validateTrace(events, await tools.loadSchema());
	assert.deepEqual(validation, { ok: true, problems: [] }, JSON.stringify(validation.problems));
	return { events, projection: tools.projectTrace(events) };
}

test("promoted done launch emits one valid settled node and one generation-1 wake", async () => {
	await withStateRoot(async (root) => {
		const runId = "done123";
		const resultPath = await writeResult(root, runId, resultMarkdown());
		const host = installedHost();
		await launchPromoted(host, runId, resultPath);
		await host.dispatch("message_end", settlementMessage(runId, resultPath, "done"));

		const { projection } = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		assert.equal(host.registerToolCalls, 0);
		assert.equal(projection.nodes.length, 1);
		assert.deepEqual(projection.nodes[0], {
			...projection.nodes[0],
			state: "settled",
			settledStatus: "done",
			resultStatus: "PASS",
		});
		assert.equal(projection.wakes.length, 1);
		assert.equal(projection.wakes[0]?.generation, 1);
	});
});

test("GRAPH launches share one run, emit gated waves, complete settled waves, and fall back when the manifest is missing", async () => {
	await withStateRoot(async (root) => {
		const graph = "pi-two-wave";
		await writeGraphManifest(root, graph, [["plan-node"], ["build-node"]]);
		const host = installedHost();
		const firstPath = await writeResult(root, "graph-plan", resultMarkdown());
		await launchPromoted(host, "detach-plan", firstPath, launchInput({
			role: "planner",
			prompt: graphPrompt(graph, "plan-node", 1),
		}));

		const tracePath = join(root, "traces", `graph-${graph}.jsonl`);
		let traced = await validatedTrace(tracePath);
		assert.deepEqual(traced.events.slice(0, 4).map((event) => event.type), [
			"run.created",
			"graph.planned",
			"wave.started",
			"node.launched",
		]);
		assert.equal((traced.events[0]?.data as Record<string, unknown>).graph, graph);
		assert.equal(traced.events[3]?.node, "plan-node");

		await host.dispatch("message_end", settlementMessage("detach-plan", firstPath, "done"));
		traced = await validatedTrace(tracePath);
		const settlement = traced.events.find((event) => event.type === "node.settled" && event.node === "plan-node");
		const completion = traced.events.find((event) => event.type === "wave.completed" && (event.data as Record<string, unknown>).wave === 1);
		assert.ok(settlement && completion);
		assert.equal(completion.at, settlement.at, "wave completion is appended in the settlement batch");

		const secondPath = await writeResult(root, "graph-build", resultMarkdown());
		await launchPromoted(host, "detach-build", secondPath, launchInput({
			prompt: graphPrompt(graph, "build-node", 2),
		}));
		traced = await validatedTrace(tracePath);
		assert.ok(traced.events.some((event) => event.type === "wave.started" && (event.data as Record<string, unknown>).wave === 2));
		assert.ok(traced.events.some((event) => event.type === "node.launched" && event.node === "build-node"));

		const fallbackPath = await writeResult(root, "missing-graph", resultMarkdown());
		await launchPromoted(host, "detach-fallback", fallbackPath, launchInput({
			prompt: graphPrompt("absent-graph", "missing-node", 1),
		}));
		const fallback = await validatedTrace(join(root, "traces", "detach-fallback.jsonl"));
		assert.equal(fallback.events.some((event) => event.type === "graph.planned"), false);
		await access(join(root, "runs", "pi", "detach-fallback", "graph-manifest-missing.json"));
	});
});

test("blocked result emits node.blocked before result.written and settles blocked", async () => {
	await withStateRoot(async (root) => {
		const runId = "blocked123";
		const resultPath = await writeResult(
			root,
			runId,
			resultMarkdown("BLOCKED", { statusBody: "Choose the product storage boundary." }),
		);
		const host = installedHost();
		const input = launchInput({ prompt: "Make the change; the risk tier is Standard." });
		await launchPromoted(host, runId, resultPath, input, { runtime: "claude" });
		await host.dispatch("message_end", settlementMessage(runId, resultPath, "blocked"));

		const { events, projection } = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		const types = events.map((event) => event.type);
		assert.ok(types.indexOf("node.blocked") < types.indexOf("node.result.written"));
		assert.equal(projection.nodes[0]?.settledStatus, "blocked");
		const blocked = events.find((event) => event.type === "node.blocked");
		assert.deepEqual(blocked?.data, {
			request: { kind: "decision", text: "Choose the product storage boundary." },
		});
		const launch = events.find((event) => event.type === "node.launched");
		assert.equal((launch?.data as Record<string, unknown>).harness, "claude-code");
	});
});

test("name follow-up replies to and resumes the same blocked node before its second settlement", async () => {
	await withStateRoot(async (root) => {
		const runId = "reply123";
		const resumedRunId = "reply456";
		const resultPath = await writeResult(
			root,
			runId,
			resultMarkdown("BLOCKED", { statusBody: "Choose the product storage boundary." }),
		);
		const host = installedHost();
		await launchPromoted(host, runId, resultPath, launchInput({ keepAlive: true }));
		await host.dispatch("message_end", settlementMessage(runId, resultPath, "blocked"));

		await writeFile(resultPath, resultMarkdown(), "utf8");
		const input = launchInput({ role: undefined, name: `builder-${runId}`, prompt: "Use the per-project state file." });
		await host.dispatch("tool_call", { type: "tool_call", toolName: "bg_agent", toolCallId: "call-reply", input });
		await host.dispatch("tool_result", {
			type: "tool_result",
			toolName: "bg_agent",
			toolCallId: "call-reply",
			input,
			content: [{ type: "text", text: "Agent resumed." }],
			isError: false,
			details: promotedDetails(resumedRunId, resultPath, {
				runtime: "existing",
				agentName: `builder-${runId}`,
			}),
		});
		await host.dispatch("message_end", settlementMessage(resumedRunId, resultPath, "done", {
			agentName: `builder-${runId}`,
		}));

		const { events, projection } = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		const blocked = events.find((event) => event.type === "node.blocked");
		const reply = events.find((event) => event.type === "node.reply.sent");
		assert.equal((reply?.data as Record<string, unknown>).replyTo, blocked?.seq);
		assert.equal(reply?.node, `builder-${runId}`);
		assert.ok(events.some((event) => event.type === "node.resumed" && event.node === `builder-${runId}`));
		assert.deepEqual(projection.wakes.map(({ generation }) => generation), [1, 2]);
		await assert.rejects(access(join(root, "traces", `${resumedRunId}.jsonl`)), { code: "ENOENT" });
	});
});

test("bus-only killed delivery settles cancelled after an accepted bg_stop request without requiring an artifact", async () => {
	await withStateRoot(async (root) => {
		const runId = "cancel123";
		const resultPath = await writeResult(root, runId, "");
		const host = installedHost();
		await launchPromoted(host, runId, resultPath);
		await host.dispatch("tool_call", {
			type: "tool_call",
			toolName: "bg_stop",
			toolCallId: "call-stop",
			input: { runId },
		});
		await host.dispatch("tool_result", {
			type: "tool_result",
			toolName: "bg_stop",
			toolCallId: "call-stop",
			input: { runId },
			content: [{ type: "text", text: `Stopped ${runId}.` }],
			isError: false,
			details: { runId, stopped: true },
		});

		let traced = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		assert.equal(traced.projection.nodes[0]?.cancelRequested, true);
		assert.equal(traced.projection.nodes[0]?.state, "running", "a successful stop result is request-only");
		assert.equal(traced.events.some((event) => event.type === "node.settled"), false);

		host.emitBus(killedSignal(runId, { resultPath }));
		await waitUntil(async () => {
			traced = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
			assert.equal(traced.projection.nodes[0]?.settledStatus, "cancelled");
		});

		const { events, projection } = traced;
		assert.ok(events.some((event) => event.type === "node.cancel.requested" && (event.data as Record<string, unknown>).reason === "bg_stop"));
		assert.equal(projection.nodes[0]?.settledStatus, "cancelled");
		assert.equal(projection.wakes.length, 1);
		assert.equal(events.some((event) => event.type === "node.result.written"), false);
	});
});

test("terminal bus delivery before stop result is held behind accepted request; rejected stop invents no request", async () => {
	await withStateRoot(async (root) => {
		const acceptedId = "race-before-accepted";
		const acceptedPath = await writeResult(root, acceptedId, "");
		const host = installedHost();
		await launchPromoted(host, acceptedId, acceptedPath);
		await host.dispatch("tool_call", {
			type: "tool_call", toolName: "bg_stop", toolCallId: "stop-before-accepted", input: { runId: acceptedId },
		});
		host.emitBus(killedSignal(acceptedId, { resultPath: acceptedPath }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		let accepted = await validatedTrace(join(root, "traces", `${acceptedId}.jsonl`));
		assert.equal(accepted.events.some((event) => event.type === "node.settled"), false);
		await host.dispatch("tool_result", {
			type: "tool_result", toolName: "bg_stop", toolCallId: "stop-before-accepted",
			input: { runId: acceptedId }, content: [], isError: false,
			details: { runId: acceptedId, stopped: true },
		});
		await waitUntil(async () => {
			accepted = await validatedTrace(join(root, "traces", `${acceptedId}.jsonl`));
			assert.equal(accepted.projection.nodes[0]?.settledStatus, "cancelled");
		});
		const acceptedTypes = accepted.events.map((event) => event.type);
		assert.ok(acceptedTypes.indexOf("node.cancel.requested") < acceptedTypes.indexOf("node.settled"));

		const rejectedId = "race-before-rejected";
		const rejectedPath = await writeResult(root, rejectedId, "");
		await launchPromoted(host, rejectedId, rejectedPath);
		await host.dispatch("tool_call", {
			type: "tool_call", toolName: "bg_stop", toolCallId: "stop-before-rejected", input: { runId: rejectedId },
		});
		host.emitBus(killedSignal(rejectedId, { resultPath: rejectedPath }));
		await host.dispatch("tool_result", {
			type: "tool_result", toolName: "bg_stop", toolCallId: "stop-before-rejected",
			input: { runId: rejectedId }, content: [], isError: true,
			details: { runId: rejectedId, stopped: true },
		});
		let rejected: Awaited<ReturnType<typeof validatedTrace>> | undefined;
		await waitUntil(async () => {
			rejected = await validatedTrace(join(root, "traces", `${rejectedId}.jsonl`));
			assert.equal(rejected.projection.nodes[0]?.settledStatus, "cancelled");
		});
		assert.equal(rejected?.events.some((event) => event.type === "node.cancel.requested"), false);
	});
});

test("persisted stop lookup keeps terminal evidence contained until the accepted request is durable", async () => {
	await withStateRoot(async (root) => {
		const runId = "persisted-stop-race";
		const tracePath = await seedRunningTrace(root, runId);
		const host = installedHost();
		await host.dispatch("tool_call", {
			type: "tool_call",
			toolName: "bg_stop",
			toolCallId: "persisted-stop-call",
			input: { runId },
		});

		const fsPromises = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
		const originalReaddir = fsPromises.readdir!;
		const readdirEntered = deferred();
		const releaseReaddir = deferred();
		let gated = false;
		fsPromises.readdir = async (...args: unknown[]) => {
			if (!gated && String(args[0]) === join(root, "traces")) {
				gated = true;
				readdirEntered.resolve();
				await releaseReaddir.promise;
			}
			return originalReaddir(...args);
		};
		syncBuiltinESMExports();

		let stopResult: Promise<void> | undefined;
		try {
			stopResult = host.dispatch("tool_result", {
				type: "tool_result",
				toolName: "bg_stop",
				toolCallId: "persisted-stop-call",
				input: { runId },
				content: [],
				isError: false,
				details: { runId, stopped: true },
			});
			await readdirEntered.promise;
			await host.emitBus(killedSignal(runId));

			const contained = await validatedTrace(tracePath);
			assert.deepEqual(contained.events.map((event) => event.type), ["run.created", "node.launched"]);
			assert.equal(contained.projection.nodes[0]?.state, "running");
		} finally {
			releaseReaddir.resolve();
			fsPromises.readdir = originalReaddir;
			syncBuiltinESMExports();
		}
		await stopResult;

		const completed = await validatedTrace(tracePath);
		const types = completed.events.map((event) => event.type);
		assert.ok(types.indexOf("node.cancel.requested") < types.indexOf("node.settled"));
		assert.equal(completed.projection.nodes[0]?.settledStatus, "cancelled");
		assert.deepEqual(completed.projection.wakes.map(({ generation }) => generation), [1]);
	});
});

test("early bus settlement correlates after launch result and duplicate bus/message evidence is idempotent", async () => {
	await withStateRoot(async (root) => {
		const runId = "bus-early123";
		const resultPath = await writeResult(root, runId, "");
		const host = installedHost();
		const input = launchInput();
		await host.dispatch("tool_call", { type: "tool_call", toolName: "bg_agent", toolCallId: "call-bus-early", input });
		host.emitBus(killedSignal(runId, { resultPath }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		await assert.rejects(access(join(root, "traces", `${runId}.jsonl`)), { code: "ENOENT" });
		await host.dispatch("tool_result", {
			type: "tool_result", toolName: "bg_agent", toolCallId: "call-bus-early", input,
			content: [{ type: "text", text: "Agent promoted." }], isError: false,
			details: promotedDetails(runId, resultPath),
		});
		let traced = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		assert.equal(traced.projection.nodes[0]?.settledStatus, "cancelled");
		const count = traced.events.length;

		host.emitBus(killedSignal(runId, { resultPath }));
		await host.dispatch("message_end", settlementMessage(runId, resultPath, "working", { status: "killed" }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		traced = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		assert.equal(traced.events.length, count);
		assert.equal(traced.events.filter((event) => event.type === "node.settled").length, 1);
		assert.equal(traced.events.filter((event) => event.type === "parent.awakened").length, 1);
	});
});

test("killed bus evidence leaves unrelated and already-terminal nodes unchanged", async () => {
	await withStateRoot(async (root) => {
		const doneId = "already-done123";
		const donePath = await writeResult(root, doneId, resultMarkdown());
		const otherId = "other-running123";
		const otherPath = await writeResult(root, otherId, resultMarkdown());
		const host = installedHost();
		await launchPromoted(host, doneId, donePath);
		await launchPromoted(host, otherId, otherPath);
		await host.dispatch("message_end", settlementMessage(doneId, donePath, "done"));
		const before = await readFile(join(root, "traces", `${doneId}.jsonl`), "utf8");
		host.emitBus(killedSignal(doneId, { resultPath: donePath }));
		host.emitBus(killedSignal("unknown-live-id", { agentName: `builder-${otherId}` }));
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(await readFile(join(root, "traces", `${doneId}.jsonl`), "utf8"), before);
		let other = await validatedTrace(join(root, "traces", `${otherId}.jsonl`));
		assert.equal(other.events.some((event) => event.type === "node.settled"), false);
		await assert.rejects(access(join(root, "traces", "unknown-live-id.jsonl")), { code: "ENOENT" });

		await host.dispatch("session_shutdown", { type: "session_shutdown", reason: "reload" });
		const restarted = installedHost();
		restarted.emitBus(killedSignal("unknown-restart-id", { agentName: `builder-${otherId}` }));
		await new Promise((resolve) => setTimeout(resolve, 30));
		other = await validatedTrace(join(root, "traces", `${otherId}.jsonl`));
		assert.equal(other.events.some((event) => event.type === "node.settled"), false);
		await assert.rejects(access(join(root, "traces", "unknown-restart-id.jsonl")), { code: "ENOENT" });
	});
});

test("lenient result settles done, blank result stalls, and an unseen settlement writes nothing", async () => {
	await withStateRoot(async (root) => {
		const runId = "lenient123";
		const resultPath = await writeResult(root, runId, "Status\nPASS\n");
		const host = installedHost();
		await launchPromoted(host, runId, resultPath);
		await host.dispatch("message_end", settlementMessage(runId, resultPath, "done"));

		const { events, projection } = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		assert.equal(projection.nodes[0]?.settledStatus, "done");
		assert.equal(projection.nodes[0]?.resultStatus, "PASS");
		const validation = events.find((event) => event.type === "node.result.validated");
		assert.deepEqual((validation?.data as Record<string, unknown>)?.problems, [
			"missing Claims",
			"missing Evidence",
			"missing Files",
			"missing Decisions",
			"missing Remaining Risk",
		]);

		const blankRunId = "blank123";
		const blankPath = await writeResult(root, blankRunId, "");
		await launchPromoted(host, blankRunId, blankPath);
		await host.dispatch("message_end", settlementMessage(blankRunId, blankPath, "done"));
		const blank = await validatedTrace(join(root, "traces", `${blankRunId}.jsonl`));
		assert.equal(blank.projection.nodes[0]?.settledStatus, "stalled");

		await host.dispatch("message_end", settlementMessage("unseen999", resultPath, "done"));
		await assert.rejects(access(join(root, "traces", "unseen999.jsonl")), { code: "ENOENT" });
	});
});

test("non-promoted tool result emits the complete valid lifecycle inline", async () => {
	await withStateRoot(async (root) => {
		const runId = "inline123";
		const resultPath = await writeResult(root, runId, resultMarkdown());
		const host = installedHost();
		const input = launchInput();
		await host.dispatch("tool_call", { type: "tool_call", toolName: "bg_agent", toolCallId: "call-inline", input });
		await host.dispatch("tool_result", {
			type: "tool_result",
			toolName: "bg_agent",
			toolCallId: "call-inline",
			input,
			content: [{ type: "text", text: "Agent settled inline." }],
			isError: false,
			details: {
				...promotedDetails(runId, resultPath, { runtime: "codex" }),
				promoted: false,
				status: "exited",
				agentState: "done",
				resultStatus: "PASS",
				reusable: false,
			},
		});

		const { events, projection } = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		assert.equal(events[0]?.type, "run.created");
		assert.equal(events.at(-1)?.type, "parent.awakened");
		assert.equal(projection.nodes[0]?.settledStatus, "done");
	});
});

test("stalled inline settlement prefers the typed settlementNote", async () => {
	await withStateRoot(async (root) => {
		const runId = "inline-stalled123";
		const resultPath = await writeResult(root, runId, resultMarkdown());
		const host = installedHost();
		const input = launchInput();
		await host.dispatch("tool_call", {
			type: "tool_call",
			toolName: "bg_agent",
			toolCallId: "call-inline-stalled",
			input,
		});
		await host.dispatch("tool_result", {
			type: "tool_result",
			toolName: "bg_agent",
			toolCallId: "call-inline-stalled",
			input,
			content: [{ type: "text", text: "[detach] fallback tail note" }],
			isError: false,
			details: {
				...promotedDetails(runId, resultPath),
				promoted: false,
				status: "exited",
				agentState: "stalled",
				settlementNote: "typed stalled settlement note",
			},
		});

		const { events, projection } = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		assert.equal(projection.nodes[0]?.settledStatus, "stalled");
		const settlement = events.find((event) => event.type === "node.settled");
		assert.equal((settlement?.data as Record<string, unknown>)?.reason, "typed stalled settlement note");
	});
});

test("ordinary Pi session with no advisor state emits no trace", async () => {
	await withStateRoot(async (root) => {
		const resultPath = await writeResult(root, "ordinary", resultMarkdown());
		const host = installedHost([]);
		await launchPromoted(host, "ordinary123", resultPath);
		await assert.rejects(access(join(root, "traces", "ordinary123.jsonl")), { code: "ENOENT" });
		assert.equal(host.registerToolCalls, 0);
	});
});

test("bus receiver filters malformed, non-cancellation, unknown, and uninitialized signals", async () => {
	await withStateRoot(async (root) => {
		const host = installedHost();
		for (const value of [
			null,
			{},
			{ ...killedSignal("bad-version"), v: 2 },
			{ ...killedSignal("not-killed"), status: "exited" },
			{ ...killedSignal("not-agent"), kind: "watch" },
			{ ...killedSignal("not-promoted"), promoted: false },
			{ ...killedSignal("no-ended-at"), endedAt: undefined },
			{ ...killedSignal("bad-ended-at"), endedAt: Number.NaN },
			{ ...killedSignal("bad-optional"), settlementNote: 42 },
			killedSignal("unknown-run"),
		]) host.emitBus(value);
		await new Promise((resolve) => setTimeout(resolve, 30));
		await assert.rejects(access(join(root, "traces")), { code: "ENOENT" });

		const ordinary = installedHost([]);
		ordinary.emitBus(killedSignal("ordinary-uninitialized"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		await assert.rejects(access(join(root, "traces", "ordinary-uninitialized.jsonl")), { code: "ENOENT" });
	});
});

test("session lifecycle prevents duplicate listeners and late post-teardown writes", async () => {
	await withStateRoot(async (root) => {
		const runId = "teardown123";
		const resultPath = await writeResult(root, runId, "");
		const host = installedHost();
		assert.equal(host.listenerCount(), 1);
		await host.dispatch("session_start", { type: "session_start", reason: "reload" });
		assert.equal(host.listenerCount(), 1, "reload replaces rather than duplicates the bus listener");
		await launchPromoted(host, runId, resultPath);
		const tracePath = join(root, "traces", `${runId}.jsonl`);
		const before = await readFile(tracePath, "utf8");

		host.emitBus(killedSignal(runId, { resultPath }));
		await host.dispatch("session_shutdown", { type: "session_shutdown", reason: "reload" });
		assert.equal(host.listenerCount(), 0);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(await readFile(tracePath, "utf8"), before, "an in-flight old-generation callback cannot append");

		host.emitBus(killedSignal(runId, { resultPath }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(await readFile(tracePath, "utf8"), before, "teardown signals have no listener");
		await host.dispatch("session_start", { type: "session_start", reason: "reload" });
		assert.equal(host.listenerCount(), 1, "a new generation installs exactly one listener");
	});
});

test("shutdown and same-instance reinit drain a settlement append before completing teardown", async () => {
	await withStateRoot(async (root) => {
		const fsPromises = fs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
		const originalAppendFile = fsPromises.appendFile!;
		let activeGate: {
			runId: string;
			entered: ReturnType<typeof deferred>;
			release: ReturnType<typeof deferred>;
			used: boolean;
		} | undefined;
		fsPromises.appendFile = async (...args: unknown[]) => {
			const path = String(args[0]);
			const contents = String(args[1]);
			if (
				activeGate &&
				!activeGate.used &&
				path.endsWith(`${activeGate.runId}.jsonl`) &&
				contents.includes('"type":"node.settled"')
			) {
				activeGate.used = true;
				activeGate.entered.resolve();
				await activeGate.release.promise;
			}
			return originalAppendFile(...args);
		};
		syncBuiltinESMExports();

		async function proveDrain(kind: "shutdown" | "reinit"): Promise<void> {
			const runId = `drain-${kind}`;
			const tracePath = await seedRunningTrace(root, runId);
			const host = installedHost();
			activeGate = { runId, entered: deferred(), release: deferred(), used: false };
			const busDelivery = host.emitBus(killedSignal(runId));
			await activeGate.entered.promise;

			const transition = host.dispatch(
				kind === "shutdown" ? "session_shutdown" : "session_start",
				kind === "shutdown"
					? { type: "session_shutdown", reason: "reload" }
					: { type: "session_start", reason: "reload" },
			);
			assert.equal(host.listenerCount(), 0, `${kind} unsubscribes before draining`);
			let transitionResolved = false;
			void transition.then(() => {
				transitionResolved = true;
			});
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(transitionResolved, false, `${kind} cannot resolve while append is held`);
				const blockedTrace = await validatedTrace(tracePath);
				assert.deepEqual(blockedTrace.events.map((event) => event.type), ["run.created", "node.launched"]);
			} finally {
				activeGate.release.resolve();
			}

			await Promise.all([busDelivery, transition]);
			assert.equal(transitionResolved, true);
			assert.equal(host.listenerCount(), kind === "reinit" ? 1 : 0);
			const completed = await validatedTrace(tracePath);
			assert.equal(completed.projection.nodes[0]?.settledStatus, "cancelled");
			const atCompletedTeardown = await readFile(tracePath, "utf8");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(await readFile(tracePath, "utf8"), atCompletedTeardown, "no write occurs after teardown resolves");
		}

		try {
			await proveDrain("shutdown");
			await proveDrain("reinit");
		} finally {
			activeGate?.release.resolve();
			fsPromises.appendFile = originalAppendFile;
			syncBuiltinESMExports();
		}
	});
});

test("asynchronous bus handler failures are contained without unhandled rejection", async () => {
	await withStateRoot(async (root) => {
		const runId = "bus-error123";
		const resultPath = await writeResult(root, runId, "");
		const host = installedHost();
		await launchPromoted(host, runId, resultPath);
		await rm(join(root, "traces"), { recursive: true, force: true });
		await writeFile(join(root, "traces"), "not a directory", "utf8");
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			host.emitBus(killedSignal(runId, { resultPath }));
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

test("restart appends settlement with contiguous seq and generation-1 wake", async () => {
	await withStateRoot(async (root) => {
		const runId = "restart123";
		const resultPath = await writeResult(root, runId, resultMarkdown());
		const traceDir = join(root, "traces");
		await mkdir(traceDir, { recursive: true });
		const seeded = [
			{
				v: 1,
				seq: 1,
				at: "2026-09-04T20:00:00.000Z",
				run: runId,
				node: null,
				parent: null,
				host: "pi",
				type: "run.created",
				data: {
					workstream: "pi-host-adapter",
					stateRoot: root,
					root: { node: "advisor", session: "advisor-session-1234" },
				},
			},
			{
				v: 1,
				seq: 2,
				at: "2026-09-04T20:00:01.000Z",
				run: runId,
				node: `builder-${runId}`,
				parent: "advisor",
				host: "pi",
				type: "node.launched",
				data: {
					role: "builder",
					label: "builder · restart",
					harness: "pi",
					model: "openai-codex/gpt-5.6-sol",
					thinking: "high",
					cwd: process.cwd(),
					riskTier: "standard",
					acceptance: ["The restarted trace validates."],
					resultPath,
					launchRef: { detachRunId: runId, agentName: `builder-${runId}` },
				},
			},
		];
		await writeFile(
			join(traceDir, `${runId}.jsonl`),
			`${seeded.map((event) => JSON.stringify(event)).join("\n")}\n`,
			"utf8",
		);

		const freshHost = installedHost();
		await freshHost.dispatch("message_end", settlementMessage(runId, resultPath, "done"));
		const { events, projection } = await validatedTrace(join(traceDir, `${runId}.jsonl`));
		assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6]);
		assert.equal(projection.wakes[0]?.generation, 1);
	});
});

test("settlement delivered before the promoted tool result is not lost", async () => {
	await withStateRoot(async (root) => {
		const runId = "early123";
		const resultPath = await writeResult(root, runId, resultMarkdown());
		const host = installedHost();
		const input = launchInput();
		await host.dispatch("tool_call", { type: "tool_call", toolName: "bg_agent", toolCallId: "call-early", input });
		await host.dispatch("message_end", settlementMessage(runId, resultPath, "done"));
		await assert.rejects(access(join(root, "traces", `${runId}.jsonl`)), { code: "ENOENT" });
		await host.dispatch("tool_result", {
			type: "tool_result",
			toolName: "bg_agent",
			toolCallId: "call-early",
			input,
			content: [{ type: "text", text: "Agent promoted." }],
			isError: false,
			details: promotedDetails(runId, resultPath),
		});

		const { projection } = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		assert.equal(projection.nodes[0]?.settledStatus, "done");
		assert.equal(projection.wakes[0]?.generation, 1);
	});
});

test("name follow-up is a new run and reuses the observed harness identity", async () => {
	await withStateRoot(async (root) => {
		const followResult = await writeResult(root, "follow", resultMarkdown());
		const branch = [
			...advisorBranch(),
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "legacy-call",
					toolName: "bg_agent",
					content: [{ type: "text", text: "Agent promoted before the adapter was loaded." }],
					isError: false,
					timestamp: Date.now(),
					details: {
						runId: "legacy123",
						promoted: true,
						status: "running",
						runtime: "codex",
						provider: "openai-codex",
						model: "gpt-5.6-sol",
						thinking: "high",
						agentName: "builder-live",
					},
				},
			},
		];
		const host = installedHost(branch);

		const input = launchInput({ role: undefined, name: "builder-live", prompt: "Repair the artifact." });
		await host.dispatch("tool_call", { type: "tool_call", toolName: "bg_agent", toolCallId: "call-follow", input });
		await host.dispatch("tool_result", {
			type: "tool_result",
			toolName: "bg_agent",
			toolCallId: "call-follow",
			input,
			content: [{ type: "text", text: "Agent settled inline." }],
			isError: false,
			details: {
				runId: "follow123",
				promoted: false,
				status: "exited",
				agentState: "done",
				runtime: "existing",
				agentName: "builder-live",
				paneId: "pane-live",
				resultPath: followResult,
				resultStatus: "PASS",
				reusable: false,
			},
		});

		const { events } = await validatedTrace(join(root, "traces", "follow123.jsonl"));
		const launch = events.find((event) => event.type === "node.launched");
		assert.equal(launch?.node, "freeform-follow123");
		assert.equal((launch?.data as Record<string, unknown>).harness, "codex");
		assert.equal((launch?.data as Record<string, unknown>).riskTier, "high");
	});
});

test("name follow-up to a canonically done node still creates a new run", async () => {
	await withStateRoot(async (root) => {
		const originalRunId = "done-follow-original";
		const followRunId = "done-follow-new";
		const originalPath = await writeResult(root, originalRunId, resultMarkdown());
		const followPath = await writeResult(root, followRunId, resultMarkdown());
		const host = installedHost();
		await launchPromoted(host, originalRunId, originalPath);
		await host.dispatch("message_end", settlementMessage(originalRunId, originalPath, "done"));

		const input = launchInput({ role: undefined, name: `builder-${originalRunId}`, prompt: "Run a separate follow-up." });
		await host.dispatch("tool_call", { type: "tool_call", toolName: "bg_agent", toolCallId: "call-done-follow", input });
		await host.dispatch("tool_result", {
			type: "tool_result",
			toolName: "bg_agent",
			toolCallId: "call-done-follow",
			input,
			content: [{ type: "text", text: "Agent settled inline." }],
			isError: false,
			details: {
				runId: followRunId,
				promoted: false,
				status: "exited",
				agentState: "done",
				runtime: "existing",
				agentName: `builder-${originalRunId}`,
				resultPath: followPath,
				resultStatus: "PASS",
				reusable: false,
			},
		});

		const original = await validatedTrace(join(root, "traces", `${originalRunId}.jsonl`));
		const follow = await validatedTrace(join(root, "traces", `${followRunId}.jsonl`));
		assert.equal(original.events.some((event) => event.type === "node.resumed"), false);
		assert.equal(follow.events.find((event) => event.type === "node.launched")?.node, `freeform-${followRunId}`);
	});
});

test("a launch whose harness identity cannot be recovered is left untraced without throwing", async () => {
	await withStateRoot(async (root) => {
		const host = installedHost();
		const input = launchInput({ role: undefined, name: "ghost-agent", prompt: "Follow up." });
		await host.dispatch("tool_call", { type: "tool_call", toolName: "bg_agent", toolCallId: "call-ghost", input });
		await host.dispatch("tool_result", {
			type: "tool_result",
			toolName: "bg_agent",
			toolCallId: "call-ghost",
			input,
			content: [{ type: "text", text: "Agent settled inline." }],
			isError: false,
			details: { runId: "ghost123", promoted: false, status: "exited", agentState: "done", runtime: "existing", agentName: "ghost-agent" },
		});
		await host.dispatch("tool_call", { type: "tool_call", toolName: "bg_agent", toolCallId: "call-future", input: launchInput() });
		await host.dispatch("tool_result", {
			type: "tool_result",
			toolName: "bg_agent",
			toolCallId: "call-future",
			input: launchInput(),
			content: [{ type: "text", text: "Agent settled inline." }],
			isError: false,
			details: { runId: "future123", promoted: false, status: "exited", agentState: "done", runtime: "gemini" },
		});
		await assert.rejects(access(join(root, "traces", "ghost123.jsonl")));
		await assert.rejects(access(join(root, "traces", "future123.jsonl")));
	});
});
