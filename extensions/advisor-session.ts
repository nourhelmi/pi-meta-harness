import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENTRY_TYPE = "advisor-session";
const MAX_WORKSTREAM_LENGTH = 48;
const MAX_ADVISOR_PURPOSE_LENGTH = 40;
const ADVISOR_READY_ATTEMPTS = 40;
const ADVISOR_READY_DELAY_MS = 500;
const HEADLESS_AGENT_COMMAND =
	/(?:^|[;&|]\s*|\s)(?:codex\s+exec|claude\s+(?:-p|--print)|opencode\s+(?:run|exec)|pi\s+(?:-p|--print))(?:\s|$)/i;
const INVISIBLE_AGENT_TOOLS = new Set(["subagent", "orch_start"]);

const ADVISOR_SKILL_URL = new URL("../skills/advisor/SKILL.md", import.meta.url);

function advisorSkillBody(source: string): string {
	return source
		.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
		.replace(/^References are relative to [^\r\n]+\r?\n(?:\r?\n)?/, "")
		.trim();
}

async function liveAdvisorSkillBody(): Promise<string> {
	return advisorSkillBody(await readFile(ADVISOR_SKILL_URL, "utf8"));
}

function restoredAdvisorSkillBody(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		for (const part of entry.message.content) {
			const text = typeof part === "string" ? part : part.type === "text" ? part.text : undefined;
			if (text === undefined) continue;
			const tagStart = text.indexOf('<skill name="advisor"');
			if (tagStart < 0) continue;
			const tagEnd = text.indexOf(">", tagStart);
			const close = text.indexOf("</skill>", tagEnd);
			const bodyStart = text.indexOf("\n\n", tagEnd);
			if (tagEnd < 0 || close < 0 || bodyStart < 0 || bodyStart >= close) continue;
			return advisorSkillBody(text.slice(bodyStart + 2, close));
		}
	}
	return undefined;
}

function withLiveAdvisorDoctrine(systemPrompt: string, doctrine: string): string {
	return `${systemPrompt}\n\n# Current Advisor Doctrine\n\nThis installed doctrine is authoritative for the active resumed advisor session. Any older advisor skill snapshot or summary in conversation history is archival and must not override it.\n\n${doctrine}`;
}
function withWorkerHarnessDoctrine(systemPrompt: string, workerHarness: WorkerHarness): string {
	const policy = workerHarness === "native"
		? "Every configured bg_agent role launch uses the native worker harness. Keep semantic role names unchanged. Choose model and thinking from the live intelligence guide; OpenAI models route to Codex CLI and Anthropic/Claude models route to Claude Code. Cursor-only models have no native route here, so select a task-appropriate OpenAI or Anthropic recommendation from the same guide instead. The root advisor remains Pi."
		: "Every configured bg_agent role launch uses the Pi worker harness. Keep semantic role names unchanged and choose model and thinking from the live intelligence guide. The root advisor remains Pi.";
	return `${systemPrompt}\n\n# Advisor Worker Harness\n\nSession mode: **${workerHarness}**.\n\n${policy}`;
}

type WorkerHarness = "pi" | "native";

interface AdvisorSessionState {
	workstream: string;
	sessionId: string;
	initializedAt: string;
	workerHarness: WorkerHarness;
}

interface AdvisorPaths {
	root: string;
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

function truncateAtWord(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	const prefix = value.slice(0, maxLength + 1);
	const boundary = prefix.lastIndexOf(" ");
	return (boundary > 0 ? prefix.slice(0, boundary) : value.slice(0, maxLength)).trimEnd();
}

function advisorPurposeWords(value: string): string {
	const words = value
		.trim()
		.replace(/[-_]+/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^advisor(?:\s+|$)/i, "")
		.trim();
	return truncateAtWord(words || "workstream", MAX_ADVISOR_PURPOSE_LENGTH);
}

function advisorPaneLabel(value: string): string {
	return `advisor · ${advisorPurposeWords(value)}`;
}

function optionalWorkstream(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const workstream = slugify(value.trim());
	if (!workstream) throw new Error("Enter a workstream name with letters or numbers.");
	return workstream;
}

function herdrError(stderr: string, fallback: string): string {
	return stderr.trim() || fallback;
}

function herdrTabIds(stdout: string): { tabId: string; paneId?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("Herdr returned invalid JSON while creating the advisor tab.");
	}
	const result = (parsed as { result?: unknown }).result as
		| {
				root_pane?: { pane_id?: unknown; tab_id?: unknown };
				tab?: { tab_id?: unknown };
		  }
		| undefined;
	const paneId = result?.root_pane?.pane_id;
	const tabId = result?.tab?.tab_id ?? result?.root_pane?.tab_id;
	if (typeof tabId !== "string") throw new Error("Herdr did not return the new advisor tab ID.");
	return { tabId, ...(typeof paneId === "string" ? { paneId } : {}) };
}

function advisorBootstrapPrompt(
	workstream: string | undefined,
	workerHarness: WorkerHarness | undefined,
	prompt: string | undefined,
): string {
	const skill = workerHarness ? `advisor-${workerHarness}` : "advisor";
	const harness = workerHarness ? ` and workerHarness \"${workerHarness}\"` : "";
	const initialize = workstream
		? `Call advisor_session_init with workstream \"${workstream}\"${harness} before any other tool.`
		: `Call advisor_session_init without a workstream${harness} before any other tool so the user can name it.`;
	const extra = prompt?.trim();
	return `/skill:${skill}\n\n${initialize}${extra ? `\n\nAdditional instructions:\n${extra}` : ""}`;
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
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
			return {
				workstream: data.workstream,
				sessionId: data.sessionId,
				initializedAt: data.initializedAt,
				workerHarness: isWorkerHarness(data.workerHarness) ? data.workerHarness : "pi",
			};
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

// Advisor state lives under the user home so repositories never carry
// personal runtime files; every worktree of one repository shares one root.
interface RepoAnchor {
	commonDir: string;
	worktreeRoot: string;
}

async function repoAnchor(cwd: string): Promise<RepoAnchor | undefined> {
	let dir = resolve(cwd);
	for (;;) {
		const dotGit = join(dir, ".git");
		const info = await stat(dotGit).catch(() => undefined);
		if (info?.isDirectory()) return { commonDir: dotGit, worktreeRoot: dir };
		if (info?.isFile()) {
			const pointer = (await readFile(dotGit, "utf8")).match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
			if (pointer) {
				const gitDir = resolve(dir, pointer);
				const marker = gitDir.lastIndexOf("/.git/worktrees/");
				return {
					commonDir: marker >= 0 ? gitDir.slice(0, marker + "/.git".length) : gitDir,
					worktreeRoot: dir,
				};
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function stateSlug(path: string): string {
	const cleaned = basename(path)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	const hash = createHash("sha256").update(path).digest("hex").slice(0, 8);
	return `${cleaned || "dir"}-${hash}`;
}

async function advisorStateRoot(cwd: string): Promise<string> {
	const override = process.env.ADVISOR_STATE_DIR;
	if (override) return resolve(override);
	const anchor = await repoAnchor(cwd);
	const key = anchor ? stateSlug(dirname(anchor.commonDir)) : stateSlug(resolve(cwd));
	return join(homedir(), ".advisor", key);
}

async function restoredDiskState(
	ctx: ExtensionContext,
	sessionId: string,
): Promise<AdvisorSessionState | undefined> {
	const root = await advisorStateRoot(ctx.cwd);
	// The in-repo path is legacy fallback so sessions from before the home
	// migration still restore their workstream binding.
	const candidates = [
		join(root, "sessions", `${sessionId}.md`),
		join(ctx.cwd, ".advisor", "sessions", `${sessionId}.md`),
	];
	for (const path of candidates) {
		const content = await readIfPresent(path);
		const workstream = content ? workstreamFromSession(content) : undefined;
		if (workstream) return { workstream, sessionId, initializedAt: "legacy-state", workerHarness: "pi" };
	}
	return undefined;
}

async function restoredState(
	ctx: ExtensionContext,
	sessionId = ctx.sessionManager.getSessionId(),
): Promise<AdvisorSessionState | undefined> {
	return restoredEntryState(ctx) ?? (await restoredDiskState(ctx, sessionId));
}

function pathsFor(root: string, workstream: string, sessionId: string): AdvisorPaths {
	return {
		root,
		workstream: join(root, "workstreams", `${workstream}.md`),
		session: join(root, "sessions", `${sessionId}.md`),
		events: join(root, "events"),
		lock: join(root, "locks", `workstream-${workstream}`),
	};
}

async function ensureAdvisorDirectories(root: string): Promise<void> {
	await Promise.all(
		["workstreams", "sessions", "events", "locks", "runs", "graphs"].map((directory) =>
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
): Promise<AdvisorPaths> {
	const root = await advisorStateRoot(ctx.cwd);
	await ensureAdvisorDirectories(root);
	const paths = pathsFor(root, workstream, sessionId);
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
	return paths;
}


function requireHerdrEnvironment(): void {
	if (process.env.HERDR_ENV !== "1") {
		throw new Error("Advisor sessions require Herdr so delegated agents stay visible. No pane-split fallback is available.");
	}
}

async function verifyHerdr(pi: ExtensionAPI): Promise<string> {
	requireHerdrEnvironment();
	if (!process.env.HERDR_PANE_ID) {
		throw new Error("Advisor sessions require Herdr so delegated agents stay visible.");
	}
	const paneId = process.env.HERDR_PANE_ID;
	const result = await pi.exec("herdr", ["agent", "get", paneId]);
	if (result.code !== 0) {
		throw new Error("Herdr cannot identify this Pi pane. Reload Pi inside Herdr and invoke /advisor again.");
	}
	return paneId;
}

async function renameHerdrPane(pi: ExtensionAPI, paneId: string, label: string): Promise<void> {
	await pi.exec("herdr", ["pane", "rename", paneId, label]);
}

async function launchAdvisor(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: { cwd: string; workstream?: string; workerHarness?: WorkerHarness; purpose?: string; prompt?: string },
): Promise<{ tabId: string; paneId: string; label: string; cwd: string; workstream?: string; workerHarness?: WorkerHarness }> {
	requireHerdrEnvironment();
	const cwd = resolve(ctx.cwd, params.cwd);
	let cwdStat;
	try {
		cwdStat = await stat(cwd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Advisor cwd does not exist: ${cwd}`);
		}
		throw error;
	}
	if (!cwdStat.isDirectory()) throw new Error(`Advisor cwd is not a directory: ${cwd}`);

	const workstream = optionalWorkstream(params.workstream);
	const workerHarness = params.workerHarness;
	const purpose = params.purpose?.trim() || workstream || basename(cwd);
	const label = advisorPaneLabel(purpose);
	const created = await pi.exec("herdr", ["tab", "create", "--no-focus", "--cwd", cwd, "--label", label]);
	if (created.code !== 0) {
		throw new Error(`Herdr could not create the advisor tab: ${herdrError(created.stderr, "unknown error")}`);
	}
	let tabId: string | undefined;
	try {
		const createdIds = herdrTabIds(created.stdout);
		tabId = createdIds.tabId;
		if (!createdIds.paneId) {
			throw new Error("Herdr did not return the new advisor root pane ID.");
		}
		const paneId = createdIds.paneId;
		const renamed = await pi.exec("herdr", ["pane", "rename", paneId, label]);
		if (renamed.code !== 0) {
			throw new Error(`Herdr could not label the advisor pane: ${herdrError(renamed.stderr, "unknown error")}`);
		}
		const started = await pi.exec("herdr", ["pane", "run", paneId, "pi"]);
		if (started.code !== 0) {
			throw new Error(`Herdr could not start Pi in the advisor tab: ${herdrError(started.stderr, "unknown error")}`);
		}

		const bootstrap = advisorBootstrapPrompt(workstream, workerHarness, params.prompt);
		let lastError = "Pi did not become ready";
		for (let attempt = 0; attempt < ADVISOR_READY_ATTEMPTS; attempt += 1) {
			const ready = await pi.exec("herdr", ["agent", "get", paneId]);
			if (ready.code === 0) {
				const prompted = await pi.exec("herdr", ["agent", "prompt", paneId, bootstrap]);
				if (prompted.code === 0) {
					return {
						tabId,
						paneId,
						label,
						cwd,
						...(workstream ? { workstream } : {}),
						...(workerHarness ? { workerHarness } : {}),
					};
				}
				lastError = herdrError(prompted.stderr, "Herdr rejected the advisor bootstrap prompt");
			} else {
				lastError = herdrError(ready.stderr, "Pi did not become ready");
			}
			if (attempt + 1 < ADVISOR_READY_ATTEMPTS) await delay(ADVISOR_READY_DELAY_MS);
		}
		throw new Error(`Herdr could not bootstrap the advisor: ${lastError}`);
	} catch (error) {
		if (!tabId) throw error;
		const closed = await pi.exec("herdr", ["tab", "close", tabId]);
		if (closed.code !== 0) {
			throw new Error(
				`${(error as Error).message} Cleanup also failed: ${herdrError(closed.stderr, "unknown error")}`,
			);
		}
		throw error;
	}
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
	process.env.ADVISOR_STATE_ROOT = await advisorStateRoot(ctx.cwd);
	process.env.PI_DETACH_WORKER_HARNESS = state.workerHarness;
	const sessionName = `advisor-${state.workstream}`;
	if (pi.getSessionName() !== sessionName) pi.setSessionName(sessionName);
	if (process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID) {
		try {
			await renameHerdrAgent(pi, process.env.HERDR_PANE_ID, state.workstream, state.sessionId);
		} catch {
			// The initializer gives a visible error later if Herdr still cannot bind.
		}
		try {
			await renameHerdrPane(pi, process.env.HERDR_PANE_ID, advisorPaneLabel(state.workstream));
		} catch {
			// Pane labels are presentational and never block restoration.
		}
	}
	return state;
}

function bgAgentGuardReason(input: unknown, workerHarness: WorkerHarness): string | undefined {
	const params = input as {
		role?: unknown;
		anchor?: unknown;
		agent?: unknown;
		harness?: unknown;
		name?: unknown;
	};
	if (typeof params.name === "string" && params.name) return undefined;
	if (isWorkerHarness(params.harness) && params.harness !== workerHarness) {
		return `Advisor session worker harness is ${workerHarness}; per-launch ${params.harness} is not allowed.`;
	}
	if (typeof params.agent === "string" && params.agent) {
		return "Advisor workers must use bg_agent's Pi runtime (a configured role or freeform), not an explicit agent command.";
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
			const state = getState();
			if (!state) return;
			const reason = bgAgentGuardReason(event.input, state.workerHarness);
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

function isWorkerHarness(value: unknown): value is WorkerHarness {
	return value === "pi" || value === "native";
}

async function requestedWorkerHarness(
	ctx: ExtensionContext,
	value: string | undefined,
): Promise<WorkerHarness> {
	if (isWorkerHarness(value)) return value;
	if (value !== undefined) throw new Error(`Unknown worker harness: ${value}`);
	if (!ctx.hasUI) throw new Error("A worker harness is required outside interactive Pi.");
	const choice = await ctx.ui.select("Advisor worker harness", [
		"Native harnesses (Codex / Claude Code)",
		"Pi workers",
	]);
	if (choice === "Native harnesses (Codex / Claude Code)") return "native";
	if (choice === "Pi workers") return "pi";
	throw new Error("Choose a worker harness to initialize the advisor.");
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
	workstreamValue: string | undefined,
	workerHarnessValue: string | undefined,
): Promise<{
	state: AdvisorSessionState;
	herdrName: string;
	usedStoredWorkstream: boolean;
	usedStoredWorkerHarness: boolean;
	paths: AdvisorPaths;
}> {
	const sessionId = ctx.sessionManager.getSessionId();
	const restored = await restoredState(ctx, sessionId);
	const requested = restored
		? slugify(workstreamValue ?? restored.workstream)
		: await requestedWorkstream(ctx, workstreamValue);
	const requestedHarness = await requestedWorkerHarness(
		ctx,
		workerHarnessValue ?? restored?.workerHarness,
	);
	const usedStoredWorkstream = Boolean(restored && restored.workstream !== requested);
	const usedStoredWorkerHarness = Boolean(restored && restored.workerHarness !== requestedHarness);
	const workstream = restored?.workstream ?? requested;
	const workerHarness = restored?.workerHarness ?? requestedHarness;
	const paneId = await verifyHerdr(pi);
	const paths = await claimWorkstream(ctx, workstream, sessionId);
	const herdrName = await renameHerdrAgent(pi, paneId, workstream, sessionId);
	try {
		await renameHerdrPane(pi, paneId, advisorPaneLabel(workstream));
	} catch {
		// Pane labels are presentational; the Herdr agent identity remains authoritative.
	}
	const state: AdvisorSessionState = {
		workstream,
		sessionId,
		initializedAt: restored?.initializedAt ?? new Date().toISOString(),
		workerHarness,
	};
	process.env.ADVISOR_WORKSTREAM = workstream;
	process.env.ADVISOR_STATE_ROOT = paths.root;
	process.env.PI_DETACH_WORKER_HARNESS = workerHarness;
	pi.setSessionName(`advisor-${workstream}`);
	if (!restoredEntryState(ctx)) pi.appendEntry(ENTRY_TYPE, state);
	return { state, herdrName, usedStoredWorkstream, usedStoredWorkerHarness, paths };
}

export default function advisorSessionExtension(pi: ExtensionAPI): void {
	let activeState: AdvisorSessionState | undefined;
	let resumedDoctrine: string | undefined;
	pi.on("session_start", async (_event, ctx) => {
		activeState = await restoreActiveSession(pi, ctx);
		resumedDoctrine = undefined;
		if (!activeState) return;
		try {
			const liveDoctrine = await liveAdvisorSkillBody();
			if (restoredAdvisorSkillBody(ctx) !== liveDoctrine) resumedDoctrine = liveDoctrine;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not refresh resumed advisor doctrine: ${message}`, "warning");
		}
	});
	pi.on("before_agent_start", (event) => {
		if (!activeState) return;
		const doctrine = resumedDoctrine
			? withLiveAdvisorDoctrine(event.systemPrompt, resumedDoctrine)
			: event.systemPrompt;
		return { systemPrompt: withWorkerHarnessDoctrine(doctrine, activeState.workerHarness) };
	});
	registerVisibilityGuard(pi, () => activeState);

	pi.registerTool({
		name: "advisor_launch",
		label: "Launch Advisor",
		description:
			"Launch a separate advisor Pi session in a new visible Herdr tab without changing caller focus. " +
			"Never creates a pane split.",
		parameters: Type.Object({
			cwd: Type.String({ description: "Existing directory for the new advisor session.", minLength: 1 }),
			workstream: Type.Optional(
				Type.String({
					description: "Optional short workstream slug passed to advisor_session_init.",
					maxLength: MAX_WORKSTREAM_LENGTH,
				}),
			),
			workerHarness: Type.Optional(
				Type.Union([Type.Literal("pi"), Type.Literal("native")], {
					description: "Worker harness mode for the new advisor session. Omit to ask in the Pi UI.",
				}),
			),
			purpose: Type.Optional(
				Type.String({ description: "Short human phrase for the advisor pane label.", maxLength: 80 }),
			),
			prompt: Type.Optional(
				Type.String({ description: "Extra instructions appended to the advisor bootstrap prompt." }),
			),
		}),
		async execute(...args) {
			const [, params, , , ctx] = args;
			const launched = await launchAdvisor(pi, ctx, params);
			return {
				content: [
					{
						type: "text",
						text:
							`Launched advisor in Herdr tab ${launched.tabId}, pane ${launched.paneId}.\n` +
							`Label: ${launched.label}\nCwd: ${launched.cwd}`,
					},
				],
				details: launched,
			};
		},
	});

	pi.registerTool({
		name: "advisor_session_init",
		label: "Advisor Session",
		description:
			"Initialize the current Pi session as one isolated advisor workstream. " +
			"Names the Pi and Herdr agent, claims workstream state, selects Pi or native worker harnesses, and enables visible-agent guards.",
		promptSnippet: "Initialize an advisor workstream after the advisor skill is invoked",
		promptGuidelines: [
			"Call advisor_session_init before any other tool after the advisor skill is invoked. Omit workstream or workerHarness when the user must choose it in the Pi UI.",
		],
		parameters: Type.Object({
			workstream: Type.Optional(
				Type.String({
					description: "Short task slug. Omit to ask the user in the Pi UI.",
					maxLength: MAX_WORKSTREAM_LENGTH,
				}),
			),
			workerHarness: Type.Optional(
				Type.Union([Type.Literal("pi"), Type.Literal("native")], {
					description: "Use Pi workers or route selected OpenAI/Anthropic models through native harnesses. Omit to ask in the Pi UI.",
				}),
			),
		}),
		async execute(...args) {
			const [, params, , , ctx] = args;
			const initialized = await initializeAdvisor(pi, ctx, params.workstream, params.workerHarness);
			activeState = initialized.state;
			if (initialized.usedStoredWorkstream) {
				ctx.ui.notify(`Using stored workstream: ${initialized.state.workstream}`, "warning");
			}
			if (initialized.usedStoredWorkerHarness) {
				ctx.ui.notify(`Using stored worker harness: ${initialized.state.workerHarness}`, "warning");
			}
			ctx.ui.notify(
				`Advisor ready: ${initialized.state.workstream} · ${initialized.state.workerHarness} workers`,
				"info",
			);
			return {
				content: [
					{
						type: "text",
						text:
							`Initialized advisor workstream ${initialized.state.workstream} with ${initialized.state.workerHarness} workers. Root advisor Pi session ${initialized.state.sessionId.slice(0, 8)} is visible in Herdr as ${initialized.herdrName}.\n` +
							`State root: ${initialized.paths.root}\n` +
							`Workstream file: ${initialized.paths.workstream}\n` +
							`Events: ${initialized.paths.events}\n` +
							`Runs and graphs live under the same root. Legacy in-repo .advisor/ directories are read-only history.`,
					},
				],
				details: { ...initialized.state, stateRoot: initialized.paths.root },
			};
		},
	});
}
