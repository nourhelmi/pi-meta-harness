import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorRuntimeExtension, { ADVISOR_RUNTIME_DESCRIPTOR_ENV } from "../extensions/advisor-runtime.ts";
import { AdvisorTraceStore } from "../extensions/advisor-core/trace-store.ts";
import { appendTrace } from "../scripts/advisor-core/host-binding.mjs";
import { AdvisorRuntime } from "../scripts/advisor-runtime/runtime.mjs";
import { startService, writeCredential } from "../scripts/advisor-runtime/service.mjs";

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: Record<string, unknown>;
}

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<ToolResult>;
}

type ToolCallHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown> | unknown;

function installExtension(descriptorPath?: string) {
	const tools: RegisteredTool[] = [];
	const handlers: ToolCallHandler[] = [];
	const prior = process.env[ADVISOR_RUNTIME_DESCRIPTOR_ENV];
	if (descriptorPath === undefined) delete process.env[ADVISOR_RUNTIME_DESCRIPTOR_ENV];
	else process.env[ADVISOR_RUNTIME_DESCRIPTOR_ENV] = descriptorPath;
	try {
		advisorRuntimeExtension({
			registerTool(tool: RegisteredTool) { tools.push(tool); },
			on(event: string, handler: ToolCallHandler) {
				if (event === "tool_call") handlers.push(handler);
			},
		} as unknown as ExtensionAPI);
	} finally {
		if (prior === undefined) delete process.env[ADVISOR_RUNTIME_DESCRIPTOR_ENV];
		else process.env[ADVISOR_RUNTIME_DESCRIPTOR_ENV] = prior;
	}
	return {
		tools,
		async preflight(toolName: string) {
			for (const handler of handlers) {
				const result = await handler({ toolName, toolCallId: `call-${toolName}`, input: {} }, {} as ExtensionContext);
				if (result) return result as { block?: boolean; reason?: string };
			}
			return undefined;
		},
	};
}

async function invoke(tool: RegisteredTool, request: Record<string, unknown>): Promise<Record<string, unknown>> {
	const result = await tool.execute("runtime-call", request, undefined, undefined, {} as ExtensionContext);
	assert.equal(result.content.length, 1);
	return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const resultMarkdown = "# Status\nPASS\n\n# Claims\nHermetic fixture.\n\n# Evidence\nActual adapter effect.\n\n# Files\nNone.\n\n# Decisions\nNone.\n\n# Remaining Risk\nNone.\n";
const rootScope = (run = "run", ownerEpoch = 1) => ({ workstream: "work", run, node: "root", ownerEpoch });

function mutation(op: string, commandId: string, expectedRevision: number, payload: Record<string, unknown>, scope = rootScope()) {
	return { v: 1, op, commandId, expectedRevision, scope, payload };
}

function readCommand(op: string, payload: Record<string, unknown> = {}, scope = rootScope()) {
	return { v: 1, op, scope, payload };
}

async function ackAll(tool: RegisteredTool): Promise<void> {
	const waited = await invoke(tool, readCommand("wait", { timeoutMs: 0, limit: 128 }));
	assert.equal(waited.ok, true);
	for (const delivery of waited.value as Array<{ id: number }>) {
		const progress = await invoke(tool, readCommand("progress"));
		const revision = (progress.value as { revision: number }).revision;
		const acknowledged = await invoke(tool, mutation("delivery.ack", `ack-${delivery.id}`, revision, { deliveryId: delivery.id }));
		assert.equal(acknowledged.ok, true);
	}
}

test("actual Pi extension transport admits before one effect, replays exactly, and safely denies bad authority", { timeout: 20_000 }, async (t) => {
	const base = realpathSync(mkdtempSync("/private/tmp/advisor-pi-runtime-"));
	const state = join(base, "state");
	const work = join(base, "work");
	mkdirSync(work, { mode: 0o700 });
	let effectCount = 0;
	let receiptVisibleBeforeEffect = false;
	const runtime = new AdvisorRuntime({
		stateRoot: state,
		allowedRoots: [work],
		adapters: {
			roots: {},
			workers: {
				fixture: {
					capabilities: { "node.launch": true },
					async execute({ effect, context, recordHandle, emit }: any) {
						effectCount += 1;
						const db = new DatabaseSync(join(state, "runtime.sqlite"), { readOnly: true });
						try {
							receiptVisibleBeforeEffect = Boolean(db.prepare("SELECT id FROM receipts WHERE id=?").get(effect.commandId));
						} finally {
							db.close();
						}
						recordHandle({ id: "fixture-owned-session" });
						writeFileSync(context.resultPath, resultMarkdown, { mode: 0o600 });
						emit({ id: "fixture-settled", kind: "settled", attempt: effect.attempt, data: { status: "done", reason: "fixture complete", verified: false } });
						return { accepted: true };
					},
				},
			},
		},
	});
	let serviceClosed = false;
	const service = await startService(runtime, { keepAlive: false });
	t.after(async () => {
		if (!serviceClosed) {
			try { await service.close(); } catch { /* assertion failures can leave admitted work */ }
		}
		rmSync(base, { recursive: true, force: true });
	});

	const operations = ["workstream.create", "packet.admit", "graph.admit", "wave.launch", "progress", "wait", "delivery.ack"];
	const scopes = [{ workstream: "work", run: "run", node: "root" }, { workstream: "work", run: "run", node: "maker" }];
	const token = runtime.registerPrincipal({ id: "pi-advisor", kind: "advisor", scopes, operations });
	const descriptor = join(base, "pi-advisor.json");
	writeCredential(descriptor, { socketPath: service.socketPath, token }, runtime);
	const installed = installExtension(descriptor);
	assert.deepEqual(installed.tools.map((tool) => tool.name), ["advisor_runtime"]);
	const tool = installed.tools[0];

	assert.equal((await invoke(tool, mutation("workstream.create", "create-run", 0, { cwd: work, host: "pi" }))).ok, true);
	assert.equal((await invoke(tool, mutation("packet.admit", "admit-maker", 1, {
		node: "maker",
		packet: { role: "builder", task: "Hermetic task", acceptance: ["One effect"], riskTier: "high", cwd: work, adapter: "fixture", model: "fixture-model", thinking: "off" },
	}))).ok, true);
	assert.equal((await invoke(tool, mutation("graph.admit", "admit-graph", 2, {
		graph: "graph", waves: [["maker"]], dependencies: { maker: [] }, topology: "flat-root", maxParallel: 1, maxRepairLoops: 0,
	}))).ok, true);
	const launch = mutation("wave.launch", "launch-wave", 3, { wave: 1 });
	assert.equal((await invoke(tool, launch)).ok, true);
	await runtime.dispatch();
	const replay = await invoke(tool, launch);
	assert.equal(replay.ok, true);
	assert.equal(replay.replayed, true);
	assert.equal(receiptVisibleBeforeEffect, true);
	assert.equal(effectCount, 1);

	const secondToken = runtime.registerPrincipal({ id: "other-advisor", kind: "advisor", scopes, operations });
	const secondDescriptor = join(base, "other.json");
	writeCredential(secondDescriptor, { socketPath: service.socketPath, token: secondToken }, runtime);
	const wrongPrincipal = await invoke(installExtension(secondDescriptor).tools[0], launch);
	assert.deepEqual(wrongPrincipal, { ok: false, error: "PRINCIPAL_MISMATCH" });

	const revokedToken = runtime.registerPrincipal({ id: "revoked-advisor", kind: "advisor", scopes, operations });
	const revokedDescriptor = join(base, "revoked.json");
	writeCredential(revokedDescriptor, { socketPath: service.socketPath, token: revokedToken }, runtime);
	runtime.revokePrincipal("revoked-advisor");
	assert.deepEqual(await invoke(installExtension(revokedDescriptor).tools[0], readCommand("progress")), { ok: false, error: "UNAUTHORIZED" });
	const stalePacket = { role: "builder", task: "x", acceptance: ["x"], riskTier: "high", cwd: work, adapter: "fixture", model: "m", thinking: "off" };
	assert.deepEqual(await invoke(tool, mutation("packet.admit", "ungranted-command", 0, { node: "other", packet: stalePacket })), { ok: false, error: "TARGET_SCOPE_FORBIDDEN" });
	assert.deepEqual(await invoke(tool, mutation("packet.admit", "stale-command", 0, { node: "maker", packet: stalePacket })), { ok: false, error: "STALE_REVISION" });
	assert.deepEqual(await invoke(tool, readCommand("progress", {}, rootScope("wrong-run"))), { ok: false, error: "SCOPE_FORBIDDEN" });
	assert.deepEqual(await invoke(tool, readCommand("progress", {}, rootScope("run", 2))), { ok: false, error: "OWNER_EPOCH_MISMATCH" });

	const serializedDenials = JSON.stringify([wrongPrincipal, replay]);
	for (const secret of [token, secondToken, revokedToken, descriptor, service.socketPath]) assert.equal(serializedDenials.includes(secret), false);
	await ackAll(tool);
	await service.close();
	serviceClosed = true;
});

test("Pi opt-in blocks legacy effects before execution, fails closed on malformed credentials, and default mode stays legacy", async (t) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "advisor-pi-fence-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const malformed = join(base, "malformed.json");
	writeFileSync(malformed, "not-json", { mode: 0o600 });
	const optedIn = installExtension(malformed);
	assert.equal(optedIn.tools.length, 1);
	let legacyEffects = 0;
	for (const name of ["bg_agent", "bg_stop"]) {
		const decision = await optedIn.preflight(name);
		if (!decision?.block) legacyEffects += 1;
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /advisor_runtime/);
	}
	assert.equal(legacyEffects, 0);
	const unavailable = await invoke(optedIn.tools[0], readCommand("progress"));
	assert.deepEqual(unavailable, { ok: false, error: "ADVISOR_RUNTIME_UNAVAILABLE" });
	assert.equal(JSON.stringify(unavailable).includes(malformed), false);

	const legacy = installExtension();
	assert.equal(legacy.tools.length, 0);
	for (const name of ["bg_agent", "bg_stop"]) {
		const decision = await legacy.preflight(name);
		if (!decision?.block) legacyEffects += 1;
	}
	assert.equal(legacyEffects, 2);
});

test("actual Pi and native appenders share persistent legacy ownership and reject runtime-owned runs", async (t) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "advisor-writer-fence-")));
	const root = join(base, "state");
	const work = join(base, "work");
	mkdirSync(work, { mode: 0o700 });
	t.after(() => rmSync(base, { recursive: true, force: true }));

	const runtime = new AdvisorRuntime({ stateRoot: root, allowedRoots: [work] });
	const runtimeToken = runtime.registerPrincipal({
		id: "runtime-owner",
		kind: "operator",
		scopes: [{ workstream: "work", run: "runtime-run", node: "root" }],
		operations: ["workstream.create"],
	});
	assert.equal(runtime.execute(runtimeToken, mutation("workstream.create", "create-runtime", 0, { cwd: work, host: "pi" }, rootScope("runtime-run"))).ok, true);
	const piStore = new AdvisorTraceStore(root);
	await assert.rejects(piStore.update("runtime-run", () => [{ node: null, parent: null, type: "run.created", data: { workstream: "work", root: { node: "root", session: "legacy" } } }]), /RUN_OWNED/);
	await assert.rejects(appendTrace(root, "runtime-run", "codex", () => [{ node: "maker", parent: "root", type: "node.progress", data: { note: "forbidden" } }]), /RUN_OWNED/);
	runtime.close();

	await piStore.update("legacy-run", () => [
		{ node: null, parent: null, type: "run.created", data: { workstream: "work", stateRoot: root, root: { node: "root", session: "legacy-root" } } },
		{ node: "maker", parent: "root", type: "node.launched", data: { role: "builder", label: "maker", harness: "pi", model: "fixture", thinking: "off", cwd: work, riskTier: "high", acceptance: ["ordered"] } },
	]);
	const appends: Array<Promise<unknown>> = [];
	for (let index = 0; index < 10; index += 1) {
		appends.push(piStore.update("legacy-run", () => [{ node: "maker", parent: "root", type: "node.progress", data: { note: `pi-${index}` } }]));
		appends.push(appendTrace(root, "legacy-run", "codex", () => [{ node: "maker", parent: "root", type: "node.progress", data: { note: `native-${index}` } }]));
	}
	await Promise.all(appends);
	const restartedPiStore = new AdvisorTraceStore(root);
	await restartedPiStore.update("legacy-run", () => [{ node: "maker", parent: "root", type: "node.progress", data: { note: "pi-restarted" } }]);
	await appendTrace(root, "legacy-run", "claude-code", () => [{ node: "maker", parent: "root", type: "node.progress", data: { note: "native-restarted" } }]);

	const events = readFileSync(join(root, "traces", "legacy-run.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { seq: number; at: string });
	assert.equal(events.length, 24);
	assert.deepEqual(events.map((event) => event.seq), Array.from({ length: events.length }, (_, index) => index + 1));
	assert.ok(events.every((event, index) => index === 0 || Date.parse(event.at) >= Date.parse(events[index - 1].at)));
	assert.deepEqual(JSON.parse(readFileSync(join(root, "ownership", "legacy-run.json"), "utf8")), { kind: "legacy", owner: "legacy" });

	writeFileSync(join(root, "traces", "raw-legacy.jsonl"), "legacy trace\n", { mode: 0o600 });
	const restartedRuntime = new AdvisorRuntime({ stateRoot: root, allowedRoots: [work] });
	const refusalToken = restartedRuntime.registerPrincipal({
		id: "runtime-refusal",
		kind: "operator",
		scopes: [
			{ workstream: "work", run: "legacy-run", node: "root" },
			{ workstream: "work", run: "raw-legacy", node: "root" },
		],
		operations: ["workstream.create"],
	});
	assert.deepEqual(restartedRuntime.execute(refusalToken, mutation("workstream.create", "adopt-marked", 0, { cwd: work, host: "pi" }, rootScope("legacy-run"))), { ok: false, error: "RUN_OWNED" });
	assert.deepEqual(restartedRuntime.execute(refusalToken, mutation("workstream.create", "adopt-raw", 0, { cwd: work, host: "pi" }, rootScope("raw-legacy"))), { ok: false, error: "LEGACY_TRACE" });
	restartedRuntime.close();
});
