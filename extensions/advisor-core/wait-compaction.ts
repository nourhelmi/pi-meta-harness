import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Compact-before-wait.
 *
 * A root advisor spends most of its life idle, waiting for detached workers. The
 * wake-up usually lands after the provider's prompt cache has expired, so the first
 * request after it re-bills the entire context. Compacting at the moment the advisor
 * goes idle costs cached reads plus a short summary (the compaction request replays the
 * live prefix), and the wake-up then re-bills only the compacted context.
 *
 * "Waiting" is derived from the session branch itself, not from an instruction: a
 * detached launch is a `bg_agent` / `bg_run` / `bg_await` tool result with
 * `promoted: true`; it settles when pi-detach delivers its completion message, when a
 * managed runtime delivery names the run, when `bg_stop` confirms a stop, or when the
 * runtime reports the agent killed. Everything is recomputed from the branch on each
 * settle, so a resumed session reaches the same answer as a live one.
 */

/** Custom message types pi-detach delivers when detached work settles (pi-detach notify.ts). */
const DETACH_SETTLED_TYPES: ReadonlySet<string> = new Set(["detach_finished", "detach_agent_settled", "detach_agent_paused"]);
/** Managed runtime completion delivery; its details name the run id. */
const RUNTIME_DELIVERY_TYPE = "pi-detach-runtime";
/** Tools whose promoted results mean a wake-up is coming later. */
const LAUNCH_TOOLS: ReadonlySet<string> = new Set(["bg_agent", "bg_run", "bg_await"]);
/** Shared-bus signal pi-detach emits for killed agents; they never produce a message. */
export const KILLED_AGENT_EVENT = "pi-detach:agent-settled";
/** Session entry recorded when a wait compaction is requested. */
export const WAIT_COMPACTION_ENTRY = "advisor-wait-compaction";

const DEFAULT_MIN_CONTEXT_TOKENS = 120_000;
/** Launches older than this without a settle message are treated as lost, not outstanding. */
const DEFAULT_MAX_RUN_AGE_MS = 12 * 60 * 60 * 1000;
/** Providers whose compaction request shares the conversation's prompt cache. */
const CACHED_COMPACTION_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex"]);

export interface WaitCompactionSettings {
	enabled: boolean;
	minContextTokens: number;
	providers: ReadonlySet<string>;
	maxRunAgeMs: number;
}

export function waitCompactionSettings(env: NodeJS.ProcessEnv = process.env): WaitCompactionSettings {
	const toggle = env.ADVISOR_WAIT_COMPACTION?.trim().toLowerCase();
	const minimum = Number(env.ADVISOR_WAIT_COMPACTION_MIN_TOKENS);
	return {
		enabled: toggle !== "off" && toggle !== "0" && toggle !== "false",
		minContextTokens: Number.isFinite(minimum) && minimum > 0 ? Math.floor(minimum) : DEFAULT_MIN_CONTEXT_TOKENS,
		providers: CACHED_COMPACTION_PROVIDERS,
		maxRunAgeMs: DEFAULT_MAX_RUN_AGE_MS,
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface OutstandingRunsOptions {
	now?: number;
	maxRunAgeMs?: number;
	/** Run ids reported killed on the shared bus; they never get a settle message. */
	killed?: ReadonlySet<string>;
}

/** Detached runs launched on this branch that have not settled, been stopped, or been killed. */
export function outstandingDetachedRuns(branch: readonly SessionEntry[], options: OutstandingRunsOptions = {}): string[] {
	const now = options.now ?? Date.now();
	const maxRunAgeMs = options.maxRunAgeMs ?? DEFAULT_MAX_RUN_AGE_MS;
	const launchedAt = new Map<string, number>();
	// Kills arrive on the bus with no branch position, so they are applied after the scan:
	// a launch entry must not be able to "un-settle" a run the runtime already reported killed.
	const killed = options.killed ?? new Set<string>();
	const settled = new Set<string>();
	const settle = (runId: string | undefined) => {
		if (runId) settled.add(runId);
	};
	for (const entry of branch) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role !== "toolResult") continue;
			const details = asRecord(message.details);
			const runId = stringField(details, "runId");
			if (!runId) continue;
			if (LAUNCH_TOOLS.has(message.toolName)) {
				if (details?.promoted === true) {
					launchedAt.set(runId, Date.parse(entry.timestamp));
					settled.delete(runId);
				} else {
					settle(runId);
				}
			} else if (message.toolName === "bg_stop" && details?.stopped === true) {
				settle(runId);
			}
			continue;
		}
		if (entry.type === "custom_message") {
			const details = asRecord(entry.details);
			if (DETACH_SETTLED_TYPES.has(entry.customType)) settle(stringField(details, "id") ?? stringField(details, "runId"));
			else if (entry.customType === RUNTIME_DELIVERY_TYPE) settle(stringField(details, "runId"));
		}
	}
	return [...launchedAt]
		.filter(([runId, at]) => !settled.has(runId) && !killed.has(runId) && (!Number.isFinite(at) || now - at <= maxRunAgeMs))
		.map(([runId]) => runId);
}

export interface WaitCompactionInput {
	settings: WaitCompactionSettings;
	provider: string | undefined;
	contextTokens: number | null;
	outstanding: readonly string[];
	idle: boolean;
	pending: boolean;
}

export interface WaitCompactionDecision {
	compact: boolean;
	reason: string;
}

export function planWaitCompaction(input: WaitCompactionInput): WaitCompactionDecision {
	const { settings } = input;
	if (!settings.enabled) return { compact: false, reason: "disabled by ADVISOR_WAIT_COMPACTION" };
	if (!input.provider || !settings.providers.has(input.provider)) {
		return { compact: false, reason: `provider ${input.provider ?? "unknown"} does not share the prompt cache on compaction` };
	}
	if (input.outstanding.length === 0) return { compact: false, reason: "no detached work outstanding" };
	if (!input.idle || input.pending) return { compact: false, reason: "session is not idle" };
	if (input.contextTokens === null) return { compact: false, reason: "context size unknown" };
	if (input.contextTokens < settings.minContextTokens) {
		return { compact: false, reason: `context ${input.contextTokens} below ${settings.minContextTokens}` };
	}
	return {
		compact: true,
		reason: `${input.outstanding.length} detached run(s) outstanding at ${input.contextTokens} tokens`,
	};
}

export interface WaitCompactionDeps {
	/** True only for a root advisor session; workers and ordinary sessions never compact this way. */
	isAdvisorRoot: () => boolean;
	settings?: WaitCompactionSettings;
	now?: () => number;
}

export function registerWaitCompaction(pi: ExtensionAPI, deps: WaitCompactionDeps): void {
	const settings = deps.settings ?? waitCompactionSettings();
	const now = deps.now ?? (() => Date.now());
	const killed = new Set<string>();
	let inFlight = false;

	// Hosts and test fakes may expose an events bus without `on`; the kill signal is best-effort.
	if (typeof pi.events?.on === "function") pi.events.on(KILLED_AGENT_EVENT, (signal: unknown) => {
		const record = asRecord(signal);
		const id = stringField(record, "id");
		if (id && record?.status === "killed") killed.add(id);
	});

	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
		if (inFlight || !deps.isAdvisorRoot() || typeof ctx.compact !== "function") return;
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		const outstanding = outstandingDetachedRuns(branch, { now: now(), maxRunAgeMs: settings.maxRunAgeMs, killed });
		const usage = ctx.getContextUsage();
		const decision = planWaitCompaction({
			settings,
			provider: ctx.model?.provider,
			contextTokens: usage?.tokens ?? null,
			outstanding,
			idle: ctx.isIdle(),
			pending: ctx.hasPendingMessages(),
		});
		if (!decision.compact) return;
		inFlight = true;
		pi.appendEntry(WAIT_COMPACTION_ENTRY, { reason: decision.reason, outstanding, contextTokens: usage?.tokens ?? null });
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Advisor is waiting on ${outstanding.length} detached run(s); compacting ${Math.round((usage?.tokens ?? 0) / 1000)}k tokens now so the wake-up stays cheap.`,
				"info",
			);
		}
		ctx.compact({
			onComplete: () => {
				inFlight = false;
			},
			onError: (error) => {
				inFlight = false;
				if (ctx.hasUI) ctx.ui.notify(`Wait compaction failed: ${error.message}`, "warning");
			},
		});
	});
}
