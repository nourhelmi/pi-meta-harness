export interface GraphBlock {
	graph: string;
	node: string;
	wave: number;
	repair?: number;
	upstream?: string[];
	downstream?: string[];
}

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
