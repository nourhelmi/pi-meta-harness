import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const GraphNodeSchema = Type.Object({
	id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }),
	role: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }),
	task: Type.String({ minLength: 1 }),
	anchor: Type.String({ minLength: 1 }),
	requiredSkills: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
	dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
	worktree: Type.Optional(Type.String()),
	keepAlive: Type.Optional(Type.Boolean()),
});
const GraphParameters = Type.Object({
	graphId: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }),
	goal: Type.String({ minLength: 1 }),
	nodes: Type.Array(GraphNodeSchema, { minItems: 1, maxItems: 24 }),
	maxParallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, default: 3 })),
	maxRepairLoops: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, default: 2 })),
	allowParallelBuilders: Type.Optional(Type.Boolean({ default: false })),
});

type GraphNode = Static<typeof GraphNodeSchema>;
type GraphParams = Static<typeof GraphParameters>;

interface GraphDetails {
	manifestPath?: string;
	waves?: string[][];
	nodeCount?: number;
}

interface RoleProfiles {
	profiles?: Record<string, { model?: string; provider?: string }>;
}

function profilePath(): string {
	return (
		process.env.PI_DETACH_AGENT_PROFILES ??
		join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "bg-agent-profiles.json")
	);
}

async function configuredRoles(): Promise<Set<string>> {
	const contents = await readFile(profilePath(), "utf8");
	try {
		const config = JSON.parse(contents) as RoleProfiles;
		return new Set(Object.keys(config.profiles ?? {}));
	} catch {
		throw new Error(`Could not parse advisor role profiles at ${profilePath()}`);
	}
}

function nodeMap(nodes: GraphNode[]): Map<string, GraphNode> {
	const byId = new Map<string, GraphNode>();
	for (const node of nodes) {
		if (byId.has(node.id)) throw new Error(`Duplicate graph node id: ${node.id}`);
		byId.set(node.id, node);
	}
	return byId;
}

function validateRoles(nodes: GraphNode[], roles: Set<string>): void {
	for (const node of nodes) {
		if (!roles.has(node.role)) throw new Error(`Node ${node.id} uses unknown role ${node.role}`);
	}
}

function validateDependencies(nodes: GraphNode[], byId: Map<string, GraphNode>): void {
	for (const node of nodes) {
		for (const dependency of node.dependsOn ?? []) {
			if (dependency === node.id) throw new Error(`Node ${node.id} cannot depend on itself`);
			if (!byId.has(dependency)) throw new Error(`Node ${node.id} has missing dependency ${dependency}`);
		}
	}
}

function dependencyClosure(node: GraphNode, byId: Map<string, GraphNode>): Set<string> {
	const visited = new Set<string>();
	const pending = [...(node.dependsOn ?? [])];
	while (pending.length) {
		const id = pending.pop();
		if (!id || visited.has(id)) continue;
		visited.add(id);
		pending.push(...(byId.get(id)?.dependsOn ?? []));
	}
	return visited;
}

function validateRoleOrder(nodes: GraphNode[], byId: Map<string, GraphNode>): void {
	for (const node of nodes) {
		const dependencies = dependencyClosure(node, byId);
		if (node.role === "checker") {
			const checksBuilder = [...dependencies].some((id) => byId.get(id)?.role === "builder");
			if (!checksBuilder) throw new Error(`Checker ${node.id} must depend on a builder`);
		}
		if (node.role === "browser-verifier") {
			const verifiesBuilder = [...dependencies].some((id) => byId.get(id)?.role === "builder");
			if (!verifiesBuilder) throw new Error(`Browser verifier ${node.id} must depend on a builder`);
		}
		if (node.role === "reducer" && dependencies.size < 2) {
			throw new Error(`Reducer ${node.id} must combine at least two upstream nodes`);
		}
	}
}

function readyNodes(
	remaining: Map<string, GraphNode>,
	completed: Set<string>,
): GraphNode[] {
	return [...remaining.values()]
		.filter((node) => (node.dependsOn ?? []).every((dependency) => completed.has(dependency)))
		.toSorted((left, right) => left.id.localeCompare(right.id));
}

function executionWaves(nodes: GraphNode[], maxParallel: number): string[][] {
	const remaining = nodeMap(nodes);
	const completed = new Set<string>();
	const waves: string[][] = [];
	while (remaining.size) {
		const ready = readyNodes(remaining, completed);
		if (!ready.length) throw new Error("Graph contains a dependency cycle");
		for (let index = 0; index < ready.length; index += maxParallel) {
			const wave = ready.slice(index, index + maxParallel).map((node) => node.id);
			waves.push(wave);
			for (const id of wave) {
				remaining.delete(id);
				completed.add(id);
			}
		}
	}
	return waves;
}

function validateBuilders(
	waves: string[][],
	byId: Map<string, GraphNode>,
	allowParallelBuilders: boolean,
): void {
	for (const wave of waves) {
		const builders = wave.map((id) => byId.get(id)).filter((node) => node?.role === "builder");
		if (builders.length < 2) continue;
		if (!allowParallelBuilders) {
			throw new Error("Parallel builders require explicit user approval and allowParallelBuilders=true");
		}
		const worktrees = builders.map((node) => node?.worktree).filter((path): path is string => Boolean(path));
		if (worktrees.length !== builders.length || new Set(worktrees).size !== builders.length) {
			throw new Error("Parallel builders require distinct explicit worktrees");
		}
	}
}

function manifest(
	params: GraphParams,
	ctx: ExtensionContext,
	waves: string[][],
): object {
	return {
		version: 1,
		graphId: params.graphId,
		goal: params.goal,
		advisorSessionId: ctx.sessionManager.getSessionId(),
		workstream: process.env.ADVISOR_WORKSTREAM,
		maxParallel: params.maxParallel ?? 3,
		maxRepairLoops: params.maxRepairLoops ?? 2,
		allowParallelBuilders: params.allowParallelBuilders ?? false,
		nodes: params.nodes,
		waves,
		createdAt: new Date().toISOString(),
	};
}

async function saveManifest(
	params: GraphParams,
	ctx: ExtensionContext,
	waves: string[][],
): Promise<string> {
	const directory = join(ctx.cwd, ".advisor", "graphs");
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${params.graphId}.json`);
	await writeFile(path, `${JSON.stringify(manifest(params, ctx, waves), null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
	return path;
}

async function planGraph(params: GraphParams, ctx: ExtensionContext): Promise<AgentToolResult<GraphDetails>> {
	if (!process.env.ADVISOR_WORKSTREAM) throw new Error("Invoke /advisor before planning a graph");
	const roles = await configuredRoles();
	const byId = nodeMap(params.nodes);
	validateRoles(params.nodes, roles);
	validateDependencies(params.nodes, byId);
	validateRoleOrder(params.nodes, byId);
	const waves = executionWaves(params.nodes, params.maxParallel ?? 3);
	validateBuilders(waves, byId, params.allowParallelBuilders ?? false);
	const manifestPath = await saveManifest(params, ctx, waves);
	return {
		content: [
			{
				type: "text",
				text: `Validated ${params.nodes.length} visible Pi nodes in ${waves.length} wave(s). Manifest: ${manifestPath}\n${waves.map((wave, index) => `Wave ${index + 1}: ${wave.join(", ")}`).join("\n")}`,
			},
		],
		details: { manifestPath, waves, nodeCount: params.nodes.length },
	};
}

export default function advisorGraphExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "advisor_graph_plan",
		label: "Advisor Graph",
		description:
			"Validate and persist a bounded DAG of visible Pi role agents. It checks roles, dependencies, cycles, checker/browser order, reducer fan-in, anchors, concurrency, and worktree isolation. It never launches hidden agents.",
		parameters: GraphParameters,
		async execute(...args) {
			const [, params, , , ctx] = args;
			try {
				return await planGraph(params, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Advisor graph rejected: ${message}` }],
					details: {},
				};
			}
		},
	});
}
