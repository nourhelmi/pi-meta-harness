import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type {
  BbPluginApi,
  MessageDispatchHookContext,
} from "@get-bb/plugin-sdk";
import {
  agentStartRequest,
  agentStopRequest,
  agentWaitRequest,
  bootstrapClaimRequest,
  hostRpcContract,
	hostSignals,
  metaHarnessRpcContract,
  wakeAuthorizeRequest,
  type AgentStartRequest,
} from "./contracts.js";
import {
  createCorrelationStore,
  fingerprint,
  newBootstrapToken,
  tokenHash,
  type Correlation,
  type LaunchReservation,
} from "./correlation-store.js";
import { createWakeAdmissionStore } from "./wake-admission.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CONTINUE_TOKEN = "BB-POC-CONTINUE";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function graphFromPrompt(prompt: string): string | undefined {
  return /^(?:GRAPH|GRAPH ID):\s*([a-z][a-z0-9-]{0,47})\s*$/imu.exec(prompt)?.[1];
}

function nodeFromLabel(label: string): string | undefined {
  const candidate = label.split("·").at(-1)?.trim();
  return candidate && SAFE_ID.test(candidate) ? candidate : undefined;
}

function bootstrapToken(input: AgentStartRequest, random: string): string {
	if (!input.bootstrap || !input.resultPath) throw new Error("worker bootstrap requires typed metadata and a result path");
  return Buffer.from(
    JSON.stringify({
      v: 1,
      n: random,
		r: input.bootstrap.role,
		d: dirname(input.resultPath),
      m: input.model,
      q: input.reasoning,
		x: input.bootstrap.allowSubagents,
		c: input.bootstrap.maxTurns,
    }),
  ).toString("base64url");
}

function launchFingerprint(input: AgentStartRequest): string {
  return fingerprint({
    version: input.version,
    runId: input.runId,
    logicalParentThreadId: input.logicalParentThreadId,
    logicalParentEnvironmentId: input.environmentId,
    projectId: input.projectId,
    hostId: input.hostId,
    cwd: input.cwd,
    label: input.label,
    prompt: input.prompt,
    providerId: input.providerId,
    model: input.model,
    reasoning: input.reasoning,
    resultPath: input.resultPath ?? null,
    bootstrap: input.bootstrap ?? null,
  });
}

function launchReservation(
  input: AgentStartRequest,
  pluginId: string,
  bootstrapTokenHash: string,
): LaunchReservation {
  const now = Date.now();
  const graphId = graphFromPrompt(input.prompt);
  const nodeId = nodeFromLabel(input.label);
  return {
    runId: input.runId,
    bootstrapTokenHash,
    requestFingerprint: launchFingerprint(input),
    logicalParentThreadId: input.logicalParentThreadId,
    logicalParentEnvironmentId: input.environmentId,
    ...(graphId ? { graphId } : {}),
    ...(nodeId ? { nodeId } : {}),
    projectId: input.projectId,
    hostId: input.hostId,
    cwd: input.cwd,
    providerId: input.providerId,
    model: input.model,
    reasoning: input.reasoning,
    expectedOrigin: "plugin",
    expectedOriginPluginId: pluginId,
    expectedVisibility: "visible",
    expectedParentThreadId: null,
    expectedOriginKind: null,
    expectedWorkspaceProvisionType: "unmanaged",
    bootstrapRequired: input.bootstrap !== undefined,
    state: "reserved",
    createdAt: now,
    updatedAt: now,
  };
}

function continuationIdentityMatches(
  input: AgentStartRequest,
  reservation: LaunchReservation,
): boolean {
  return (
    input.runId === reservation.runId &&
    input.logicalParentThreadId === reservation.logicalParentThreadId &&
    input.environmentId === reservation.logicalParentEnvironmentId &&
    input.projectId === reservation.projectId &&
    input.hostId === reservation.hostId &&
    input.cwd === reservation.cwd &&
    input.providerId === reservation.providerId &&
    input.model === reservation.model &&
    input.reasoning === reservation.reasoning &&
    Boolean(input.bootstrap) === reservation.bootstrapRequired &&
    nodeFromLabel(input.label) === reservation.nodeId
  );
}

function dispatchIdentityMismatch(
  reservation: LaunchReservation,
  context: MessageDispatchHookContext,
): string | undefined {
  const { environment, host, project, requestedExecution, thread } = context;
  if (reservation.threadId !== undefined && thread.id !== reservation.threadId) {
    return "bound thread";
  }
  if (thread.projectId !== reservation.projectId || project.id !== reservation.projectId) {
    return "project";
  }
  if (thread.providerId !== reservation.providerId) return "thread provider";
  if (requestedExecution.providerId !== reservation.providerId) {
    return "requested provider";
  }
  if (requestedExecution.model !== reservation.model) return "requested model";
  if (requestedExecution.reasoningLevel !== reservation.reasoning) {
    return "requested reasoning";
  }
  if (context.origin !== reservation.expectedOrigin) return "dispatch origin";
  if (context.originPluginId !== reservation.expectedOriginPluginId) {
    return "dispatch origin plugin";
  }
  if (thread.originPluginId !== reservation.expectedOriginPluginId) {
    return "thread origin plugin";
  }
  if (
    context.parentThreadId !== reservation.expectedParentThreadId ||
    thread.parentThreadId !== reservation.expectedParentThreadId
  ) {
    return "parent topology";
  }
  if (thread.originKind !== reservation.expectedOriginKind) return "origin topology";
  if (thread.visibility !== reservation.expectedVisibility) return "visibility";
  if (context.attempt !== "start-turn") return "dispatch attempt";
  if (context.startedOnBehalfOf !== null) return "delegated topology";
  if (!environment || !thread.environmentId || environment.id !== thread.environmentId) {
    return "environment";
  }
  if (
    reservation.environmentId !== undefined &&
    environment.id !== reservation.environmentId
  ) {
    return "bound environment";
  }
  if (
    environment.projectId !== reservation.projectId ||
    environment.hostId !== reservation.hostId ||
    environment.path !== reservation.cwd ||
    environment.workspaceProvisionType !== reservation.expectedWorkspaceProvisionType
  ) {
    return "environment identity";
  }
  if (!host || host.id !== reservation.hostId) return "host";
  return undefined;
}

function decodeBootstrap(token: string): {
  v: 1;
  r?: string;
  d?: string;
  m: string;
  q: string;
  x: boolean;
  c: number;
} {
  const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
  if (
    value.v !== 1 ||
	typeof value.n !== "string" ||
	!value.n ||
    typeof value.m !== "string" ||
    typeof value.q !== "string" ||
    typeof value.x !== "boolean" ||
    !Number.isSafeInteger(value.c) ||
    Number(value.c) < 1 ||
    Number(value.c) > 100 ||
    (value.r !== undefined && (typeof value.r !== "string" || !SAFE_ID.test(value.r))) ||
    (value.d !== undefined && typeof value.d !== "string")
  ) {
    throw new Error("malformed bootstrap token");
  }
  return value as ReturnType<typeof decodeBootstrap>;
}

function threadIdOf(value: unknown): string {
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "string") throw new Error("BB spawn returned no thread id");
  return id;
}

interface CanonicalGraphNode {
  id: string;
  role: string;
  dependsOn: string[];
  worktree: string;
}

interface CanonicalGraph {
  graphId: string;
  nodes: CanonicalGraphNode[];
  waves: string[][];
}

interface CanonicalRunState {
  runId: string;
  label: string;
  status: string;
  transportState: "running" | "paused" | "finished";
  agentState?: string;
  resultStatus?: string;
  settlementDecision: "wait" | "pause" | "finish";
  settlementGeneration?: string;
  resultPath?: string;
  logPath?: string;
  surface?: { kind?: string; threadId?: string; hostId?: string };
}

function parseGraph(content: string, graphId: string): CanonicalGraph {
  const value = JSON.parse(content) as Record<string, unknown>;
  if (value.graphId !== graphId || !Array.isArray(value.nodes) || !Array.isArray(value.waves)) {
    throw new Error("canonical graph manifest is malformed or mismatched");
  }
  const nodes = value.nodes.map((raw) => {
    const node = raw as Record<string, unknown>;
    const dependsOn = node.dependsOn ?? [];
    if (
      typeof node.id !== "string" ||
      !SAFE_ID.test(node.id) ||
      typeof node.role !== "string" ||
      typeof node.worktree !== "string" ||
      !Array.isArray(dependsOn) ||
      !dependsOn.every((item) => typeof item === "string" && SAFE_ID.test(item))
    ) {
      throw new Error("canonical graph node is malformed");
    }
    return { id: node.id, role: node.role, worktree: node.worktree, dependsOn } as CanonicalGraphNode;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
	if (nodeIds.size !== nodes.length || nodes.some((node) => node.dependsOn.some((dependency) => !nodeIds.has(dependency)))) {
		throw new Error("canonical graph dependencies are malformed");
	}
  const waves = value.waves.map((wave) => {
    if (!Array.isArray(wave) || !wave.every((item) => typeof item === "string" && nodeIds.has(item))) {
      throw new Error("canonical graph wave is malformed");
    }
    return wave as string[];
  });
  return { graphId, nodes, waves };
}

function parseRun(content: string, correlation: Correlation): CanonicalRunState {
  const value = JSON.parse(content) as Record<string, unknown>;
  const surface = value.surface as Record<string, unknown> | undefined;
  if (
    value.runId !== correlation.runId ||
    typeof value.label !== "string" ||
    typeof value.status !== "string" ||
    !["running", "paused", "finished"].includes(String(value.transportState)) ||
    !["wait", "pause", "finish"].includes(String(value.settlementDecision)) ||
    surface?.kind !== "bb" ||
    surface.threadId !== correlation.threadId ||
    surface.hostId !== correlation.hostId
  ) {
    throw new Error("pi-detach run projection is malformed or mismatched");
  }
  return value as unknown as CanonicalRunState;
}

function textParts(history: unknown[]): string[] {
  return history.flatMap((entry) => {
    const input = (entry as { input?: unknown }).input;
    if (!Array.isArray(input)) return [];
    return input.flatMap((part) => {
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
    });
  });
}

export default async function metaHarnessPlugin(bb: BbPluginApi): Promise<void> {
  const db = bb.storage.database();
  const correlations = createCorrelationStore(db);
  const wakes = createWakeAdmissionStore(db);
  wakes.reconcileClaimed();
	const host = bb.hosts.experimental_client({ contract: hostRpcContract, experimental_signals: hostSignals });
  const blockedAnswersInFlight = new Set<string>();
	const blockedAnswersSent = new Set<string>();
	host.experimental_onSignal("projectionChanged", ({ payload }) => {
	  bb.realtime.publish("projection-invalidated", { runId: payload.runId });
	});
	host.experimental_onWorkerExit(({ hostId }) => {
	  bb.realtime.publish("projection-invalidated", { hostId });
	});

  bb.experimental_hooks.on("message.dispatch", async (context) => {
    const marker = /^\[\[bb-meta-worker:v1:([A-Za-z0-9_-]{32,4096})\]\]/u.exec(context.input.text);
	const threadCorrelation = correlations.list().find((item) => item.threadId === context.thread.id);
	if (marker) {
	  const token = marker[1] ?? "";
	  const reservation = correlations.getReservationByToken(token);
	  if (!reservation || !reservation.bootstrapRequired) {
		return { action: "reject", message: "Meta Harness rejected an unrecognized bootstrap marker." };
	  }
	  const mismatch = dispatchIdentityMismatch(reservation, context);
	  if (mismatch) {
		if (reservation.state === "reserved") {
		  try {
			correlations.mark(reservation.runId, "failed", `dispatch mismatch: ${mismatch}`);
		  } catch (error) {
			bb.log.error(`could not persist rejected bootstrap dispatch: ${String(error)}`);
		  }
		}
		return { action: "reject", message: `Meta Harness rejected a bootstrap ${mismatch} mismatch.` };
	  }
	  try {
		const binding = correlations.bind(
		  reservation.bootstrapTokenHash,
		  context.thread.id,
		  context.environment!.id,
		);
		if (binding.kind === "thread-mismatch") {
		  return { action: "reject", message: "Meta Harness rejected a thread-mismatched bootstrap marker." };
		}
		if (binding.kind !== "bound") {
		  return { action: "reject", message: "Meta Harness rejected an unavailable bootstrap reservation." };
		}
		if (binding.correlation.bootstrapClaimedAt !== undefined) {
		  return { action: "reject", message: "Meta Harness rejected a replayed bootstrap marker." };
		}
		return { action: "proceed" };
	  } catch (error) {
		bb.log.error(`bootstrap bind persistence failed: ${String(error)}`);
		return { action: "reject", message: "Meta Harness rejected a bootstrap persistence failure." };
	  }
	}
	if (/^\[\[bb-meta-worker:/u.test(context.input.text)) {
	  return { action: "reject", message: "Meta Harness rejected a malformed bootstrap marker." };
	}
	if (threadCorrelation && threadCorrelation.bootstrapClaimedAt === undefined) {
	  return { action: "reject", message: "Meta Harness rejected a missing worker bootstrap marker." };
	}
	const missingReservation = correlations.listReservations().find(
	  (reservation) =>
		reservation.bootstrapRequired &&
		reservation.state === "reserved" &&
		dispatchIdentityMismatch(reservation, context) === undefined,
	);
	if (missingReservation) {
	  try {
		correlations.mark(missingReservation.runId, "failed", "dispatch missing bootstrap marker");
	  } catch (error) {
		bb.log.error(`could not persist missing bootstrap marker: ${String(error)}`);
	  }
	  return { action: "reject", message: "Meta Harness rejected a missing worker bootstrap marker." };
	}
	if (threadCorrelation) {
	  const key = `${threadCorrelation.runId}:${threadCorrelation.threadId}`;
	  let run: CanonicalRunState | undefined;
	  try { run = await canonicalRun(threadCorrelation); } catch { /* advisor roots have no pi-detach projection */ }
	  if (run?.transportState === "paused" && run.agentState === "blocked") {
		// BB does not preserve originPluginId for every public threads.send path. The
		// one-shot run/thread admission is the authority; an origin hint is not.
		if (
		  context.input.text.trim() !== CONTINUE_TOKEN ||
		  !blockedAnswersInFlight.has(key)
		) {
		  return { action: "reject", message: "Meta Harness requires its typed BLOCKED answer control." };
		}
	  } else if (context.input.text.trim() === CONTINUE_TOKEN) {
		return { action: "reject", message: "Meta Harness rejected an out-of-state BLOCKED token." };
	  }
	}
	return { action: "proceed" };
  });

  async function verifyParent(input: AgentStartRequest): Promise<void> {
    const parent = await bb.sdk.threads.get({ threadId: input.logicalParentThreadId });
	if (parent.id !== input.logicalParentThreadId || parent.projectId !== input.projectId || parent.environmentId !== input.environmentId) {
      throw new Error("logical parent routing mismatch");
    }
  }

  async function verifiedThread(
    input: AgentStartRequest,
    threadId: string,
    expectedEnvironmentId?: string,
  ) {
    const full = await bb.sdk.threads.get({ threadId, include: "environment,host" });
    const environment = (
      full as typeof full & {
        environment?: {
          id: string;
          projectId: string;
          hostId: string;
          path: string | null;
          workspaceProvisionType: string;
        } | null;
      }
    ).environment;
    if (
      !full.environmentId ||
      full.id !== threadId ||
      full.projectId !== input.projectId ||
      full.providerId !== "pi" ||
      full.parentThreadId !== null ||
      full.originKind !== null ||
      full.originPluginId !== bb.pluginId ||
      full.visibility !== "visible" ||
      environment?.id !== full.environmentId ||
      environment.projectId !== input.projectId ||
      environment?.hostId !== input.hostId ||
      environment.path !== input.cwd ||
      environment.workspaceProvisionType !== "unmanaged" ||
      (expectedEnvironmentId !== undefined && full.environmentId !== expectedEnvironmentId)
    ) {
      throw new Error("spawned BB thread identity mismatch");
    }
    return full.environmentId;
  }

  function startResponse(input: AgentStartRequest, correlation: Correlation, environmentId: string) {
    return {
      version: "1" as const,
      runId: input.runId,
      threadId: correlation.threadId,
      logicalParentThreadId: correlation.logicalParentThreadId,
      hostId: correlation.hostId,
      projectId: input.projectId,
      environmentId,
      providerId: "pi" as const,
      model: input.model,
      reasoning: input.reasoning,
      cwd: input.cwd,
    };
  }

  async function canonicalRun(correlation: Correlation): Promise<CanonicalRunState> {
    const raw = await host.call(
      "snapshotRun",
      { runId: correlation.runId },
      { hostId: correlation.hostId },
    );
    return parseRun(raw.content, correlation);
  }

  async function answerBlocked(correlation: Correlation): Promise<void> {
    const key = `${correlation.runId}:${correlation.threadId}`;
	if (blockedAnswersInFlight.has(key) || blockedAnswersSent.has(key)) throw new Error("BLOCKED answer replay rejected");
    blockedAnswersInFlight.add(key);
    try {
      const run = await canonicalRun(correlation);
      if (
        run.transportState !== "paused" ||
        run.agentState !== "blocked" ||
        !/^BLOCKED\b/iu.test(run.resultStatus ?? "")
      ) {
        throw new Error("run is not canonically BLOCKED");
      }
      const history = await bb.sdk.threads.promptHistory({ threadId: correlation.threadId, limit: "100" });
      if (textParts(history).some((text) => text.trim() === CONTINUE_TOKEN)) {
        throw new Error("BLOCKED answer replay rejected");
      }
	  try {
		await bb.sdk.threads.send({
          threadId: correlation.threadId,
          mode: "auto",
          input: [{ type: "text", text: CONTINUE_TOKEN, mentions: [] }],
        });
		blockedAnswersSent.add(key);
	  } finally {
		blockedAnswersInFlight.delete(key);
	  }
      bb.realtime.publish("projection-invalidated", { runId: correlation.runId });
    } catch (error) {
	  blockedAnswersInFlight.delete(key);
      throw error;
    }
  }

  async function validateTerminalWake(
    correlation: Correlation,
    settlementGeneration: string,
  ): Promise<void> {
    const run = await canonicalRun(correlation);
    if (
      run.transportState !== "finished" ||
      run.settlementDecision !== "finish" ||
      run.agentState !== "done" ||
      run.settlementGeneration !== settlementGeneration
    ) {
      throw new Error("canonical pi-detach settlement does not authorize a terminal wake");
    }
    if (await logicalDescendants(correlation.threadId) !== "none") {
      throw new Error("logical descendants are live or indeterminate");
    }
  }

  async function deliverWake(
    correlation: Correlation,
    settlementGeneration: string,
  ): Promise<{ state: "claimed" | "sent" | "unknown"; admitted?: boolean }> {
    await validateTerminalWake(correlation, settlementGeneration);
    const admission = wakes.admit(
      correlation.logicalParentThreadId,
      settlementGeneration,
      correlation.runId,
    );
    if (!admission.admitted) return { state: admission.state as "claimed" | "sent" | "unknown" };
    try {
      await bb.sdk.threads.send({
        threadId: correlation.logicalParentThreadId,
        mode: "auto",
        input: [{
          type: "text",
          text: `[meta-harness] run ${correlation.runId} settled. Read its canonical pi-detach result and continue.`,
          mentions: [],
        }],
      });
      wakes.mark(correlation.logicalParentThreadId, settlementGeneration, "sent");
      bb.realtime.publish("projection-invalidated", { runId: correlation.runId });
      return { state: "sent" };
    } catch (error) {
      wakes.mark(correlation.logicalParentThreadId, settlementGeneration, "unknown");
      bb.log.error(String(error));
      return { state: "unknown" };
    }
  }

  async function start(raw: unknown): Promise<Response> {
    const parsed = agentStartRequest.safeParse(raw);
    if (!parsed.success) return json({ error: "REQUEST_INVALID" }, 400);
    const input = parsed.data;
    await verifyParent(input);

    const priorCorrelation = correlations.getByRun(input.runId);
    if (input.continuation) {
      if (!priorCorrelation) return json({ error: "RUN_UNKNOWN" }, 404);
      if (
        priorCorrelation.logicalParentThreadId !== input.logicalParentThreadId ||
        priorCorrelation.hostId !== input.hostId
      ) {
        return json({ error: "CORRELATION_MISMATCH" }, 409);
      }
      if (input.prompt !== CONTINUE_TOKEN) {
        return json({ error: "CONTINUATION_INVALID" }, 409);
      }
      const reservation = correlations.getReservationByRun(input.runId);
	  if (
		reservation &&
		(reservation.state !== "bound" || !continuationIdentityMatches(input, reservation))
	  ) {
		return json({ error: "CORRELATION_MISMATCH" }, 409);
	  }
      const environmentId = await verifiedThread(
        input,
        priorCorrelation.threadId,
        reservation?.environmentId,
      );
      await answerBlocked(priorCorrelation);
      return json(startResponse(input, priorCorrelation, environmentId));
    }
	const existingReservation = correlations.getReservationByRun(input.runId);
	if (priorCorrelation && !existingReservation) {
	  if (
		priorCorrelation.logicalParentThreadId !== input.logicalParentThreadId ||
		priorCorrelation.hostId !== input.hostId
	  ) {
		return json({ error: "CORRELATION_MISMATCH" }, 409);
	  }
	  const environmentId = await verifiedThread(input, priorCorrelation.threadId);
	  return json(startResponse(input, priorCorrelation, environmentId));
	}

	const provisional = newBootstrapToken();
	const token = input.bootstrap ? bootstrapToken(input, provisional) : provisional;
	const bootstrapTokenHash = tokenHash(token);
	const proposedReservation = launchReservation(input, bb.pluginId, bootstrapTokenHash);
	let reserved: ReturnType<typeof correlations.reserve>;
	try {
	  reserved = correlations.reserve(proposedReservation);
	} catch (error) {
	  bb.log.error(`launch reservation persistence failed: ${String(error)}`);
	  throw error;
	}
	if (!reserved.created) {
	  const prior = reserved.reservation;
	  if (prior.requestFingerprint !== proposedReservation.requestFingerprint) {
		return json({ error: "LAUNCH_FINGERPRINT_MISMATCH", state: prior.state }, 409);
	  }
	  if (prior.state !== "bound" || !prior.threadId || !prior.environmentId) {
		return json(
		  {
			error: prior.state === "reserved"
			  ? "LAUNCH_IN_PROGRESS"
			  : prior.state === "failed"
				? "LAUNCH_FAILED"
				: "LAUNCH_OUTCOME_UNKNOWN",
			state: prior.state,
		  },
		  503,
		);
	  }
	  const correlation = correlations.getByRun(input.runId);
	  if (!correlation || correlation.threadId !== prior.threadId) {
		return json({ error: "LAUNCH_OUTCOME_UNKNOWN", state: "unknown" }, 503);
	  }
	  const environmentId = await verifiedThread(
		input,
		correlation.threadId,
		prior.environmentId,
	  );
	  return json(startResponse(input, correlation, environmentId));
	}

	if (priorCorrelation) {
	  correlations.mark(input.runId, "failed", "legacy correlation conflicts with launch reservation");
	  return json({ error: "CORRELATION_MISMATCH" }, 409);
	}

	const prompt = input.bootstrap ? `[[bb-meta-worker:v1:${token}]]\n${input.prompt}` : input.prompt;
	let spawned;
	try {
	  spawned = await bb.sdk.threads.spawn({
      projectId: input.projectId,
      prompt,
      title: input.label,
      providerId: "pi",
      model: input.model,
      reasoningLevel: input.reasoning,
      visibility: "visible",
      originKind: null,
      environment: {
        type: "host",
        hostId: input.hostId,
        workspace: { type: "unmanaged", path: input.cwd },
      },
	  });
	} catch (error) {
	  try {
		const current = correlations.getReservationByRun(input.runId);
		if (current?.state === "reserved") {
		  correlations.mark(input.runId, "unknown", "threads.spawn returned an indeterminate outcome");
		} else if (current?.state === "bound" && current.threadId && current.environmentId) {
		  try {
			await verifiedThread(input, current.threadId, current.environmentId);
		  } catch {
			correlations.mark(input.runId, "unknown", "bound thread could not be verified after spawn failure");
		  }
		}
	  } catch (markError) {
		bb.log.error(`could not reconcile failed launch outcome: ${String(markError)}`);
	  }
	  throw error;
	}

	let threadId: string;
	try {
	  threadId = threadIdOf(spawned);
	} catch (error) {
	  correlations.mark(input.runId, "unknown", "threads.spawn returned no usable thread identity");
	  throw error;
	}

	let correlation: Correlation;
	let environmentId: string;
	try {
	  if (input.bootstrap) {
		const bound = correlations.getReservationByRun(input.runId);
		const boundCorrelation = correlations.getByRun(input.runId);
		if (
		  bound?.state !== "bound" ||
		  bound.threadId !== threadId ||
		  !bound.environmentId ||
		  !boundCorrelation ||
		  boundCorrelation.threadId !== threadId
		) {
		  throw new Error("spawn returned before the bootstrap hook durably bound its thread");
		}
		correlation = boundCorrelation;
		environmentId = await verifiedThread(input, threadId, bound.environmentId);
	  } else {
		environmentId = await verifiedThread(input, threadId);
		const binding = correlations.bind(
		  bootstrapTokenHash,
		  threadId,
		  environmentId,
		  Date.now(),
		);
		if (binding.kind !== "bound") {
		  throw new Error(`advisor launch reservation could not bind: ${binding.kind}`);
		}
		correlation = binding.correlation;
	  }
	} catch (error) {
	  try {
		correlations.mark(input.runId, "failed", "post-spawn identity or durable binding failed");
	  } catch (markError) {
		bb.log.error(`could not persist failed launch: ${String(markError)}`);
	  }
	  await bb.sdk.threads.stop({ threadId }).catch((stopError) => {
		bb.log.error(`could not stop rejected launch ${threadId}: ${String(stopError)}`);
	  });
	  throw error;
	}

    bb.realtime.publish("projection-invalidated", { runId: input.runId });
    return json(startResponse(input, correlation, environmentId));
  }

  async function logicalDescendants(threadId: string): Promise<"none" | "live" | "indeterminate"> {
    const all = correlations.list();
    const pending = all.filter((item) => item.logicalParentThreadId === threadId);
    const seen = new Set<string>();
    while (pending.length > 0) {
      const child = pending.shift();
      if (!child || seen.has(child.threadId)) continue;
      seen.add(child.threadId);
      let thread;
      try {
        thread = await bb.sdk.threads.get({ threadId: child.threadId });
      } catch {
        return "indeterminate";
      }
	  if (["pending", "starting", "active", "stopping"].includes(thread.status)) return "live";
	  let run: CanonicalRunState;
	  try { run = await canonicalRun(child); } catch { return "indeterminate"; }
	  if (run.transportState !== "finished") return "live";
      pending.push(...all.filter((item) => item.logicalParentThreadId === child.threadId));
    }
    return "none";
  }

  bb.http.route("POST", "/v1/agents/start", async (context) => start(await context.req.json()), { auth: "local" });
  bb.http.route("POST", "/v1/agents/wait", async (context) => {
    const parsed = agentWaitRequest.safeParse(await context.req.json());
    if (!parsed.success) return json({ error: "REQUEST_INVALID" }, 400);
    const correlation = correlations.getByRun(parsed.data.runId);
    if (!correlation || correlation.threadId !== parsed.data.threadId) {
      return json({ error: "CORRELATION_MISMATCH" }, 409);
    }
    const waited = await bb.sdk.threads.wait({
      threadId: correlation.threadId,
      status: parsed.data.until,
      timeoutMs: 600_000,
    });
    if (!("thread" in waited)) throw new Error("BB threads.wait returned the wrong target kind");
    const thread = waited.thread;
    const descendants = await logicalDescendants(correlation.threadId);
    const transportState = thread.status === "idle"
      ? "idle"
      : thread.status === "error"
        ? "error"
        : thread.status === "stopping"
          ? "stopped"
          : "active";
    return json({
      version: "1",
      runId: parsed.data.runId,
      threadId: correlation.threadId,
      transportState,
      logicalDescendants: descendants,
    });
  }, { auth: "local" });
  bb.http.route("POST", "/v1/agents/stop", async (context) => {
    const parsed = agentStopRequest.safeParse(await context.req.json());
    if (!parsed.success) return json({ error: "REQUEST_INVALID" }, 400);
    const correlation = correlations.getByRun(parsed.data.runId);
    if (!correlation || correlation.threadId !== parsed.data.threadId) {
      return json({ error: "CORRELATION_MISMATCH" }, 409);
    }
    await bb.sdk.threads.stop({ threadId: correlation.threadId });
    return json({ version: "1", stopped: true });
  }, { auth: "local" });
  bb.http.route("POST", "/v1/bootstrap/claim", async (context) => {
    const parsed = bootstrapClaimRequest.safeParse(await context.req.json());
    if (!parsed.success) return json({ error: "REQUEST_INVALID" }, 400);
    let decoded;
    try {
      decoded = decodeBootstrap(parsed.data.token);
    } catch {
      return json({ error: "BOOTSTRAP_MISMATCH" }, 409);
    }
    if (!decoded.r || !decoded.d) return json({ error: "BOOTSTRAP_MISMATCH" }, 409);
    const claimed = correlations.claimBootstrap(parsed.data.token, parsed.data.threadId);
    if (!claimed) return json({ error: "BOOTSTRAP_REPLAY_OR_MISMATCH" }, 409);
    return json({
      version: "1",
      role: decoded.r,
      runDir: decoded.d,
      maxTurns: decoded.c,
      launchModel: decoded.m,
      launchThinking: decoded.q,
      allowSubagents: decoded.x,
    });
  }, { auth: "local" });
  bb.http.route("POST", "/v1/wakes/authorize", async (context) => {
    const parsed = wakeAuthorizeRequest.safeParse(await context.req.json());
    if (!parsed.success) return json({ error: "REQUEST_INVALID" }, 400);
    const correlation = correlations.getByRun(parsed.data.runId);
    if (
      !correlation ||
      correlation.threadId !== parsed.data.threadId ||
      correlation.logicalParentThreadId !== parsed.data.logicalParentThreadId
    ) {
      return json({ error: "CORRELATION_MISMATCH" }, 409);
    }
    try {
      const delivered = await deliverWake(correlation, parsed.data.settlementGeneration);
      return json({ version: "1", state: delivered.state }, delivered.state === "unknown" ? 503 : 200);
    } catch (error) {
      bb.log.error(String(error));
      return json({ error: "SETTLEMENT_NOT_AUTHORIZED" }, 409);
    }
  }, { auth: "local" });

  bb.rpc.register(metaHarnessRpcContract, {
    async snapshot({ graphId }) {
      const allCorrelations = correlations.list();
	  const allReservations = correlations.listReservations();
      const matchingHosts = new Set(
		[
		  ...allCorrelations.filter((item) => !item.graphId || item.graphId === graphId),
		  ...allReservations.filter((item) => !item.graphId || item.graphId === graphId),
		].map((item) => item.hostId),
      );
      const configuredHost = process.env.PI_META_HOST_ID?.trim();
      let graphHostId = configuredHost;
      if (!graphHostId && matchingHosts.size === 1) graphHostId = [...matchingHosts][0];
      if (!graphHostId) {
        const connected = (await bb.sdk.hosts.list()).filter((item) => item.status === "connected");
        if (connected.length !== 1) throw new Error("canonical graph host is ambiguous");
        graphHostId = connected[0]?.id;
      }
      if (!graphHostId) throw new Error("no connected canonical graph host");
      const raw = await host.call("snapshotGraph", { graphId }, { hostId: graphHostId });
      const graph = parseGraph(raw.content, graphId);
      const hash = createHash("sha256").update(raw.content).digest("hex");
      const nodes = await Promise.all(graph.nodes.map(async (node) => {
        const candidates = allCorrelations.filter(
          (item) => item.nodeId === node.id && (!item.graphId || item.graphId === graphId),
        );
        if (candidates.length === 0) return { ...node, status: "planned" };
        if (candidates.length !== 1) return { ...node, status: "unknown" };
        const correlation = candidates[0]!;
        let run: CanonicalRunState | undefined;
        let threadState = "unknown";
        try { run = await canonicalRun(correlation); } catch { /* projection stays unknown */ }
        try {
          threadState = (await bb.sdk.threads.get({ threadId: correlation.threadId })).status;
        } catch { /* projection stays unknown */ }
        const [result, log] = await Promise.allSettled([
          host.call("readReservedResult", { runId: correlation.runId }, { hostId: correlation.hostId }),
          host.call("tailLog", { runId: correlation.runId, maxBytes: 32_768 }, { hostId: correlation.hostId }),
        ]);
		await host.call("watchRun", { runId: correlation.runId }, { hostId: correlation.hostId }).catch((error) => bb.log.warn(`could not watch canonical run ${correlation.runId}: ${String(error)}`));
        const status = threadState === "active" || threadState === "starting" || threadState === "pending"
          ? "working"
          : threadState === "error"
            ? "error"
            : run?.agentState ?? (run?.transportState === "finished" ? run.status : threadState);
        return {
          ...node,
          status,
          runId: correlation.runId,
          threadId: correlation.threadId,
          hostId: correlation.hostId,
          threadState,
          ...(run?.resultStatus ? { resultStatus: run.resultStatus } : {}),
          ...(run?.logPath ? { logPath: run.logPath } : {}),
          ...(log.status === "fulfilled" ? { logTail: log.value.content } : {}),
          ...(run?.resultPath ? { artifactPath: run.resultPath } : {}),
          ...(result.status === "fulfilled" ? { artifact: result.value.content } : {}),
        };
      }));
      return {
        graphId,
        hash,
        waves: graph.waves.map((nodeIds, index) => ({ index: index + 1, nodeIds })),
        nodes,
        edges: graph.nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id }))),
		launchReservations: allReservations.map((reservation) => ({
		  runId: reservation.runId,
		  state: reservation.state,
		  ...(reservation.threadId ? { threadId: reservation.threadId } : {}),
		  hostId: reservation.hostId,
		  projectId: reservation.projectId,
		  cwd: reservation.cwd,
		  createdAt: reservation.createdAt,
		  updatedAt: reservation.updatedAt,
		  ...(reservation.failureReason ? { failureReason: reservation.failureReason } : {}),
		})),
        wakeAdmissions: wakes.list(),
      };
    },
    async stop({ threadId }) {
      const correlation = correlations.list().find((item) => item.threadId === threadId);
      if (!correlation) throw new Error("uncorrelated thread");
      await bb.sdk.threads.stop({ threadId });
      return { ok: true as const };
    },
    async message({ threadId, text }) {
      const correlation = correlations.list().find((item) => item.threadId === threadId);
      if (!correlation) throw new Error("uncorrelated thread");
      if (/^\[\[bb-meta-worker:v1:/u.test(text)) throw new Error("bootstrap markers are reserved");
	  if (text.trim() === CONTINUE_TOKEN) throw new Error("BLOCKED continuation tokens require the typed answer control");
	  const run = await canonicalRun(correlation).catch(() => undefined);
	  if (run?.transportState === "paused" && run.agentState === "blocked") throw new Error("BLOCKED threads require the typed answer control");
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text, mentions: [] }],
      });
      return { ok: true as const };
    },
    async answerBlocked({ runId, threadId, answer }) {
      if (answer !== CONTINUE_TOKEN) throw new Error("invalid BLOCKED answer");
      const correlation = correlations.getByRun(runId);
      if (!correlation || correlation.threadId !== threadId) throw new Error("run/thread mismatch");
      await answerBlocked(correlation);
      return { ok: true as const };
    },
    async retryWake({ logicalParentThreadId, settlementGeneration }) {
      const admission = wakes.list().find(
        (item) => item.logicalParentThreadId === logicalParentThreadId && item.settlementGeneration === settlementGeneration,
      );
      if (!admission) throw new Error("wake is not unknown");
      const correlation = correlations.getByRun(admission.runId);
      if (!correlation || correlation.logicalParentThreadId !== logicalParentThreadId) {
        throw new Error("wake correlation is missing or mismatched");
      }
	  await validateTerminalWake(correlation, settlementGeneration);
	  if (!wakes.retry(logicalParentThreadId, settlementGeneration)) throw new Error("wake is not unknown");
      const delivered = await deliverWake(correlation, settlementGeneration);
      if (delivered.state === "unknown") throw new Error("wake delivery outcome is still unknown");
      return { ok: true as const };
    },
    async skipWake({ logicalParentThreadId, settlementGeneration }) {
      if (!wakes.skip(logicalParentThreadId, settlementGeneration)) throw new Error("wake is not unknown");
      return { ok: true as const };
    },
  });

  for (const event of ["thread.created", "thread.active", "thread.idle", "thread.failed", "thread.deleted"] as const) {
    bb.events.on(event, ({ thread }) => {
      bb.realtime.publish("projection-invalidated", { threadId: thread.id });
    });
  }
}
