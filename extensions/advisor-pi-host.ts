import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	advisorStateRoot,
	restoredState,
	type AdvisorSessionState,
} from "./advisor-core/advisor-state.ts";
import {
	type ResultArtifactValidation,
	resultStatusBody,
	validateResultArtifact,
} from "./advisor-core/result-artifact.ts";
import {
	AdvisorTraceStore,
	type CanonicalEvent,
	type CanonicalEventDraft,
	nextWakeGeneration,
} from "./advisor-core/trace-store.ts";

interface BgAgentInput {
	prompt?: unknown;
	role?: unknown;
	model?: unknown;
	thinking?: unknown;
	anchor?: unknown;
	acceptance?: unknown;
	name?: unknown;
	keepAlive?: unknown;
	cwd?: unknown;
	label?: unknown;
}

interface BgAgentDetails {
	runId?: unknown;
	promoted?: unknown;
	status?: unknown;
	agentState?: unknown;
	agentName?: unknown;
	paneId?: unknown;
	role?: unknown;
	runtime?: unknown;
	provider?: unknown;
	model?: unknown;
	thinking?: unknown;
	resultPath?: unknown;
	resultStatus?: unknown;
	reusable?: unknown;
	settlementNote?: unknown;
}

interface RunRecordDetails {
	id?: unknown;
	status?: unknown;
	agentState?: unknown;
	agentName?: unknown;
	paneId?: unknown;
	resultPath?: unknown;
	resultStatus?: unknown;
	settlementNote?: unknown;
	closeOnSettle?: unknown;
}

type Harness = "pi" | "codex" | "claude-code";
type SettledStatus = "done" | "blocked" | "failed" | "stalled" | "cancelled";

interface HarnessIdentity {
	harness: Harness;
	model: string;
	thinking: string;
}

interface Binding {
	state: AdvisorSessionState;
	root: string;
	store: AdvisorTraceStore;
}

interface PendingLaunch {
	binding: Binding;
	cwd: string;
	input: BgAgentInput;
}

interface Settlement {
	runId: string;
	status?: string;
	agentState?: string;
	agentName?: string;
	paneId?: string;
	resultPath?: string;
	resultStatus?: string;
	settlementNote?: string;
	closeOnSettle?: boolean;
	reusable?: boolean;
	tail: string;
}

interface ArtifactInspection {
	present: boolean;
	path?: string;
	validation: ResultArtifactValidation;
	statusBody?: string;
}

const ROOT_NODE = "advisor";

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function mapRuntime(value: unknown): Harness | undefined {
	switch (stringValue(value)) {
		case "pi":
			return "pi";
		case "codex":
			return "codex";
		case "claude":
			return "claude-code";
		default:
			return undefined;
	}
}

function launchModel(input: BgAgentInput, details: BgAgentDetails): string {
	const requested = stringValue(input.model);
	if (requested) return requested;
	const provider = stringValue(details.provider);
	const model = stringValue(details.model);
	return provider && model ? `${provider}/${model}` : model ?? "unresolved";
}

function launchThinking(input: BgAgentInput, details: BgAgentDetails): string {
	return stringValue(input.thinking) ?? stringValue(details.thinking) ?? "unresolved";
}

function launchRole(input: BgAgentInput, details: BgAgentDetails): string {
	return stringValue(details.role) ?? stringValue(input.role) ?? "freeform";
}

function launchLabel(input: BgAgentInput, role: string): string {
	const requested = stringValue(input.label)?.replace(/\s+/g, " ");
	if (requested) {
		const escapedRole = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (role === "freeform" || new RegExp(`^${escapedRole}(?:$|[\\s·:—-])`, "i").test(requested)) {
			return requested;
		}
		return `${role} · ${requested}`;
	}
	return stringValue(input.name) ?? `${role} · ${stringValue(input.prompt)?.slice(0, 48) ?? "task"}`;
}

function launchAcceptance(input: BgAgentInput): string[] {
	const acceptance = Array.isArray(input.acceptance)
		? input.acceptance.map(stringValue).filter((value): value is string => Boolean(value))
		: [];
	const anchor = stringValue(input.anchor);
	if (anchor) acceptance.push(anchor);
	if (acceptance.length > 0) return acceptance;
	return [stringValue(input.prompt) ?? "Complete the supervised bg_agent launch."];
}

function riskTier(prompt: string | undefined): "low" | "standard" | "high" {
	const match = prompt?.match(/\brisk\s+tier\b[\s:*_`-]*(low|standard|high)\b/i)?.[1]?.toLowerCase();
	return match === "low" || match === "standard" || match === "high" ? match : "high";
}

function eventText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			return stringValue((part as { text?: unknown }).text) ?? "";
		})
		.filter(Boolean)
		.join("\n");
}

function settlementNote(details: BgAgentDetails, tail: string): string | undefined {
	const explicit = stringValue(details.settlementNote);
	if (explicit) return explicit;
	const notes = [...tail.matchAll(/^\[detach\]\s+(.+)$/gm)];
	return notes.at(-1)?.[1]?.trim() || undefined;
}

function runSettlement(details: BgAgentDetails, tail: string): Settlement | undefined {
	const runId = stringValue(details.runId);
	if (!runId) return undefined;
	return {
		runId,
		...(stringValue(details.status) ? { status: stringValue(details.status) } : {}),
		...(stringValue(details.agentState) ? { agentState: stringValue(details.agentState) } : {}),
		...(stringValue(details.agentName) ? { agentName: stringValue(details.agentName) } : {}),
		...(stringValue(details.paneId) ? { paneId: stringValue(details.paneId) } : {}),
		...(stringValue(details.resultPath) ? { resultPath: stringValue(details.resultPath) } : {}),
		...(stringValue(details.resultStatus) ? { resultStatus: stringValue(details.resultStatus) } : {}),
		...(settlementNote(details, tail) ? { settlementNote: settlementNote(details, tail) } : {}),
		...(boolValue(details.reusable) !== undefined ? { reusable: boolValue(details.reusable) } : {}),
		tail,
	};
}

function messageSettlement(details: RunRecordDetails, tail: string): Settlement | undefined {
	const runId = stringValue(details.id);
	if (!runId) return undefined;
	return {
		runId,
		...(stringValue(details.status) ? { status: stringValue(details.status) } : {}),
		...(stringValue(details.agentState) ? { agentState: stringValue(details.agentState) } : {}),
		...(stringValue(details.agentName) ? { agentName: stringValue(details.agentName) } : {}),
		...(stringValue(details.paneId) ? { paneId: stringValue(details.paneId) } : {}),
		...(stringValue(details.resultPath) ? { resultPath: stringValue(details.resultPath) } : {}),
		...(stringValue(details.resultStatus) ? { resultStatus: stringValue(details.resultStatus) } : {}),
		...(stringValue(details.settlementNote) ? { settlementNote: stringValue(details.settlementNote) } : {}),
		...(boolValue(details.closeOnSettle) !== undefined ? { closeOnSettle: boolValue(details.closeOnSettle) } : {}),
		tail,
	};
}

async function inspectArtifact(path: string | undefined): Promise<ArtifactInspection> {
	if (!path) {
		return {
			present: false,
			validation: {
				valid: false,
				classification: "terminal",
				problems: ["result artifact path is missing"],
				notes: [],
			},
		};
	}
	let markdown: string;
	try {
		markdown = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const problem = code === "ENOENT" ? "result artifact is missing" : `result artifact could not be read: ${(error as Error).message}`;
		return {
			present: false,
			path,
			validation: {
				valid: false,
				classification: "terminal",
				problems: [problem],
				notes: [],
			},
		};
	}
	if (!markdown.trim()) {
		return {
			present: false,
			path,
			validation: {
				valid: false,
				classification: "terminal",
				problems: ["result artifact is empty"],
				notes: [],
			},
		};
	}
	return {
		present: true,
		path,
		validation: validateResultArtifact(markdown),
		statusBody: resultStatusBody(markdown),
	};
}

function nativeSettlement(settlement: Settlement): SettledStatus {
	if (settlement.status === "killed") return "cancelled";
	switch (settlement.agentState) {
		case "done":
		case "idle":
			return "done";
		case "blocked":
			return "blocked";
		case "stalled":
			return "stalled";
		default:
			return "failed";
	}
}

function blockedKind(text: string): "decision" | "permission" | "credential" | "external-action" {
	if (/\bcredential(?:s)?\b|\bapi[ -]?key\b|\bpassword\b|\bsecret\b|\bauth(?:entication)? token\b/i.test(text)) {
		return "credential";
	}
	if (/\bpermission\b|\bauthori[sz](?:e|ation)\b|\bapproval\b|\baccess grant\b/i.test(text)) {
		return "permission";
	}
	if (/\bexternal action\b|\bdeploy\b|\bpublish\b|\bpush\b|\bsend\b.+\b(message|email)\b/i.test(text)) {
		return "external-action";
	}
	return "decision";
}

function surfaceClosed(settlement: Settlement): boolean | undefined {
	const successful = settlement.agentState === "done" || settlement.agentState === "idle";
	if (settlement.closeOnSettle !== undefined) return successful ? settlement.closeOnSettle : false;
	if (settlement.reusable !== undefined) return successful ? !settlement.reusable : false;
	return undefined;
}

function settlementReason(
	status: SettledStatus,
	nativeStatus: SettledStatus,
	settlement: Settlement,
	artifact: ArtifactInspection,
): string {
	if (settlement.settlementNote) return settlement.settlementNote;
	if (status === "stalled" && (nativeStatus === "done" || nativeStatus === "blocked")) {
		return `result artifact is invalid: ${artifact.validation.problems.join("; ")}`;
	}
	if (status === "cancelled") return "pi-detach run was killed";
	if (status === "failed") return settlement.settlementNote ?? "agent settled in an unknown state";
	if (status === "stalled") return settlement.settlementNote ?? "agent settled stalled";
	if (status === "blocked") return settlement.settlementNote ?? "agent settled blocked with a valid result artifact";
	return "agent settled done with a valid result artifact";
}

function stringRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function priorHarnessIdentity(event: CanonicalEvent): HarnessIdentity | undefined {
	if (event.type !== "node.launched") return undefined;
	const harness = event.data.harness;
	const model = event.data.model;
	const thinking = event.data.thinking;
	if (
		(harness === "pi" || harness === "codex" || harness === "claude-code") &&
		typeof model === "string" &&
		typeof thinking === "string"
	) {
		return { harness, model, thinking };
	}
	return undefined;
}

function findSessionHarnessIdentity(ctx: ExtensionContext, agentName: string): HarnessIdentity | undefined {
	for (const entry of ctx.sessionManager.getEntries().toReversed()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "bg_agent") {
			continue;
		}
		const details = (stringRecord(entry.message.details) ?? {}) as BgAgentDetails;
		if (stringValue(details.agentName) !== agentName) continue;
		const harness = mapRuntime(details.runtime);
		if (!harness) continue;
		return { harness, model: launchModel({}, details), thinking: launchThinking({}, details) };
	}
	return undefined;
}

async function findPersistedHarnessIdentity(root: string, agentName: string): Promise<HarnessIdentity | undefined> {
	let files: string[];
	try {
		files = await readdir(join(root, "traces"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let latest: { at: number; identity: HarnessIdentity } | undefined;
	for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
		const lines = (await readFile(join(root, "traces", file), "utf8")).split("\n").filter(Boolean);
		for (const line of lines) {
			let event: CanonicalEvent;
			try {
				event = JSON.parse(line) as CanonicalEvent;
			} catch {
				// A corrupt trace line must not break identity recovery for a live launch.
				continue;
			}
			const launchRef = stringRecord(event.data.launchRef);
			if (launchRef?.agentName !== agentName) continue;
			const identity = priorHarnessIdentity(event);
			if (!identity) continue;
			const at = Date.parse(event.at);
			if (!latest || at >= latest.at) latest = { at, identity };
		}
	}
	return latest?.identity;
}

function settlementDrafts(events: CanonicalEvent[], settlement: Settlement, artifact: ArtifactInspection): CanonicalEventDraft[] {
	const launch = events.find((event) => event.type === "node.launched");
	if (!launch || !launch.node || !launch.parent) return [];
	if (events.some((event) => event.type === "node.settled" && event.node === launch.node)) return [];

	const nativeStatus = nativeSettlement(settlement);
	const status = (nativeStatus === "done" || nativeStatus === "blocked") && !artifact.validation.valid
		? "stalled"
		: nativeStatus;
	const drafts: CanonicalEventDraft[] = [];
	if (nativeStatus === "blocked" && !events.some((event) => event.type === "node.blocked" && event.node === launch.node)) {
		const requestText = artifact.statusBody ?? settlement.settlementNote ??
			(settlement.tail.trim() || "Agent is blocked and needs a decision.");
		drafts.push({
			type: "node.blocked",
			node: launch.node,
			parent: launch.parent,
			data: { request: { kind: blockedKind(requestText), text: requestText } },
		});
	}
	if (artifact.present && artifact.path) {
		drafts.push({
			type: "node.result.written",
			node: launch.node,
			parent: launch.parent,
			data: { path: artifact.path },
		});
		drafts.push({
			type: "node.result.validated",
			node: launch.node,
			parent: launch.parent,
			data: {
				path: artifact.path,
				valid: artifact.validation.valid,
				problems: artifact.validation.valid ? artifact.validation.notes : artifact.validation.problems,
				...(artifact.validation.valid && artifact.validation.status ? { status: artifact.validation.status } : {}),
			},
		});
	}
	const closed = surfaceClosed(settlement);
	drafts.push({
		type: "node.settled",
		node: launch.node,
		parent: launch.parent,
		data: {
			status,
			reason: settlementReason(status, nativeStatus, settlement, artifact),
			...(artifact.validation.valid && artifact.validation.status ? { resultStatus: artifact.validation.status } : {}),
			...(closed !== undefined ? { surfaceClosed: closed } : {}),
		},
	});
	drafts.push({
		type: "parent.awakened",
		node: launch.parent,
		parent: null,
		data: {
			child: launch.node,
			childStatus: status,
			wakeGeneration: nextWakeGeneration(events, launch.parent),
			...(artifact.present && artifact.path ? { resultPath: artifact.path } : {}),
		},
	});
	return drafts;
}

export default function advisorPiHostExtension(pi: ExtensionAPI): void {
	const pending = new Map<string, PendingLaunch>();
	const earlySettlements = new Map<string, Settlement>();
	const stores = new Map<string, AdvisorTraceStore>();
	const identities = new Map<string, HarnessIdentity>();

	async function binding(ctx: ExtensionContext): Promise<Binding | undefined> {
		const state = await restoredState(ctx);
		if (!state) return undefined;
		const root = await advisorStateRoot(ctx.cwd);
		let store = stores.get(root);
		if (!store) {
			store = new AdvisorTraceStore(root);
			stores.set(root, store);
		}
		return { state, root, store };
	}

	async function settle(binding: Binding, settlement: Settlement): Promise<boolean> {
		let observedLaunch = false;
		await binding.store.update(settlement.runId, async (events) => {
			if (!events.some((event) => event.type === "node.launched")) return [];
			observedLaunch = true;
			const launch = events.find((event) => event.type === "node.launched");
			const launchPath = stringValue(launch?.data.resultPath);
			const artifact = await inspectArtifact(settlement.resultPath ?? launchPath);
			return settlementDrafts(events, settlement, artifact);
		});
		return observedLaunch;
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bg_agent") return;
		const active = await binding(ctx);
		if (!active) return;
		pending.set(event.toolCallId, {
			binding: active,
			cwd: ctx.cwd,
			input: { ...(event.input as BgAgentInput) },
		});
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bg_agent") return;
		const captured = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!captured) return;
		const details = (stringRecord(event.details) ?? {}) as BgAgentDetails;
		const runId = stringValue(details.runId);
		if (!runId) return;
		const input = captured.input;
		const agentName = stringValue(details.agentName);
		let identity: HarnessIdentity | undefined;
		const harness = mapRuntime(details.runtime);
		if (harness) {
			identity = { harness, model: launchModel(input, details), thinking: launchThinking(input, details) };
		} else if (details.runtime === "existing" && agentName) {
			identity = identities.get(`${captured.binding.root}\0${agentName}`) ??
				findSessionHarnessIdentity(ctx, agentName) ??
				(await findPersistedHarnessIdentity(captured.binding.root, agentName));
		}
		// A trace adapter must never break the advisor's tool pipeline: a launch whose
		// harness identity cannot be recovered is left untraced rather than thrown.
		if (!identity) return;

		const role = launchRole(input, details);
		const node = `${role}-${runId}`;
		const prompt = stringValue(input.prompt);
		const resultPath = stringValue(details.resultPath);
		const paneId = stringValue(details.paneId);
		await captured.binding.store.update(runId, (events) => {
			if (events.length > 0) return [];
			return [
				{
					type: "run.created",
					node: null,
					parent: null,
					data: {
						workstream: captured.binding.state.workstream,
						...(prompt ? { goal: prompt } : {}),
						stateRoot: captured.binding.root,
						root: { node: ROOT_NODE, session: captured.binding.state.sessionId },
					},
				},
				{
					type: "node.launched",
					node,
					parent: ROOT_NODE,
					data: {
						role,
						label: launchLabel(input, role),
						...identity,
						cwd: typeof input.cwd === "string" ? resolve(captured.cwd, input.cwd) : captured.cwd,
						riskTier: riskTier(prompt),
						acceptance: launchAcceptance(input),
						...(resultPath ? { resultPath } : {}),
						...(typeof input.keepAlive === "boolean" ? { keepAlive: input.keepAlive } : {}),
						launchRef: {
							detachRunId: runId,
							...(paneId ? { paneId } : {}),
							...(agentName ? { agentName } : {}),
						},
					},
				},
			];
		});
		if (agentName) identities.set(`${captured.binding.root}\0${agentName}`, identity);
		const early = earlySettlements.get(runId);
		if (early) {
			earlySettlements.delete(runId);
			await settle(captured.binding, early);
		} else if (details.promoted === false) {
			const inline = runSettlement(details, eventText(event.content));
			if (inline) await settle(captured.binding, inline);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "custom" || event.message.customType !== "detach_agent_settled") return;
		const active = await binding(ctx);
		if (!active) return;
		const details = (stringRecord(event.message.details) ?? {}) as RunRecordDetails;
		const settlement = messageSettlement(details, eventText(event.message.content));
		if (!settlement) return;
		const observedLaunch = await settle(active, settlement);
		if (!observedLaunch && pending.size > 0) earlySettlements.set(settlement.runId, settlement);
	});
}
