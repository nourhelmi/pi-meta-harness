export interface GraphBlock {
	graph: string;
	node: string;
	wave: number;
	repair?: number;
	upstream?: string[];
	downstream?: string[];
}

export interface HostCanonicalEvent {
	v: 1;
	seq: number;
	at: string;
	run: string;
	node: string | null;
	parent: string | null;
	host: "pi" | "codex" | "claude-code";
	type: string;
	data: object;
}

export type HostCanonicalEventDraft = Pick<HostCanonicalEvent, "node" | "parent" | "type" | "data">;

export function appendTrace(
	root: string,
	runId: string,
	host: HostCanonicalEvent["host"],
	createDrafts: (events: HostCanonicalEvent[]) =>
		Promise<HostCanonicalEventDraft[]> | HostCanonicalEventDraft[],
): Promise<HostCanonicalEvent[]>;

export function parseGraphBlock(prompt: string): GraphBlock | undefined;
export function readGraphManifest(root: string, graph: string): Promise<unknown>;
export function resolveGraphLaunch(root: string, prompt: string): Promise<(GraphBlock & {
	plan?: {
		graph: string;
		waves: string[][];
		maxParallel: number;
		maxRepairLoops: number;
	};
}) | undefined>;
