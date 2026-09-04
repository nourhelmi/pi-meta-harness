import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "advisor-session";

export type WorkerHarness = "pi" | "native";

export interface AdvisorSessionState {
	workstream: string;
	sessionId: string;
	initializedAt: string;
	workerHarness: WorkerHarness;
}

export function isWorkerHarness(value: unknown): value is WorkerHarness {
	return value === "pi" || value === "native";
}

export function restoredEntryState(ctx: ExtensionContext): AdvisorSessionState | undefined {
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

async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

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
			const dotGitContents = await readFile(dotGit, "utf8");
			const pointer = dotGitContents.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
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

export async function advisorStateRoot(cwd: string): Promise<string> {
	const override = process.env.ADVISOR_STATE_DIR;
	if (override) return resolve(override);
	const anchor = await repoAnchor(cwd);
	const key = anchor ? stateSlug(dirname(anchor.commonDir)) : stateSlug(resolve(cwd));
	return join(homedir(), ".advisor", key);
}

function workstreamFromSession(content: string): string | undefined {
	return content.match(/^- Workstream: `([^`]+)`$/m)?.[1];
}

async function restoredDiskState(
	ctx: ExtensionContext,
	sessionId: string,
): Promise<AdvisorSessionState | undefined> {
	const root = await advisorStateRoot(ctx.cwd);
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

export async function restoredState(
	ctx: ExtensionContext,
	sessionId = ctx.sessionManager.getSessionId(),
): Promise<AdvisorSessionState | undefined> {
	return restoredEntryState(ctx) ?? (await restoredDiskState(ctx, sessionId));
}
