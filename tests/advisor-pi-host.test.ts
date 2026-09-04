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

test("invalid result stalls and an unseen settlement writes nothing", async () => {
	await withStateRoot(async (root) => {
		const runId = "invalid123";
		const resultPath = await writeResult(root, runId, resultMarkdown("PASS", { claims: false }));
		const host = installedHost();
		await launchPromoted(host, runId, resultPath);
		await host.dispatch("message_end", settlementMessage(runId, resultPath, "done"));

		const { projection } = await validatedTrace(join(root, "traces", `${runId}.jsonl`));
		assert.equal(projection.nodes[0]?.settledStatus, "stalled");
		assert.notEqual(projection.nodes[0]?.settledStatus, "done");

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
