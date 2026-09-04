import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CanonicalEvent {
	v: 1;
	seq: number;
	at: string;
	run: string;
	node: string | null;
	parent: string | null;
	host: "pi";
	type: string;
	data: Record<string, unknown>;
}

export type CanonicalEventDraft = Pick<CanonicalEvent, "node" | "parent" | "type" | "data">;

async function readTrace(path: string): Promise<CanonicalEvent[]> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return contents
		.split("\n")
		.filter((line) => line.trim())
		.map((line, index) => {
			try {
				return JSON.parse(line) as CanonicalEvent;
			} catch (error) {
				throw new Error(`trace ${path} line ${index + 1} is invalid JSON: ${(error as Error).message}`);
			}
		});
}

function appendTimestamp(events: CanonicalEvent[]): string {
	const now = Date.now();
	const prior = Date.parse(events.at(-1)?.at ?? "");
	return new Date(Number.isFinite(prior) ? Math.max(now, prior) : now).toISOString();
}

export function nextWakeGeneration(events: CanonicalEvent[], parent: string): number {
	return events.reduce((generation, event) => {
		if (event.type !== "parent.awakened" || event.node !== parent) return generation;
		const candidate = event.data.wakeGeneration;
		return typeof candidate === "number" ? Math.max(generation, candidate) : generation;
	}, 0) + 1;
}

export class AdvisorTraceStore {
	readonly stateRoot: string;
	readonly #pending = new Map<string, Promise<void>>();

	constructor(stateRoot: string) {
		this.stateRoot = stateRoot;
	}

	path(runId: string): string {
		return join(this.stateRoot, "traces", `${runId}.jsonl`);
	}

	update(
		runId: string,
		createDrafts: (events: CanonicalEvent[]) => Promise<CanonicalEventDraft[]> | CanonicalEventDraft[],
	): Promise<void> {
		const prior = this.#pending.get(runId) ?? Promise.resolve();
		const current = prior.then(async () => {
			const path = this.path(runId);
			const events = await readTrace(path);
			const drafts = await createDrafts(events);
			if (drafts.length === 0) return;
			const at = appendTimestamp(events);
			let seq = events.at(-1)?.seq ?? 0;
			const appended = drafts.map((draft) => ({
				v: 1 as const,
				seq: ++seq,
				at,
				run: runId,
				host: "pi" as const,
				...draft,
			}));
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, `${appended.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
		});
		this.#pending.set(runId, current);
		void current.then(() => {
			if (this.#pending.get(runId) === current) this.#pending.delete(runId);
		}, () => {
			if (this.#pending.get(runId) === current) this.#pending.delete(runId);
		});
		return current;
	}
}
