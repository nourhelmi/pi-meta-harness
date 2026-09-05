import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorPiHostExtension from "../extensions/advisor-pi-host.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface TraceTools {
	loadSchema(): Promise<unknown>;
	parseTrace(text: string): Array<Record<string, unknown>>;
	projectTrace(events: Array<Record<string, unknown>>): {
		nodes: Array<{ state: string; settledStatus: string | null; resultStatus: string | null }>;
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
	return {
		dispatch: async (event: string, value: unknown) => {
			for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
		},
		get registerToolCalls() {
			return registerToolCalls;
		},
	};
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

test("bg_stop call and result request cancellation before the killed settlement", async () => {
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
		await host.dispatch("message_end", settlementMessage(runId, resultPath, "working", { status: "killed" }));

		const { events, projection } = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		assert.ok(events.some((event) => event.type === "node.cancel.requested" && (event.data as Record<string, unknown>).reason === "bg_stop"));
		assert.equal(projection.nodes[0]?.settledStatus, "cancelled");
		assert.equal(projection.wakes.length, 1);
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
