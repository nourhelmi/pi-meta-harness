import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { registerCodexCompactionExtension } from "../extensions/codex-compaction/index.ts";
import {
	buildCompactionRequestBody,
	planCompactionInput,
	type LiveRequestCapture,
	type ResponseItem,
} from "../extensions/codex-compaction/native-compaction.ts";

// SAFETY: the extension only reads provider/api/id/baseUrl/input from the model; the rest is inert here.
const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	input: ["text"],
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 128_000,
} as unknown as Model<any>;
const MODEL_KEY = "openai-codex:openai-codex-responses:gpt-6-astra";
// SAFETY: the serializer reads name/description/parameters only; sourceInfo is host bookkeeping.
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }] as unknown as ToolInfo[];

let seq = 0;
let lastId: string | null = null;
// SAFETY: test entries carry only the fields the serializer reads; SessionEntry is the host's wider union.
// Entries chain to the previously created entry by default so buildSessionContext can walk the branch.
const entry = (message: object, parentId: string | null = lastId): SessionEntry => {
	const id = `e${++seq}`;
	lastId = id;
	return { type: "message", id, parentId, timestamp: new Date().toISOString(), message } as unknown as SessionEntry;
};
const userEntry = (text: string, parentId?: string | null) => entry({ role: "user", content: [{ type: "text", text }], timestamp: 1 }, parentId);
const assistantEntry = (options: { toolCallId?: string; text?: string; stopReason?: string }) =>
	entry({
		role: "assistant",
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-6-astra",
		stopReason: options.stopReason ?? (options.toolCallId ? "toolUse" : "stop"),
		content: [
			...(options.text ? [{ type: "text", text: options.text }] : []),
			...(options.toolCallId ? [{ type: "toolCall", id: options.toolCallId, name: "read", arguments: { path: "a.ts" } }] : []),
		],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: 2,
	});
const toolResultEntry = (toolCallId: string) =>
	entry({ role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: "file body" }], isError: false, timestamp: 3 });

const liveInput: ResponseItem[] = [{ role: "user", content: [{ type: "input_text", text: "hello" }] }];
function livePayload() {
	return {
		model: "gpt-6-astra",
		instructions: "LIVE SYSTEM",
		tools: [{ type: "function", name: "read", parameters: { type: "object", properties: {} }, strict: null }],
		input: structuredClone(liveInput),
		prompt_cache_key: "session-1",
		text: { verbosity: "low" },
		include: ["reasoning.encrypted_content"],
		reasoning: { effort: "xhigh", summary: "auto" },
	};
}
function capture(branch: SessionEntry[], overrides: Partial<LiveRequestCapture> = {}): LiveRequestCapture {
	return { modelKey: MODEL_KEY, payload: livePayload(), branchLength: branch.length, leafEntryId: branch.at(-1)?.id, ...overrides };
}
const kinds = (items: ResponseItem[]) => items.map((item) => item.type ?? item.role);

test("planCompactionInput reuses the live prefix verbatim and appends only the newer entries", () => {
	const user = userEntry("hello");
	const live = capture([user]);
	const branch = [user, assistantEntry({ toolCallId: "call_1|fc_abc" }), toolResultEntry("call_1|fc_abc")];
	const plan = planCompactionInput({ branch, model, tools, live });
	assert.equal(plan.source, "live-prefix");
	assert.deepEqual(plan.input.slice(0, liveInput.length), liveInput);
	assert.notEqual(plan.input[0], live.payload.input, "prefix items are cloned, not shared");
	assert.deepEqual(kinds(plan.input), ["user", "function_call", "function_call_output"]);
	assert.equal(plan.input[1]!.call_id, "call_1");
	assert.equal(plan.input[2]!.call_id, "call_1");
	assert.equal(plan.basePayload?.input, undefined, "base payload carries the request shape without input");
	assert.equal(plan.basePayload?.instructions, "LIVE SYSTEM");
});

test("planCompactionInput rebuilds when the capture is stale, foreign, or predates a compaction", () => {
	const user = userEntry("hello");
	const branch = [user, assistantEntry({ text: "done" })];
	const staleLeaf = planCompactionInput({ branch, model, tools, live: capture([user], { leafEntryId: "someone-else" }) });
	assert.equal(staleLeaf.source, "rebuild");
	assert.deepEqual(kinds(staleLeaf.input), ["user", "message"]);

	const otherModel = planCompactionInput({ branch, model, tools, live: capture([user], { modelKey: "openai-codex:openai-codex-responses:gpt-5.6-sol" }) });
	assert.equal(otherModel.source, "rebuild");
	assert.equal(otherModel.basePayload, undefined);

	// SAFETY: a minimal non-native compaction entry; the plan only inspects `type`.
	const compaction = { type: "compaction", id: "c1", parentId: user.id, timestamp: "", summary: "s", firstKeptEntryId: user.id, tokensBefore: 1 } as unknown as SessionEntry;
	const afterCompaction = planCompactionInput({ branch: [user, compaction, assistantEntry({ text: "later" })], model, tools, live: capture([user]) });
	assert.equal(afterCompaction.source, "rebuild");

	const noCapture = planCompactionInput({ branch, model, tools });
	assert.equal(noCapture.source, "rebuild");
});

test("planCompactionInput drops the retried assistant turn from the tail on overflow recovery", () => {
	const user = userEntry("hello");
	const live = capture([user]);
	const branch = [user, assistantEntry({ text: "partial answer" })];
	const plan = planCompactionInput({ branch, model, tools, live, excludeLastAssistantError: true });
	assert.equal(plan.source, "live-prefix");
	assert.deepEqual(plan.input, liveInput);
});

test("buildCompactionRequestBody keeps the live instructions and tools only when asked to preserve the prefix", () => {
	const shared = { model, input: liveInput, instructions: "CURRENT SYSTEM", tools: [{ type: "function", name: "fresh" }], sessionId: "session-1" };
	const base = livePayload();
	delete (base as { input?: unknown }).input;

	const preserved = buildCompactionRequestBody({ ...shared, basePayload: base, preferBasePrefix: true });
	assert.equal(preserved.instructions, "LIVE SYSTEM");
	assert.deepEqual(preserved.tools, base.tools);
	assert.deepEqual((preserved.input as ResponseItem[]).at(-1), { type: "compaction_trigger" });
	assert.equal(preserved.prompt_cache_key, "session-1");
	assert.deepEqual(preserved.reasoning, { effort: "xhigh", summary: "auto" });
	assert.equal("messages" in preserved, false);

	const rebuilt = buildCompactionRequestBody({ ...shared, basePayload: base, preferBasePrefix: false });
	assert.equal(rebuilt.instructions, "CURRENT SYSTEM");
	assert.deepEqual(rebuilt.tools, shared.tools);
});

function harness() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	// SAFETY: the extension touches only these ExtensionAPI members.
	const pi = {
		on(name: string, fn: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		registerEntryRenderer() {},
		appendEntry() {},
		getAllTools: () => tools,
		getActiveTools: () => ["read"],
	} as unknown as ExtensionAPI;
	return {
		pi,
		async emit(name: string, event: unknown, ctx: unknown) {
			let result: unknown;
			for (const fn of handlers.get(name) ?? []) result = (await fn(event, ctx)) ?? result;
			return result;
		},
	};
}

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } })}.sig`;

function context(branch: () => SessionEntry[]) {
	return {
		model,
		hasUI: false,
		mode: "print",
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "session-1", getBranch: branch },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token, headers: { "x-null": null, "x-keep": "1" } }) },
		getSystemPrompt: () => "CURRENT SYSTEM",
		abort() {},
		ui: { notify() {} },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
}

test("the compaction request replays the last live request byte-for-byte and appends the newer turn", async () => {
	const remoteCalls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
	const { pi, emit } = harness();
	registerCodexCompactionExtension(pi, "0.85.1", {
		remote: async (params) => {
			remoteCalls.push({ headers: params.headers, body: params.body });
			return { compactionItem: { type: "compaction", encrypted_content: "enc" } };
		},
	});
	const branch: SessionEntry[] = [userEntry("hello")];
	const ctx = context(() => branch);
	const payload = livePayload();

	const passthrough = await emit("before_provider_request", { payload }, ctx);
	assert.equal(passthrough, undefined, "no checkpoint yet: the provider payload is untouched");

	branch.push(assistantEntry({ toolCallId: "call_1|fc_abc" }), toolResultEntry("call_1|fc_abc"));
	// SAFETY: the compaction result shape is the host's; only the fields asserted below are read.
	const result = (await emit(
		"session_before_compact",
		{ branchEntries: branch, reason: "threshold", willRetry: false, signal: new AbortController().signal, preparation: { firstKeptEntryId: branch[1]!.id, tokensBefore: 250_000 } },
		ctx,
	)) as { compaction: { firstKeptEntryId: string; details: { replacementHistory: ResponseItem[] } } };

	assert.equal(remoteCalls.length, 1);
	const { body, headers } = remoteCalls[0]!;
	const input = body.input as ResponseItem[];
	assert.deepEqual(input.slice(0, liveInput.length), liveInput, "cached prefix is the live input, verbatim");
	assert.deepEqual(kinds(input), ["user", "function_call", "function_call_output", "compaction_trigger"]);
	assert.equal(body.instructions, "LIVE SYSTEM", "instructions come from the live request, not the current prompt");
	assert.deepEqual(body.tools, payload.tools, "tools come from the live request, not a rebuilt payload");
	assert.equal(body.prompt_cache_key, "session-1");
	assert.equal(headers.get("x-keep"), "1");
	assert.equal(headers.has("x-null"), false, "null provider headers are dropped instead of serialized");
	assert.match(headers.get("x-codex-beta-features") ?? "", /remote_compaction_v2/);
	assert.equal(result.compaction.firstKeptEntryId, branch[1]!.id);
	assert.equal(result.compaction.details.replacementHistory.at(-1)?.type, "compaction");
});

test("a capture from a different leaf falls back to a full rebuild", async () => {
	const remoteCalls: Array<Record<string, unknown>> = [];
	const { pi, emit } = harness();
	registerCodexCompactionExtension(pi, "0.85.1", {
		remote: async (params) => {
			remoteCalls.push(params.body);
			return { compactionItem: { type: "compaction", encrypted_content: "enc" } };
		},
	});
	let branch: SessionEntry[] = [userEntry("hello")];
	const ctx = context(() => branch);
	await emit("before_provider_request", { payload: livePayload() }, ctx);

	branch = [userEntry("a different conversation", null), assistantEntry({ text: "ok" })];
	await emit(
		"session_before_compact",
		{ branchEntries: branch, reason: "manual", willRetry: false, signal: new AbortController().signal, preparation: { firstKeptEntryId: branch[0]!.id, tokensBefore: 10 } },
		ctx,
	);
	assert.equal(remoteCalls.length, 1);
	const body = remoteCalls[0]!;
	assert.equal(body.instructions, "CURRENT SYSTEM");
	assert.deepEqual(kinds(body.input as ResponseItem[]), ["user", "message", "compaction_trigger"]);
	assert.equal((body.tools as Array<{ name: string }>)[0]?.name, "read");
});
