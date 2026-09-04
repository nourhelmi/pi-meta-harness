import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { advisorStateRoot } from "../../scripts/advisor-core/advisor-state.mjs";

export { advisorStateRoot };

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
