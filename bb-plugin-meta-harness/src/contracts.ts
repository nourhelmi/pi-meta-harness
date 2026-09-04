import { defineRpcContract, type StandardSchemaV1 } from "@get-bb/plugin-sdk";
import { z } from "zod";

export type Branded<T, B extends string> = T & { readonly __brand: B };
export type RunId = Branded<string, "RunId">;
export type ThreadId = Branded<string, "ThreadId">;
export type GraphId = Branded<string, "GraphId">;
export type NodeId = Branded<string, "NodeId">;
export type HostId = Branded<string, "HostId">;
export type SettlementGeneration = Branded<string, "SettlementGeneration">;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const path = z.string().min(1).max(4096);
const version = z.literal("1");
const reasoning = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const absolutePath = path.refine((value) => value.startsWith("/"), "expected an absolute path");
const sdkSchema = <Schema extends z.ZodType>(schema: Schema) => schema as Schema & StandardSchemaV1<z.input<Schema>, z.output<Schema>>;

export const agentStartRequest = z.object({
  version, runId: id, logicalParentThreadId: id, projectId: id, environmentId: id,
  hostId: id, cwd: absolutePath, label: z.string().min(1).max(4096), prompt: z.string().min(1).max(1_000_000),
  providerId: z.literal("pi"), model, reasoning,
  resultPath: absolutePath.optional(),
  bootstrap: z.object({ role: id, maxTurns: z.number().int().min(1).max(100), allowSubagents: z.boolean() }).strict().optional(),
  continuation: z.boolean().optional(),
}).strict().superRefine((value, context) => {
	if (Boolean(value.bootstrap) !== Boolean(value.resultPath)) {
		context.addIssue({ code: "custom", message: "worker bootstrap and resultPath must be supplied together" });
	}
});
export const agentWaitRequest = z.object({ version, runId: id, threadId: id, until: z.enum(["active", "idle"]) }).strict();
export const agentStopRequest = z.object({ version, runId: id, threadId: id }).strict();
export const wakeAuthorizeRequest = z.object({ version, runId: id, threadId: id, logicalParentThreadId: id, settlementGeneration: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const bootstrapClaimRequest = z.object({ version, token: z.string().regex(/^[A-Za-z0-9_-]{32,4096}$/u), threadId: id }).strict();

export const graphSnapshot = z.object({
	graphId: id, hash: z.string().regex(/^[a-f0-9]{64}$/u), waves: z.array(z.object({ index: z.number().int().positive(), nodeIds: z.array(id) }).strict()),
	nodes: z.array(z.object({
		id, role: z.string(), dependsOn: z.array(id), worktree: path, status: z.string(),
		runId: id.optional(), threadId: id.optional(), hostId: id.optional(), threadState: z.string().optional(),
		resultStatus: z.string().optional(), logPath: path.optional(), logTail: z.string().optional(),
		artifactPath: path.optional(), artifact: z.string().optional(),
	}).strict()),
	edges: z.array(z.object({ from: id, to: id }).strict()),
	launchReservations: z.array(z.object({
		runId: id,
		state: z.enum(["reserved", "bound", "failed", "unknown"]),
		threadId: id.optional(),
		hostId: id,
		projectId: id,
		cwd: path,
		createdAt: z.number().int(),
		updatedAt: z.number().int(),
		failureReason: z.string().optional(),
	}).strict()),
	wakeAdmissions: z.array(z.object({ logicalParentThreadId: id, settlementGeneration: z.string(), runId: id, state: z.enum(["pending", "claimed", "sent", "unknown"]), operatorSkippedAt: z.number().int().optional() }).strict()),
}).strict();

export const metaHarnessRpcContract = defineRpcContract({
  snapshot: { input: sdkSchema(z.object({ graphId: id }).strict()), output: sdkSchema(graphSnapshot) },
  stop: { input: sdkSchema(z.object({ threadId: id }).strict()), output: sdkSchema(z.object({ ok: z.literal(true) }).strict()) },
  message: { input: sdkSchema(z.object({ threadId: id, text: z.string().min(1).max(100_000) }).strict()), output: sdkSchema(z.object({ ok: z.literal(true) }).strict()) },
	answerBlocked: { input: sdkSchema(z.object({ runId: id, threadId: id, answer: z.literal("BB-POC-CONTINUE") }).strict()), output: sdkSchema(z.object({ ok: z.literal(true) }).strict()) },
	retryWake: { input: sdkSchema(z.object({ logicalParentThreadId: id, settlementGeneration: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()), output: sdkSchema(z.object({ ok: z.literal(true) }).strict()) },
	skipWake: { input: sdkSchema(z.object({ logicalParentThreadId: id, settlementGeneration: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()), output: sdkSchema(z.object({ ok: z.literal(true) }).strict()) },
});

export const hostRpcContract = defineRpcContract({
  snapshotGraph: { input: sdkSchema(z.object({ graphId: id }).strict()), output: sdkSchema(z.object({ content: z.string(), path }).strict()) },
  snapshotRun: { input: sdkSchema(z.object({ runId: id }).strict()), output: sdkSchema(z.object({ content: z.string(), path }).strict()) },
  readReservedResult: { input: sdkSchema(z.object({ runId: id }).strict()), output: sdkSchema(z.object({ content: z.string(), path }).strict()) },
  tailLog: { input: sdkSchema(z.object({ runId: id, maxBytes: z.number().int().min(1).max(262_144) }).strict()), output: sdkSchema(z.object({ content: z.string(), path }).strict()) },
	watchRun: { input: sdkSchema(z.object({ runId: id }).strict()), output: sdkSchema(z.object({ watching: z.literal(true), root: path }).strict()) },
});

export const hostSignals = {
	projectionChanged: { payload: sdkSchema(z.object({ runId: id }).strict()) },
} as const;

export type AgentStartRequest = z.infer<typeof agentStartRequest>;
