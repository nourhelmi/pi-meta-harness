import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENTRY_TYPE = "advisor-session";
const MAX_WORKSTREAM_LENGTH = 48;
const HEADLESS_AGENT_COMMAND =
	/(?:^|[;&|]\s*|\s)(?:codex\s+exec|claude\s+(?:-p|--print)|opencode\s+(?:run|exec)|pi\s+(?:-p|--print))(?:\s|$)/i;
const INVISIBLE_AGENT_TOOLS = new Set(["subagent", "orch_start"]);

interface AdvisorSessionState {
	workstream: string;
	sessionId: string;
	initializedAt: string;
}

interface AdvisorPaths {
	workstream: string;
	session: string;
	events: string;
	lock: string;
}

interface WorkstreamClaimOptions {
	paths: AdvisorPaths;
	workstream: string;
	sessionId: string;
	firstOwner: string | undefined;
	transferApproved: boolean;
}

function slugify(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_WORKSTREAM_LENGTH)
		.replace(/-+$/g, "");
}

function herdrAgentName(workstream: string, sessionId?: string): string {
	const base = `advisor-${workstream.slice(0, 24).replace(/-+$/g, "")}`;
	if (!sessionId) return base;
	return `${base.slice(0, 23).replace(/-+$/g, "")}-${sessionId.slice(0, 8)}`;
}

function restoredEntryState(ctx: ExtensionContext): AdvisorSessionState | undefined {
	for (const entry of ctx.sessionManager.getBranch().toReversed()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data as Partial<AdvisorSessionState> | undefined;
		if (
			typeof data?.workstream === "string" &&
			typeof data.sessionId === "string" &&
			typeof data.initializedAt === "string"
		) {
			return data as AdvisorSessionState;
		}
	}
	return undefined;
}

function workstreamFromSession(content: string): string | undefined {
	return content.match(/^- Workstream: `([^`]+)`$/m)?.[1];
}

function ownerFromWorkstream(content: string): string | undefined {
	return content.match(/^- Owner session: `([^`]+)`$/m)?.[1];
}

async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function restoredDiskState(
	ctx: ExtensionContext,
	sessionId: string,
): Promise<AdvisorSessionState | undefined> {
	const path = join(ctx.cwd, ".advisor", "sessions", `${sessionId}.md`);
	const content = await readIfPresent(path);
	const workstream = content ? workstreamFromSession(content) : undefined;
	if (!workstream) return undefined;
	return { workstream, sessionId, initializedAt: "legacy-state" };
}

async function restoredState(
	ctx: ExtensionContext,
	sessionId = ctx.sessionManager.getSessionId(),
): Promise<AdvisorSessionState | undefined> {
	return restoredEntryState(ctx) ?? (await restoredDiskState(ctx, sessionId));
}

function pathsFor(ctx: ExtensionContext, workstream: string, sessionId: string): AdvisorPaths {
	const root = join(ctx.cwd, ".advisor");
	return {
		workstream: join(root, "workstreams", `${workstream}.md`),
		session: join(root, "sessions", `${sessionId}.md`),
		events: join(root, "events"),
		lock: join(root, "locks", `workstream-${workstream}`),
	};
}

async function ensureAdvisorDirectories(ctx: ExtensionContext): Promise<void> {
	const root = join(ctx.cwd, ".advisor");
	await Promise.all(
		["workstreams", "sessions", "events", "locks"].map((directory) =>
			mkdir(join(root, directory), { recursive: true }),
		),
	);
}

async function acquireLock(path: string): Promise<void> {
	try {
		await mkdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error("This workstream is being initialized by another advisor. Retry once it finishes.");
		}
		throw error;
	}
}

function timestampForPath(now = new Date()): string {
	return now.toISOString().replaceAll(":", "-");
}

async function writeAtomically(path: string, content: string): Promise<void> {
	const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temp, content, "utf8");
	await rename(temp, path);
}

async function requestTransfer(
	ctx: ExtensionContext,
	workstream: string,
	owner: string | undefined,
	sessionId: string,
): Promise<boolean> {
	if (!owner || owner === sessionId) return false;
	if (!ctx.hasUI) throw new Error(`Workstream ${workstream} is owned by session ${owner}.`);
	const approved = await ctx.ui.confirm(
		"Transfer advisor workstream?",
		`${workstream} is owned by ${owner.slice(0, 8)}. Transfer it to this session?`,
	);
	if (!approved) throw new Error("Workstream transfer cancelled.");
	return true;
}

async function recordHandoff(
	paths: AdvisorPaths,
	workstream: string,
	previousOwner: string,
	sessionId: string,
): Promise<void> {
	const eventPath = join(
		paths.events,
		`${timestampForPath()}-${sessionId.slice(0, 8)}-${workstream}-handoff.md`,
	);
	await writeFile(
		eventPath,
		`# Advisor workstream handoff\n\n- Workstream: \`${workstream}\`\n- Previous owner: \`${previousOwner}\`\n- New owner: \`${sessionId}\`\n`,
		{ encoding: "utf8", flag: "wx" },
	);
}

async function writeWorkstreamClaim(options: WorkstreamClaimOptions): Promise<void> {
	const { paths, workstream, sessionId, firstOwner, transferApproved } = options;
	const current = await readIfPresent(paths.workstream);
	const currentOwner = current ? ownerFromWorkstream(current) : undefined;
	if (!current) {
		await writeFile(
			paths.workstream,
			`# Workstream: ${workstream}\n\n- Owner session: \`${sessionId}\`\n- Status: active\n\n## Goal\n\nTo be defined from the advisor conversation.\n\n## Current state\n\nInitialized by \`/advisor\`.\n`,
			{ encoding: "utf8", flag: "wx" },
		);
		return;
	}
	if (!currentOwner || currentOwner === sessionId) return;
	if (!transferApproved || currentOwner !== firstOwner) {
		throw new Error(`Workstream ownership changed to ${currentOwner}; initialize again.`);
	}
	const updated = current.replace(
		/^- Owner session: `[^`]+`$/m,
		`- Owner session: \`${sessionId}\``,
	);
	await writeAtomically(paths.workstream, updated);
	await recordHandoff(paths, workstream, currentOwner, sessionId);
}

async function ensurePrivateSession(
	path: string,
	workstream: string,
	sessionId: string,
): Promise<void> {
	const current = await readIfPresent(path);
	if (current) {
		if (!current.includes(`- Workstream: \`${workstream}\``)) {
			throw new Error("This Pi session already owns a different advisor workstream.");
		}
		return;
	}
	await writeFile(
		path,
		`# Advisor Session ${sessionId.slice(0, 8)}\n\n- Workstream: \`${workstream}\`\n- State: active\n\nInitialized by the advisor skill.\n`,
		{ encoding: "utf8", flag: "wx" },
	);
}

async function claimWorkstream(
	ctx: ExtensionContext,
	workstream: string,
	sessionId: string,
): Promise<void> {
	await ensureAdvisorDirectories(ctx);
	const paths = pathsFor(ctx, workstream, sessionId);
	const firstRead = await readIfPresent(paths.workstream);
	const firstOwner = firstRead ? ownerFromWorkstream(firstRead) : undefined;
	const transferApproved = await requestTransfer(ctx, workstream, firstOwner, sessionId);

	await acquireLock(paths.lock);
	try {
		await writeWorkstreamClaim({ paths, workstream, sessionId, firstOwner, transferApproved });
	} catch (error) {
		throw new Error(`Could not claim advisor workstream: ${(error as Error).message}`);
	} finally {
		await rm(paths.lock, { recursive: true, force: true });
	}
	await ensurePrivateSession(paths.session, workstream, sessionId);
}

async function verifyHerdr(pi: ExtensionAPI): Promise<string> {
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
		throw new Error("Advisor sessions require Herdr so delegated agents stay visible.");
	}
	const paneId = process.env.HERDR_PANE_ID;
	const result = await pi.exec("herdr", ["agent", "get", paneId]);
	if (result.code !== 0) {
		throw new Error("Herdr cannot identify this Pi pane. Reload Pi inside Herdr and invoke /advisor again.");
	}
	return paneId;
}

async function renameHerdrAgent(
	pi: ExtensionAPI,
	paneId: string,
	workstream: string,
	sessionId: string,
): Promise<string> {
	const preferred = herdrAgentName(workstream);
	let result = await pi.exec("herdr", ["agent", "rename", paneId, preferred]);
	if (result.code === 0) return preferred;

	const fallback = herdrAgentName(workstream, sessionId);
	result = await pi.exec("herdr", ["agent", "rename", paneId, fallback]);
	if (result.code !== 0) {
		throw new Error(`Herdr could not name this advisor: ${result.stderr.trim() || "unknown error"}`);
	}
	return fallback;
}

async function restoreActiveSession(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<AdvisorSessionState | undefined> {
	const state = await restoredState(ctx);
	if (!state) return undefined;
	process.env.ADVISOR_WORKSTREAM = state.workstream;
	const sessionName = `advisor-${state.workstream}`;
	if (pi.getSessionName() !== sessionName) pi.setSessionName(sessionName);
	if (process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID) {
		try {
			await renameHerdrAgent(pi, process.env.HERDR_PANE_ID, state.workstream, state.sessionId);
		} catch {
			// The initializer gives a visible error later if Herdr still cannot bind.
		}
	}
	return state;
}

function bgAgentGuardReason(input: unknown): string | undefined {
	const params = input as {
		role?: unknown;
		anchor?: unknown;
		agent?: unknown;
		name?: unknown;
	};
	if (typeof params.name === "string" && params.name) return undefined;
	if (typeof params.agent === "string" && params.agent) {
		return "Advisor workers must use configured Pi roles, not an explicit agent command.";
	}
	if (typeof params.role !== "string" || !params.role) {
		return "New advisor workers require a configured bg_agent role.";
	}
	if (typeof params.anchor !== "string" || !params.anchor.trim()) {
		return "New advisor workers require a concrete immutable anchor.";
	}
	return undefined;
}

function registerVisibilityGuard(
	pi: ExtensionAPI,
	getState: () => AdvisorSessionState | undefined,
): void {
	pi.on("tool_call", (event) => {
		if (!getState()) return;
		if (INVISIBLE_AGENT_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: "Advisor agents must use bg_agent so each helper is visible in Herdr.",
			};
		}
		if (event.toolName === "bg_agent") {
			const reason = bgAgentGuardReason(event.input);
			return reason ? { block: true, reason } : undefined;
		}
		if (event.toolName !== "bg_run") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command === "string" && HEADLESS_AGENT_COMMAND.test(command)) {
			return {
				block: true,
				reason: "Do not start a headless LLM through bg_run. Use bg_agent for Herdr visibility.",
			};
		}
	});
}

async function requestedWorkstream(
	ctx: ExtensionContext,
	value: string | undefined,
): Promise<string> {
	let requested = value?.trim();
	if (!requested) {
		if (!ctx.hasUI) throw new Error("A workstream is required outside interactive Pi.");
		requested = await ctx.ui.input("Advisor workstream", "Short name, for example qa-incident");
	}
	const workstream = slugify(requested ?? "");
	if (!workstream) throw new Error("Enter a workstream name with letters or numbers.");
	return workstream;
}

async function initializeAdvisor(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	value: string | undefined,
): Promise<{ state: AdvisorSessionState; herdrName: string; usedStoredWorkstream: boolean }> {
	const sessionId = ctx.sessionManager.getSessionId();
	const restored = await restoredState(ctx, sessionId);
	const requested = restored ? slugify(value ?? restored.workstream) : await requestedWorkstream(ctx, value);
	const usedStoredWorkstream = Boolean(restored && restored.workstream !== requested);
	const workstream = restored?.workstream ?? requested;
	const paneId = await verifyHerdr(pi);
	await claimWorkstream(ctx, workstream, sessionId);
	const herdrName = await renameHerdrAgent(pi, paneId, workstream, sessionId);
	const state: AdvisorSessionState = {
		workstream,
		sessionId,
		initializedAt: restored?.initializedAt ?? new Date().toISOString(),
	};
	process.env.ADVISOR_WORKSTREAM = workstream;
	pi.setSessionName(`advisor-${workstream}`);
	if (!restoredEntryState(ctx)) pi.appendEntry(ENTRY_TYPE, state);
	return { state, herdrName, usedStoredWorkstream };
}

export default function advisorSessionExtension(pi: ExtensionAPI): void {
	let activeState: AdvisorSessionState | undefined;
	pi.on("session_start", async (_event, ctx) => {
		activeState = await restoreActiveSession(pi, ctx);
	});
	registerVisibilityGuard(pi, () => activeState);

	pi.registerTool({
		name: "advisor_session_init",
		label: "Advisor Session",
		description:
			"Initialize the current Pi session as one isolated advisor workstream. " +
			"Names the Pi and Herdr agent, claims workstream state, and enables visible-agent guards.",
		promptSnippet: "Initialize an advisor workstream after the advisor skill is invoked",
		promptGuidelines: [
			"Call advisor_session_init before any other tool after the advisor skill is invoked. Omit workstream when the user must name it.",
		],
		parameters: Type.Object({
			workstream: Type.Optional(
				Type.String({
					description: "Short task slug. Omit to ask the user in the Pi UI.",
					maxLength: MAX_WORKSTREAM_LENGTH,
				}),
			),
		}),
		async execute(...args) {
			const [, params, , , ctx] = args;
			const initialized = await initializeAdvisor(pi, ctx, params.workstream);
			activeState = initialized.state;
			if (initialized.usedStoredWorkstream) {
				ctx.ui.notify(`Using stored workstream: ${initialized.state.workstream}`, "warning");
			}
			ctx.ui.notify(`Advisor ready: ${initialized.state.workstream}`, "info");
			return {
				content: [
					{
						type: "text",
						text: `Initialized advisor workstream ${initialized.state.workstream}. Pi session ${initialized.state.sessionId.slice(0, 8)} is visible in Herdr as ${initialized.herdrName}.`,
					},
				],
				details: initialized.state,
			};
		},
	});
}
