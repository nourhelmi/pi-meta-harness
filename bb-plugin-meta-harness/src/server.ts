import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  agentStartRequest,
  agentStopRequest,
  agentWaitRequest,
  hostRpcContract,
	hostSignals,
  metaHarnessRpcContract,
  wakeAuthorizeRequest,
  type AgentStartRequest,
} from "./contracts.js";
import {
  createCorrelationStore,
  fingerprint,
	hasLegacyPrivateRoleStateColumn,
	listLegacyPrivateRoleStateRows,
	migrateLegacyPrivateRoleStateRows,
  newBootstrapToken,
	newPrivateReservationId,
  tokenHash,
  type Correlation,
	type LaunchReservation,
	type MigratedPrivateRoleStateReference,
	type PrivateLaunchReservation,
	type PrivateRoleState,
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

interface PrivateInitializationContext {
	version: 1;
	kind: "initial" | "resume";
	pluginId: string;
	reservationId: string;
	threadId: string;
	inputSha256: string;
	generation: number;
	projectId: string;
	environmentId: string;
	hostId: string;
	providerId: string;
	model: string;
	reasoning: string;
}

interface PrivateInitializationApi {
	readonly version: 1;
	registerResolver(
		resolver: (
			context: PrivateInitializationContext,
		) => Promise<{ action: "provide"; value: PrivateRoleState } | { action: "reject"; code: string; message: string }>,
	): { dispose(): void };
	spawn(args: {
		projectId: string;
		prompt: string;
		title: string;
		providerId: "pi";
		model: string;
		reasoningLevel: AgentStartRequest["reasoning"];
		visibility: "visible";
		originKind: null;
		environment: {
			type: "host";
			hostId: string;
			workspace: { type: "unmanaged"; path: string };
		};
		privateInitialization: { reservationId: string };
	}): Promise<unknown>;
}

type MetaHarnessPluginApi = BbPluginApi & {
	experimental_privateThreadInitialization: PrivateInitializationApi;
};

function privateRoleState(input: AgentStartRequest): PrivateRoleState {
	if (!input.bootstrap || !input.resultPath) {
		throw new Error("private worker initialization requires typed role state");
	}
	const graphId = graphFromPrompt(input.prompt);
	const nodeId = nodeFromLabel(input.label);
	return {
		role: input.bootstrap.role,
		runDir: dirname(input.resultPath),
		resultPath: input.resultPath,
		maxTurns: input.bootstrap.maxTurns,
		launchModel: input.model,
		launchThinking: input.reasoning,
		allowSubagents: input.bootstrap.allowSubagents,
		runId: input.runId,
		...(graphId ? { graphId } : {}),
		...(nodeId ? { nodeId } : {}),
	};
}

function serializedPrivateRoleState(value: PrivateRoleState): string {
	return JSON.stringify(value);
}

function privateRoleStateSha256(value: PrivateRoleState): string {
	return createHash("sha256").update(serializedPrivateRoleState(value)).digest("hex");
}

function parseStoredPrivateRoleState(
	content: string,
	reservation: PrivateLaunchReservation,
): PrivateRoleState {
	const value = JSON.parse(content) as Record<string, unknown>;
	if (
		typeof value.role !== "string" ||
		typeof value.runDir !== "string" ||
		typeof value.resultPath !== "string" ||
		typeof value.maxTurns !== "number" ||
		!Number.isInteger(value.maxTurns) ||
		typeof value.launchModel !== "string" ||
		typeof value.launchThinking !== "string" ||
		typeof value.allowSubagents !== "boolean" ||
		value.runId !== reservation.runId ||
		value.launchModel !== reservation.model ||
		value.launchThinking !== reservation.reasoning ||
		(value.graphId ?? undefined) !== reservation.graphId ||
		(value.nodeId ?? undefined) !== reservation.nodeId ||
		dirname(value.resultPath) !== value.runDir ||
		join(value.runDir, "private-role-state.json") !== reservation.roleStateLocator
	) {
		throw new Error("Meta Harness canonical private role state mismatch");
	}
	return value as unknown as PrivateRoleState;
}

function privateLaunchReservation(
	input: AgentStartRequest,
	reservationId: string,
	roleStateLocator: string,
	roleStateSha256: string,
): PrivateLaunchReservation {
	const now = Date.now();
	const roleState = privateRoleState(input);
	return {
		runId: input.runId,
		reservationId,
		requestFingerprint: launchFingerprint(input),
		inputSha256: privateInputSha256(input.prompt),
		logicalParentThreadId: input.logicalParentThreadId,
		logicalParentEnvironmentId: input.environmentId,
		...(roleState.graphId ? { graphId: roleState.graphId } : {}),
		...(roleState.nodeId ? { nodeId: roleState.nodeId } : {}),
		projectId: input.projectId,
		hostId: input.hostId,
		cwd: input.cwd,
		providerId: "pi",
		model: input.model,
		reasoning: input.reasoning,
		roleStateLocator,
		roleStateSha256,
		initializationState: "reserved",
		createdAt: now,
		updatedAt: now,
	};
}

function launchReservation(input: AgentStartRequest, pluginId: string, bootstrapTokenHash: string): LaunchReservation {
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

function continuationIdentityMatches(input: AgentStartRequest, reservation: LaunchReservation): boolean {
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

function threadIdOf(value: unknown): string {
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "string") throw new Error("BB spawn returned no thread id");
  return id;
}

function privateInputSha256(prompt: string): string {
	const canonical = `[{"mentions":[],"text":${JSON.stringify(prompt)},"type":"text"}]`;
	return createHash("sha256").update(canonical).digest("hex");
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
		return {
			id: node.id,
			role: node.role,
			worktree: node.worktree,
			dependsOn,
		} as CanonicalGraphNode;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
	if (
		nodeIds.size !== nodes.length ||
		nodes.some((node) => node.dependsOn.some((dependency) => !nodeIds.has(dependency)))
	) {
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
	const privateInitialization = (bb as MetaHarnessPluginApi).experimental_privateThreadInitialization;
	if (!privateInitialization) {
		throw new Error("BB private thread initialization capability is required");
	}
	const host = bb.hosts.experimental_client({
		contract: hostRpcContract,
		experimental_signals: hostSignals,
	});
  const db = bb.storage.database();
	if (hasLegacyPrivateRoleStateColumn(db)) {
		const references = new Map<string, MigratedPrivateRoleStateReference>();
		for (const legacy of listLegacyPrivateRoleStateRows(db)) {
			const content = serializedPrivateRoleState(legacy.roleState);
			const expectedSha256 = privateRoleStateSha256(legacy.roleState);
			const fallbackLocator = join(dirname(legacy.roleState.resultPath), "private-role-state.json");
			try {
				const materialized = await host.call(
					"materializePrivateRoleState",
					{
						runId: legacy.runId,
						resultPath: legacy.roleState.resultPath,
						content,
						expectedSha256,
					},
					{ hostId: legacy.hostId },
				);
				references.set(legacy.runId, {
					locator: materialized.locator,
					sha256: expectedSha256,
				});
			} catch {
				references.set(legacy.runId, {
					locator: fallbackLocator,
					sha256: expectedSha256,
					state: "stalled",
					errorCode: "META_ROLE_STATE_MIGRATION_FAILED",
				});
			}
		}
		migrateLegacyPrivateRoleStateRows(db, references);
	}
  const correlations = createCorrelationStore(db);
  const wakes = createWakeAdmissionStore(db);
  wakes.reconcileClaimed();
  const blockedAnswersInFlight = new Set<string>();
	const blockedAnswersSent = new Set<string>();
	host.experimental_onSignal("projectionChanged", ({ payload }) => {
	  bb.realtime.publish("projection-invalidated", { runId: payload.runId });
	});
	host.experimental_onWorkerExit(({ hostId }) => {
	  bb.realtime.publish("projection-invalidated", { hostId });
	});

	privateInitialization.registerResolver(async (context) => {
		const reservation = correlations.getPrivateReservationById(context.reservationId);
		if (
			!reservation ||
			context.version !== 1 ||
			(context.kind === "initial" && context.generation !== 1) ||
			(context.kind === "resume" && context.generation <= 1) ||
			context.pluginId !== bb.pluginId ||
			context.projectId !== reservation.projectId ||
			context.hostId !== reservation.hostId ||
			context.providerId !== reservation.providerId ||
			context.model !== reservation.model ||
			context.reasoning !== reservation.reasoning ||
			context.inputSha256 !== reservation.inputSha256
		) {
			return {
				action: "reject",
				code: "META_PRIVATE_IDENTITY_MISMATCH",
				message: "Meta Harness private initialization identity mismatch",
			};
	}
		let roleState: PrivateRoleState;
		try {
			const stored = await host.call(
				"readPrivateRoleState",
				{
					runId: reservation.runId,
					locator: reservation.roleStateLocator,
					expectedSha256: reservation.roleStateSha256,
				},
				{ hostId: reservation.hostId },
			);
			roleState = parseStoredPrivateRoleState(stored.content, reservation);
			if (privateRoleStateSha256(roleState) !== reservation.roleStateSha256) {
				throw new Error("private role state digest mismatch");
			}
		} catch {
			return {
				action: "reject",
				code: "META_PRIVATE_ROLE_STATE_UNAVAILABLE",
				message: "Meta Harness canonical private role state is unavailable",
			};
		}
		const full = await bb.sdk.threads.get({
			threadId: context.threadId,
			include: "environment,host",
		});
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
			full.id !== context.threadId ||
			full.projectId !== reservation.projectId ||
			full.providerId !== "pi" ||
			full.parentThreadId !== null ||
			full.originKind !== null ||
			full.originPluginId !== bb.pluginId ||
			full.visibility !== "visible" ||
			environment?.id !== context.environmentId ||
			environment.projectId !== reservation.projectId ||
			environment.hostId !== reservation.hostId ||
			environment.path !== reservation.cwd ||
			environment.workspaceProvisionType !== "unmanaged"
		) {
			return {
				action: "reject",
				code: "META_PRIVATE_THREAD_MISMATCH",
				message: "Meta Harness private thread identity mismatch",
			};
	}
		const bound = correlations.bindPrivate(
			reservation.reservationId,
			context.threadId,
			context.environmentId,
			context.generation,
	);
		if (!bound) {
			return {
				action: "reject",
				code: "META_PRIVATE_REPLAY",
				message: "Meta Harness private reservation is unavailable",
			};
	}
		return { action: "provide", value: roleState };
	});

	bb.experimental_hooks.on("message.dispatch", async (context) => {
		const threadCorrelation = correlations.list().find((item) => item.threadId === context.thread.id);
	if (threadCorrelation) {
	  const key = `${threadCorrelation.runId}:${threadCorrelation.threadId}`;
	  let run: CanonicalRunState | undefined;
			try {
				run = await canonicalRun(threadCorrelation);
			} catch {
				/* advisor roots have no pi-detach projection */
			}
	  if (run?.transportState === "paused" && run.agentState === "blocked") {
		// BB does not preserve originPluginId for every public threads.send path. The
		// one-shot run/thread admission is the authority; an origin hint is not.
				if (context.input.text.trim() !== CONTINUE_TOKEN || !blockedAnswersInFlight.has(key)) {
					return {
						action: "reject",
						message: "Meta Harness requires its typed BLOCKED answer control.",
					};
		}
	  } else if (context.input.text.trim() === CONTINUE_TOKEN) {
				return {
					action: "reject",
					message: "Meta Harness rejected an out-of-state BLOCKED token.",
				};
	  }
	}
	return { action: "proceed" };
  });

  async function verifyParent(input: AgentStartRequest): Promise<void> {
		const parent = await bb.sdk.threads.get({
			threadId: input.logicalParentThreadId,
		});
		if (
			parent.id !== input.logicalParentThreadId ||
			parent.projectId !== input.projectId ||
			parent.environmentId !== input.environmentId
		) {
      throw new Error("logical parent routing mismatch");
    }
  }

	async function verifiedThread(input: AgentStartRequest, threadId: string, expectedEnvironmentId?: string) {
		const full = await bb.sdk.threads.get({
			threadId,
			include: "environment,host",
		});
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
		const raw = await host.call("snapshotRun", { runId: correlation.runId }, { hostId: correlation.hostId });
    return parseRun(raw.content, correlation);
  }

  async function answerBlocked(correlation: Correlation): Promise<void> {
    const key = `${correlation.runId}:${correlation.threadId}`;
		if (blockedAnswersInFlight.has(key) || blockedAnswersSent.has(key))
			throw new Error("BLOCKED answer replay rejected");
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
			const history = await bb.sdk.threads.promptHistory({
				threadId: correlation.threadId,
				limit: "100",
			});
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
			bb.realtime.publish("projection-invalidated", {
				runId: correlation.runId,
			});
    } catch (error) {
	  blockedAnswersInFlight.delete(key);
      throw error;
    }
  }

	async function validateTerminalWake(correlation: Correlation, settlementGeneration: string): Promise<void> {
    const run = await canonicalRun(correlation);
    if (
      run.transportState !== "finished" ||
      run.settlementDecision !== "finish" ||
      run.agentState !== "done" ||
      run.settlementGeneration !== settlementGeneration
    ) {
      throw new Error("canonical pi-detach settlement does not authorize a terminal wake");
    }
		if ((await logicalDescendants(correlation.threadId)) !== "none") {
      throw new Error("logical descendants are live or indeterminate");
    }
  }

  async function deliverWake(
    correlation: Correlation,
    settlementGeneration: string,
  ): Promise<{ state: "claimed" | "sent" | "unknown"; admitted?: boolean }> {
    await validateTerminalWake(correlation, settlementGeneration);
		const admission = wakes.admit(correlation.logicalParentThreadId, settlementGeneration, correlation.runId);
    if (!admission.admitted) return { state: admission.state as "claimed" | "sent" | "unknown" };
    try {
      await bb.sdk.threads.send({
        threadId: correlation.logicalParentThreadId,
        mode: "auto",
				input: [
					{
          type: "text",
          text: `[meta-harness] run ${correlation.runId} settled. Read its canonical pi-detach result and continue.`,
          mentions: [],
					},
				],
      });
      wakes.mark(correlation.logicalParentThreadId, settlementGeneration, "sent");
			bb.realtime.publish("projection-invalidated", {
				runId: correlation.runId,
			});
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
			if (reservation && (reservation.state !== "bound" || !continuationIdentityMatches(input, reservation))) {
		return json({ error: "CORRELATION_MISMATCH" }, 409);
	  }
			const environmentId = await verifiedThread(input, priorCorrelation.threadId, reservation?.environmentId);
      await answerBlocked(priorCorrelation);
      return json(startResponse(input, priorCorrelation, environmentId));
    }

		if (input.bootstrap) {
			const priorPrivate = correlations.getPrivateReservationByRun(input.runId);
			if (
				priorPrivate &&
				priorPrivate.requestFingerprint !== launchFingerprint(input)
			) {
				return json(
					{
						error: "LAUNCH_FINGERPRINT_MISMATCH",
						state: priorPrivate.initializationState,
					},
					409,
				);
			}
			const roleState = privateRoleState(input);
			const roleStateContent = serializedPrivateRoleState(roleState);
			const roleStateSha256 = privateRoleStateSha256(roleState);
			const materialized = await host.call(
				"materializePrivateRoleState",
				{
					runId: input.runId,
					resultPath: roleState.resultPath,
					content: roleStateContent,
					expectedSha256: roleStateSha256,
				},
				{ hostId: input.hostId },
			);
			const proposed = privateLaunchReservation(
				input,
				newPrivateReservationId(),
				materialized.locator,
				roleStateSha256,
			);
			const reserved = correlations.reservePrivate(proposed);
			if (!reserved.created) {
				const prior = reserved.reservation;
				if (prior.requestFingerprint !== proposed.requestFingerprint) {
					return json(
						{
							error: "LAUNCH_FINGERPRINT_MISMATCH",
							state: prior.initializationState,
						},
						409,
					);
				}
				if (
					!prior.threadId ||
					!prior.environmentId ||
					!["resolving", "initialized"].includes(prior.initializationState)
				) {
					return json(
						{
							error: "LAUNCH_OUTCOME_UNKNOWN",
							state: prior.initializationState,
						},
						503,
					);
				}
				const correlation = correlations.getByRun(input.runId);
				if (!correlation) return json({ error: "LAUNCH_OUTCOME_UNKNOWN", state: "unknown" }, 503);
				const environmentId = await verifiedThread(input, correlation.threadId, prior.environmentId);
				return json(startResponse(input, correlation, environmentId));
			}

			let spawned: unknown;
			try {
				spawned = await privateInitialization.spawn({
					projectId: input.projectId,
					prompt: input.prompt,
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
					privateInitialization: { reservationId: proposed.reservationId },
				});
			} catch (error) {
				correlations.markPrivate(input.runId, "unknown", "SPAWN_OUTCOME_UNKNOWN");
				throw error;
			}
			const threadId = threadIdOf(spawned);
			const bound = correlations.getPrivateReservationByRun(input.runId);
			const correlation = correlations.getByRun(input.runId);
			if (!bound?.environmentId || bound.threadId !== threadId || !correlation) {
				correlations.markPrivate(input.runId, "unknown", "BINDING_OUTCOME_UNKNOWN");
				throw new Error("private spawn returned without an authenticated binding");
			}
			const environmentId = await verifiedThread(input, threadId, bound.environmentId);
			bb.realtime.publish("projection-invalidated", { runId: input.runId });
			return json(startResponse(input, correlation, environmentId));
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
		const token = provisional;
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
						error:
							prior.state === "reserved"
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
			const environmentId = await verifiedThread(input, correlation.threadId, prior.environmentId);
	  return json(startResponse(input, correlation, environmentId));
	}

	if (priorCorrelation) {
	  correlations.mark(input.runId, "failed", "legacy correlation conflicts with launch reservation");
	  return json({ error: "CORRELATION_MISMATCH" }, 409);
	}

		const prompt = input.prompt;
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
		environmentId = await verifiedThread(input, threadId);
			const binding = correlations.bind(bootstrapTokenHash, threadId, environmentId, Date.now());
		if (binding.kind !== "bound") {
		  throw new Error(`advisor launch reservation could not bind: ${binding.kind}`);
		}
		correlation = binding.correlation;
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
			try {
				run = await canonicalRun(child);
			} catch {
				return "indeterminate";
			}
	  if (run.transportState !== "finished") return "live";
      pending.push(...all.filter((item) => item.logicalParentThreadId === child.threadId));
    }
    return "none";
  }

  bb.http.route("POST", "/v1/agents/start", async (context) => start(await context.req.json()), { auth: "local" });
	bb.http.route(
		"POST",
		"/v1/agents/wait",
		async (context) => {
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
			const transportState =
				thread.status === "idle"
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
		},
		{ auth: "local" },
	);
	bb.http.route(
		"POST",
		"/v1/agents/stop",
		async (context) => {
    const parsed = agentStopRequest.safeParse(await context.req.json());
    if (!parsed.success) return json({ error: "REQUEST_INVALID" }, 400);
    const correlation = correlations.getByRun(parsed.data.runId);
    if (!correlation || correlation.threadId !== parsed.data.threadId) {
      return json({ error: "CORRELATION_MISMATCH" }, 409);
    }
    await bb.sdk.threads.stop({ threadId: correlation.threadId });
    return json({ version: "1", stopped: true });
		},
		{ auth: "local" },
	);
	bb.http.route(
		"POST",
		"/v1/wakes/authorize",
		async (context) => {
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
		},
		{ auth: "local" },
	);

  bb.rpc.register(metaHarnessRpcContract, {
    async snapshot({ graphId }) {
      const allCorrelations = correlations.list();
			const allReservations = [
				...correlations.listReservations(),
				...correlations.listPrivateReservations().map((reservation) => ({
					...reservation,
					state: reservation.initializationState,
					...(reservation.errorCode ? { failureReason: reservation.errorCode } : {}),
				})),
			];
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
			const nodes = await Promise.all(
				graph.nodes.map(async (node) => {
        const candidates = allCorrelations.filter(
          (item) => item.nodeId === node.id && (!item.graphId || item.graphId === graphId),
        );
        if (candidates.length === 0) return { ...node, status: "planned" };
        if (candidates.length !== 1) return { ...node, status: "unknown" };
        const correlation = candidates[0]!;
        let run: CanonicalRunState | undefined;
        let threadState = "unknown";
					try {
						run = await canonicalRun(correlation);
					} catch {
						/* projection stays unknown */
					}
        try {
          threadState = (await bb.sdk.threads.get({ threadId: correlation.threadId })).status;
					} catch {
						/* projection stays unknown */
					}
        const [result, log] = await Promise.allSettled([
          host.call("readReservedResult", { runId: correlation.runId }, { hostId: correlation.hostId }),
          host.call("tailLog", { runId: correlation.runId, maxBytes: 32_768 }, { hostId: correlation.hostId }),
        ]);
					await host
						.call("watchRun", { runId: correlation.runId }, { hostId: correlation.hostId })
						.catch((error) => bb.log.warn(`could not watch canonical run ${correlation.runId}: ${String(error)}`));
					const status =
						threadState === "active" || threadState === "starting" || threadState === "pending"
          ? "working"
          : threadState === "error"
            ? "error"
								: (run?.agentState ?? (run?.transportState === "finished" ? run.status : threadState));
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
				}),
			);
      return {
        graphId,
        hash,
				waves: graph.waves.map((nodeIds, index) => ({
					index: index + 1,
					nodeIds,
				})),
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
			if (text.trim() === CONTINUE_TOKEN)
				throw new Error("BLOCKED continuation tokens require the typed answer control");
	  const run = await canonicalRun(correlation).catch(() => undefined);
			if (run?.transportState === "paused" && run.agentState === "blocked")
				throw new Error("BLOCKED threads require the typed answer control");
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
			const admission = wakes
				.list()
				.find(
					(item) =>
						item.logicalParentThreadId === logicalParentThreadId && item.settlementGeneration === settlementGeneration,
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
			if (event === "thread.active") {
				const reservation = correlations.listPrivateReservations().find((item) => item.threadId === thread.id);
				if (reservation) correlations.markPrivate(reservation.runId, "initialized");
			}
			if (event === "thread.failed") {
				const reservation = correlations.listPrivateReservations().find((item) => item.threadId === thread.id);
				if (reservation && reservation.initializationState === "resolving") {
					correlations.markPrivate(reservation.runId, "stalled", "THREAD_FAILED_BEFORE_INITIALIZED");
				}
			}
      bb.realtime.publish("projection-invalidated", { threadId: thread.id });
    });
  }
}
