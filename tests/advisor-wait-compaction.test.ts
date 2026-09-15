import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	KILLED_AGENT_EVENT,
	WAIT_COMPACTION_ENTRY,
	outstandingDetachedRuns,
	planWaitCompaction,
	registerWaitCompaction,
	waitCompactionSettings,
	type WaitCompactionSettings,
} from "../extensions/advisor-core/wait-compaction.ts";

const T0 = Date.parse("2026-09-15T12:00:00.000Z");
let seq = 0;
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
// SAFETY: fixtures carry only the fields the scanner reads; SessionEntry is the host's wider union.
const toolResult = (toolName: string, details: Record<string, unknown>, offsetMs = 0): SessionEntry =>
	({ type: "message", id: `e${++seq}`, parentId: null, timestamp: iso(offsetMs), message: { role: "toolResult", toolName, toolCallId: `c${seq}`, content: [], details, timestamp: T0 + offsetMs } }) as unknown as SessionEntry;
const custom = (customType: string, details: Record<string, unknown>, offsetMs = 0): SessionEntry =>
	({ type: "custom_message", id: `e${++seq}`, parentId: null, timestamp: iso(offsetMs), customType, content: "notice", display: true, details }) as unknown as SessionEntry;
const launch = (runId: string, tool = "bg_agent", offsetMs = 0) => toolResult(tool, { runId, promoted: true, status: "running" }, offsetMs);

const settings: WaitCompactionSettings = { ...waitCompactionSettings({}), minContextTokens: 100_000 };

test("outstanding runs: promoted launches minus settles, stops, runtime deliveries, kills, and stale launches", () => {
	const branch = [
		launch("a"),
		launch("b", "bg_run"),
		launch("c", "bg_await"),
		launch("d"),
		launch("e"),
		launch("f"),
		toolResult("bg_run", { runId: "inline", promoted: false, status: "exited" }),
		toolResult("bg_watch", { runId: "watch", command: "npm run dev" }),
		custom("detach_finished", { id: "b", kind: "run", status: "exited", promoted: true }),
		custom("detach_agent_settled", { id: "a", kind: "agent", status: "exited", promoted: true }),
		custom("pi-detach-runtime", { runId: "c", deliveryId: "d1", result: {} }),
		toolResult("bg_stop", { runId: "d", stopped: true }),
		custom("detach_agent_paused", { id: "e", kind: "agent" }),
	];
	assert.deepEqual(outstandingDetachedRuns(branch, { now: T0 }), ["f"]);
	assert.deepEqual(outstandingDetachedRuns(branch, { now: T0, killed: new Set(["f"]) }), []);
	assert.deepEqual(outstandingDetachedRuns(branch, { now: T0 + 13 * 60 * 60 * 1000 }), [], "launches older than the age cap are not waited on");

	const relaunched = [launch("a"), custom("detach_agent_settled", { id: "a" }), launch("a", "bg_agent", 1000)];
	assert.deepEqual(outstandingDetachedRuns(relaunched, { now: T0 + 1000 }), ["a"], "a reused agent launched again after settling is outstanding again");
	assert.deepEqual(outstandingDetachedRuns([], { now: T0 }), []);
});

test("planWaitCompaction gates on toggle, provider, outstanding work, idleness, and context size", () => {
	const base = { settings, provider: "openai-codex", contextTokens: 180_000, outstanding: ["a"], idle: true, pending: false };
	assert.equal(planWaitCompaction(base).compact, true);
	assert.match(planWaitCompaction(base).reason, /1 detached run\(s\) outstanding at 180000 tokens/);
	assert.equal(planWaitCompaction({ ...base, settings: { ...settings, enabled: false } }).compact, false);
	assert.equal(planWaitCompaction({ ...base, provider: "claude-bridge" }).compact, false);
	assert.equal(planWaitCompaction({ ...base, provider: undefined }).compact, false);
	assert.equal(planWaitCompaction({ ...base, outstanding: [] }).compact, false);
	assert.equal(planWaitCompaction({ ...base, idle: false }).compact, false);
	assert.equal(planWaitCompaction({ ...base, pending: true }).compact, false);
	assert.equal(planWaitCompaction({ ...base, contextTokens: null }).compact, false);
	assert.equal(planWaitCompaction({ ...base, contextTokens: 99_999 }).compact, false);
	assert.equal(planWaitCompaction({ ...base, contextTokens: 100_000 }).compact, true);
});

test("settings come from the environment with safe defaults", () => {
	const defaults = waitCompactionSettings({});
	assert.equal(defaults.enabled, true);
	assert.equal(defaults.minContextTokens, 120_000);
	assert.deepEqual([...defaults.providers], ["openai-codex"]);
	assert.equal(waitCompactionSettings({ ADVISOR_WAIT_COMPACTION: "off" }).enabled, false);
	assert.equal(waitCompactionSettings({ ADVISOR_WAIT_COMPACTION: "0" }).enabled, false);
	assert.equal(waitCompactionSettings({ ADVISOR_WAIT_COMPACTION_MIN_TOKENS: "50000" }).minContextTokens, 50_000);
	assert.equal(waitCompactionSettings({ ADVISOR_WAIT_COMPACTION_MIN_TOKENS: "nope" }).minContextTokens, 120_000);
});

function harness(options: { branch: () => SessionEntry[]; tokens: () => number | null; provider?: string; root?: boolean }) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const events = new EventEmitter();
	const entries: Array<{ type: string; data: unknown }> = [];
	const compactions: Array<{ onComplete?: () => void; onError?: (error: Error) => void }> = [];
	// SAFETY: the registration touches only these ExtensionAPI members.
	const pi = {
		on(name: string, fn: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		events,
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	} as unknown as ExtensionAPI;
	// SAFETY: the settle handler reads only these context members.
	const ctx = {
		hasUI: false,
		model: { provider: options.provider ?? "openai-codex" },
		sessionManager: { getBranch: options.branch },
		getContextUsage: () => ({ tokens: options.tokens(), contextWindow: 272_000, percent: null }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify() {} },
		compact(compactOptions: { onComplete?: () => void; onError?: (error: Error) => void }) {
			compactions.push(compactOptions);
		},
	} as unknown as ExtensionContext;
	registerWaitCompaction(pi, { isAdvisorRoot: () => options.root ?? true, settings, now: () => T0 });
	return {
		entries,
		compactions,
		events,
		async settle() {
			for (const fn of handlers.get("agent_settled") ?? []) await fn({ type: "agent_settled" }, ctx);
		},
	};
}

test("a root advisor idling with outstanding work compacts once, records the decision, and waits for completion", async () => {
	const branch: SessionEntry[] = [launch("a"), launch("b")];
	const h = harness({ branch: () => branch, tokens: () => 210_000 });
	await h.settle();
	assert.equal(h.compactions.length, 1);
	assert.deepEqual(h.entries, [{ type: WAIT_COMPACTION_ENTRY, data: { reason: "2 detached run(s) outstanding at 210000 tokens", outstanding: ["a", "b"], contextTokens: 210_000 } }]);

	await h.settle();
	assert.equal(h.compactions.length, 1, "no second compaction while one is in flight");

	h.compactions[0]!.onComplete?.();
	branch.push(custom("detach_agent_settled", { id: "a" }), custom("detach_agent_settled", { id: "b" }));
	await h.settle();
	assert.equal(h.compactions.length, 1, "nothing outstanding after both settle messages");
});

test("workers, other providers, small contexts, and killed agents never trigger a wait compaction", async () => {
	const branch = [launch("a")];
	const worker = harness({ branch: () => branch, tokens: () => 210_000, root: false });
	await worker.settle();
	assert.equal(worker.compactions.length, 0);

	const claude = harness({ branch: () => branch, tokens: () => 210_000, provider: "claude-bridge" });
	await claude.settle();
	assert.equal(claude.compactions.length, 0);

	const small = harness({ branch: () => branch, tokens: () => 60_000 });
	await small.settle();
	assert.equal(small.compactions.length, 0);

	const killed = harness({ branch: () => branch, tokens: () => 210_000 });
	killed.events.emit(KILLED_AGENT_EVENT, { v: 1, id: "a", kind: "agent", status: "killed" });
	await killed.settle();
	assert.equal(killed.compactions.length, 0, "a killed agent is not waited on");
});
