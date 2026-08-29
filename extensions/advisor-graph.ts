import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const GRAPH_IDENTIFIER = /^[a-z][a-z0-9-]{0,47}$/;

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
	warnings?: GraphWarning[];
}

interface GraphWarning {
	code: "checker-without-builder" | "browser-without-builder" | "reducer-low-fan-in";
	nodeId: string;
	message: string;
}

interface RoleProfiles {
	profiles?: Record<string, unknown>;
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

function validateStructuralParameters(params: GraphParams): void {
	if (!GRAPH_IDENTIFIER.test(params.graphId)) throw new Error(`Malformed graph id: ${params.graphId}`);
	if (params.nodes.length < 1 || params.nodes.length > 24) {
		throw new Error("Graph must contain between 1 and 24 nodes");
	}
	const maxParallel = params.maxParallel ?? 3;
	if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 6) {
		throw new Error("maxParallel must be an integer between 1 and 6");
	}
	const maxRepairLoops = params.maxRepairLoops ?? 2;
	if (!Number.isInteger(maxRepairLoops) || maxRepairLoops < 0 || maxRepairLoops > 3) {
		throw new Error("maxRepairLoops must be an integer between 0 and 3");
	}
	for (const node of params.nodes) {
		if (!GRAPH_IDENTIFIER.test(node.id)) throw new Error(`Malformed graph node id: ${node.id}`);
		if (!GRAPH_IDENTIFIER.test(node.role)) throw new Error(`Malformed graph role: ${node.role}`);
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
		if (node.role === "freeform") continue;
		if (!roles.has(node.role)) {
			throw new Error(`Node ${node.id} uses unknown role ${node.role}; use "freeform" for a role-less worker`);
		}
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

function roleOrderWarnings(nodes: GraphNode[], byId: Map<string, GraphNode>): GraphWarning[] {
	const warnings: GraphWarning[] = [];
	for (const node of nodes) {
		const dependencies = dependencyClosure(node, byId);
		if (node.role === "checker") {
			const checksBuilder = [...dependencies].some((id) => byId.get(id)?.role === "builder");
			if (!checksBuilder) {
				warnings.push({
					code: "checker-without-builder",
					nodeId: node.id,
					message: `Checker ${node.id} has no builder ancestor; confirm this is an intentional baseline or audit review.`,
				});
			}
		}
		if (node.role === "browser-verifier") {
			const verifiesBuilder = [...dependencies].some((id) => byId.get(id)?.role === "builder");
			if (!verifiesBuilder) {
				warnings.push({
					code: "browser-without-builder",
					nodeId: node.id,
					message: `Browser verifier ${node.id} has no builder ancestor; confirm this is intentional baseline investigation.`,
				});
			}
		}
		if (node.role === "reducer" && (node.dependsOn?.length ?? 0) < 2) {
			warnings.push({
				code: "reducer-low-fan-in",
				nodeId: node.id,
				message: `Reducer ${node.id} has fewer than two upstream nodes; confirm reduction adds value.`,
			});
		}
	}
	return warnings;
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
	warnings: GraphWarning[],
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
		warnings,
		createdAt: new Date().toISOString(),
	};
}

async function saveManifest(
	params: GraphParams,
	ctx: ExtensionContext,
	waves: string[][],
	warnings: GraphWarning[],
): Promise<string> {
	const directory = join(await advisorStateRoot(ctx.cwd), "graphs");
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${params.graphId}.json`);
	await writeFile(path, `${JSON.stringify(manifest(params, ctx, waves, warnings), null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
	return path;
}

async function planGraph(params: GraphParams, ctx: ExtensionContext): Promise<AgentToolResult<GraphDetails>> {
	if (!process.env.ADVISOR_WORKSTREAM) throw new Error("Invoke /advisor before planning a graph");
	validateStructuralParameters(params);
	const roles = await configuredRoles();
	const byId = nodeMap(params.nodes);
	validateRoles(params.nodes, roles);
	validateDependencies(params.nodes, byId);
	const warnings = roleOrderWarnings(params.nodes, byId);
	const waves = executionWaves(params.nodes, params.maxParallel ?? 3);
	validateBuilders(waves, byId, params.allowParallelBuilders ?? false);
	const manifestPath = await saveManifest(params, ctx, waves, warnings);
	const warningText = warnings.length
		? `\nAdvisory warnings (${warnings.length}; non-blocking):\n${warnings.map((warning) => `- [${warning.code}] ${warning.message}`).join("\n")}\nConfirm these graph shapes are intentional before launch.`
		: "\nAdvisory warnings: none.";
	return {
		content: [
			{
				type: "text",
				text: `Structurally validated ${params.nodes.length} visible Pi nodes in ${waves.length} wave(s). Manifest: ${manifestPath}\n${waves.map((wave, index) => `Wave ${index + 1}: ${wave.join(", ")}`).join("\n")}${warningText}`,
			},
		],
		details: { manifestPath, waves, nodeCount: params.nodes.length, warnings },
	};
}

export default function advisorGraphExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "advisor_graph_plan",
		label: "Advisor Graph",
		description:
			"Structurally validate, lint, and persist a bounded DAG of visible Pi role agents. Malformed structure and unsafe builder concurrency are rejected; role-order and reducer-shape concerns are returned as non-blocking warnings. It never launches hidden agents.",
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
