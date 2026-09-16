import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile, rename, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { artifactRead, canonicalLocation } from "../scripts/advisor-runtime/security.mjs";
import { isDeepStrictEqual } from "node:util";
import { readChildScope, type ChildScope } from "../scripts/advisor-runtime/pi-detach-bootstrap.mjs";

const GRAPH_IDENTIFIER = /^[a-z][a-z0-9-]{0,47}$/;

const GraphNodeSchema = Type.Object({
	id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }),
	role: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }),
	task: Type.String({ minLength: 1 }),
	anchor: Type.Optional(Type.String({ minLength: 1 })),
	acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	requiredSkills: Type.Optional(Type.Array(Type.String())),
	dependsOn: Type.Optional(Type.Array(Type.String())),
	worktree: Type.Optional(Type.String()),
	keepAlive: Type.Optional(Type.Boolean()),
});
const GraphParameters = Type.Object({
	graphId: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }),
	goal: Type.String({ minLength: 1 }),
	nodes: Type.Array(GraphNodeSchema, { minItems: 1 }),
	maxParallel: Type.Optional(Type.Integer({ minimum: 1, default: 3 })),
	maxRepairLoops: Type.Optional(Type.Integer({ minimum: 0, description: "Legacy repair accounting metadata; never limits execution." })),
	allowParallelBuilders: Type.Optional(Type.Boolean({ description: "Legacy metadata only; writer coordination belongs to the advisor.", default: false })),
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
	code: "checker-without-builder" | "browser-without-builder";
	nodeId: string;
	message: string;
}

const MAKER_ROLES = new Set(["builder", "advisor", "foreman"]); // Historical foreman manifests remain readable.

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
	if (params.nodes.length < 1) {
		throw new Error("Graph must contain at least one node");
	}
	const maxParallel = params.maxParallel ?? 3;
	if (!Number.isInteger(maxParallel) || maxParallel < 1) {
		throw new Error("maxParallel must be a positive integer");
	}
	const maxRepairLoops = params.maxRepairLoops ?? 0;
	if (!Number.isInteger(maxRepairLoops) || maxRepairLoops < 0) {
		throw new Error("maxRepairLoops must be a non-negative integer");
	}
	for (const node of params.nodes) {
		if (!GRAPH_IDENTIFIER.test(node.id)) throw new Error(`Malformed graph node id: ${node.id}`);
		if (!GRAPH_IDENTIFIER.test(node.role)) throw new Error(`Malformed graph role: ${node.role}`);
		const criteria = [...(node.acceptance ?? []), ...(node.anchor ? [node.anchor] : [])].filter(
			(criterion) => criterion.trim(),
		);
		if (criteria.length === 0) {
			throw new Error(`Node ${node.id} needs a done-when line (anchor or acceptance)`);
		}
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
			const checksBuilder = [...dependencies].some((id) => MAKER_ROLES.has(byId.get(id)?.role ?? ""));
			if (!checksBuilder) {
				warnings.push({
					code: "checker-without-builder",
					nodeId: node.id,
					message: `Checker ${node.id} has no maker ancestor; confirm this is an intentional baseline or audit review.`,
				});
			}
		}
		if (node.role === "browser-verifier") {
			const verifiesBuilder = [...dependencies].some((id) => MAKER_ROLES.has(byId.get(id)?.role ?? ""));
			if (!verifiesBuilder) {
				warnings.push({
					code: "browser-without-builder",
					nodeId: node.id,
					message: `Browser verifier ${node.id} has no maker ancestor; confirm this is intentional baseline investigation.`,
				});
			}
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

function manifest(
	params: GraphParams,
	ctx: ExtensionContext,
	waves: string[][],
	warnings: GraphWarning[],
	childScope: ChildScope | null,
): object {
	return {
		version: 1,
		graphId: params.graphId,
		goal: params.goal,
		advisorSessionId: ctx.sessionManager.getSessionId(),
		workstream: childScope?.family.workstream ?? process.env.ADVISOR_WORKSTREAM,
		...(childScope ? { parentOutcome: childScope.parent } : {}),
		maxParallel: params.maxParallel ?? 3,
		maxRepairLoops: params.maxRepairLoops ?? 0,
		allowParallelBuilders: params.allowParallelBuilders ?? false,
		nodes: params.nodes,
		waves,
		warnings,
		createdAt: new Date().toISOString(),
	};
}

const manifestWrites = new Map<string, Promise<string>>();
async function saveManifest(params: GraphParams, ctx: ExtensionContext, waves: string[][], warnings: GraphWarning[], childScope: ChildScope | null): Promise<string> {
  const key = join(childScope?.stateRoot ?? await advisorStateRoot(ctx.cwd), "graphs", params.graphId);
  const write = (manifestWrites.get(key) ?? Promise.resolve("")).catch(() => "").then(() => saveManifestNow(params, ctx, waves, warnings, childScope));
  manifestWrites.set(key, write);
  try { return await write; } finally { if (manifestWrites.get(key) === write) manifestWrites.delete(key); }
}

async function saveManifestNow(
	params: GraphParams,
	ctx: ExtensionContext,
	waves: string[][],
	warnings: GraphWarning[],
	childScope: ChildScope | null,
): Promise<string> {
	const directory = join(childScope?.stateRoot ?? await advisorStateRoot(ctx.cwd), "graphs");
	await mkdir(directory, { recursive: true });
	const canonicalDirectory = await realpath(directory);
	canonicalLocation(canonicalDirectory);
	const path = join(canonicalDirectory, `${params.graphId}.json`);
	const next = manifest(params, ctx, waves, warnings, childScope) as Record<string, unknown>;
	let previous: Record<string, unknown> | undefined;
	try { previous = JSON.parse(artifactRead(canonicalDirectory, `${params.graphId}.json`).text); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (previous) {
		if (previous.advisorSessionId !== next.advisorSessionId || !isDeepStrictEqual(previous.parentOutcome, next.parentOutcome)) throw new Error("Graph belongs to a different advisor session or parent outcome");
		const { revisions = [], ...prior } = previous;
		if (!Array.isArray(revisions)) throw new Error("Invalid graph revision history");
		next.revisions = [...revisions, prior];
	}
	if (!previous) { await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); return path; }
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	await rename(temporary, path);
	return path;
}

async function planGraph(params: GraphParams, ctx: ExtensionContext): Promise<AgentToolResult<GraphDetails>> {
	const childScope = await readChildScope({ cwd: ctx.cwd });
	if (!childScope && !process.env.ADVISOR_WORKSTREAM) throw new Error("Invoke /advisor before planning a root graph, or use a runtime-issued child advisor scope");
	validateStructuralParameters(params);
	const roles = await configuredRoles();
	const byId = nodeMap(params.nodes);
	validateRoles(params.nodes, roles);
	validateDependencies(params.nodes, byId);
	const warnings = roleOrderWarnings(params.nodes, byId);
	const waves = executionWaves(params.nodes, params.maxParallel ?? 3);
	const manifestPath = await saveManifest(params, ctx, waves, warnings, childScope);
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
    name: "advisor_graph_evidence",
    label: "Graph evidence",
    description: "Optionally bind or refresh an owned outcome attempt. The returned reference can accompany a launch/followup to record evidence provenance; stale or missing evidence does not prohibit execution. Current output may supersede historical failed checks. For an explicit successor supply runId/attempt plus replacesRunId/replacesAttempt after prior ownership resolves; history remains. Never launches or verifies work.",
    parameters: Type.Object({ graphId: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }), node: Type.String(), runId: Type.Optional(Type.String()), attempt: Type.Optional(Type.Integer({ minimum: 1 })), replacesRunId: Type.Optional(Type.String()), replacesAttempt: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!GRAPH_IDENTIFIER.test(params.graphId)) throw new Error("Malformed graph id");
      const childScope = await readChildScope({ cwd: ctx.cwd });
      const path = join(childScope?.stateRoot ?? await advisorStateRoot(ctx.cwd), "graphs", `${params.graphId}.json`);
      let plan;
      try { plan = JSON.parse(await readFile(path, "utf8")); }
      catch (cause) { throw new Error("Graph manifest is unreadable or malformed; recover the accepted plan before binding evidence", { cause }); }
      if (plan.advisorSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Graph belongs to a different advisor session");
      if (!isDeepStrictEqual(plan.parentOutcome, childScope?.parent)) throw new Error("Graph belongs to a different parent outcome");
      const request: { sessionId: string; action: string; payload: object; response?: Promise<unknown> } = {
        sessionId: ctx.sessionManager.getSessionId(), action: "graph.evidence",
        payload: { graph: { graphId: plan.graphId, advisorSessionId: plan.advisorSessionId, maxRepairLoops: plan.maxRepairLoops ?? 0,
          ...(childScope ? { parentOutcome: childScope.parent } : {}),
          contract: createHash("sha256").update(JSON.stringify({ ...plan, createdAt: undefined, warnings: undefined, revisions: undefined })).digest("hex"),
          nodes: plan.nodes.map((node: GraphNode) => ({ id: node.id, task: node.task, dependsOn: node.dependsOn ?? [] })) },
          node: params.node, ...(params.runId ? { runId: params.runId } : {}), ...(params.attempt !== undefined ? { attempt: params.attempt } : {}),
          ...(params.replacesRunId !== undefined ? { replacesRunId: params.replacesRunId } : {}), ...(params.replacesAttempt !== undefined ? { replacesAttempt: params.replacesAttempt } : {}) },
      };
      pi.events.emit("pi-detach:request", request);
      if (!request.response) throw new Error("Managed pi-detach runtime is required for evidence; plan remains unchanged");
      const evidence = await request.response;
      return { content: [{ type: "text", text: JSON.stringify(evidence) }], details: { manifestPath: path, evidence } };
    },
  });
	pi.registerTool({
		name: "advisor_graph_plan",
		label: "Advisor Graph",
		description:
			"Structurally validate, lint, and persist a DAG of visible Pi role agents. Malformed structure is rejected; review-order concerns are non-blocking warnings. Writer coordination belongs to the advisor, not graph admission. It never launches agents.",
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
