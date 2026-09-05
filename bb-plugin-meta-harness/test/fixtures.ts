import type { CanonicalEvent } from "../src/trace-projector.js";

const RUN_ID = "synthetic-run-1";
const NODE_ID = "builder-1";
const RESULT_PATH = "/advisor/runs/synthetic-run-1/result.md";

export function syntheticDoneEvents(): CanonicalEvent[] {
  return [
    {
      v: 1,
      seq: 1,
      at: "2026-09-05T08:00:00.000Z",
      run: RUN_ID,
      node: null,
      parent: null,
      host: "codex",
      type: "run.created",
      data: {
        workstream: "surface-test",
        goal: "Render canonical state without owning it.",
        graph: "surface-graph",
        stateRoot: "/advisor",
        root: { node: "advisor", session: "session-1" },
      },
    },
    {
      v: 1,
      seq: 2,
      at: "2026-09-05T08:00:01.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.launched",
      data: {
        role: "builder",
        label: "Surface maker",
        harness: "codex",
        model: "gpt-5",
        thinking: "high",
        cwd: "/workspace",
        riskTier: "high",
        acceptance: ["Projection is deeply equivalent."],
        resultPath: RESULT_PATH,
        keepAlive: true,
        launchRef: { task: "surface-maker" },
      },
    },
    {
      v: 1,
      seq: 3,
      at: "2026-09-05T08:00:02.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.progress",
      data: { note: "Descriptor checks passed." },
    },
    {
      v: 1,
      seq: 4,
      at: "2026-09-05T08:00:03.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.result.written",
      data: { path: RESULT_PATH, sha256: "a".repeat(64) },
    },
    {
      v: 1,
      seq: 5,
      at: "2026-09-05T08:00:04.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.result.validated",
      data: {
        path: RESULT_PATH,
        valid: true,
        status: "PASS",
        problems: ["Evidence section is terse"],
      },
    },
    {
      v: 1,
      seq: 6,
      at: "2026-09-05T08:00:05.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.settled",
      data: {
        status: "done",
        reason: "Canonical result validated",
        resultStatus: "PASS",
        surfaceClosed: true,
      },
    },
    {
      v: 1,
      seq: 7,
      at: "2026-09-05T08:00:06.000Z",
      run: RUN_ID,
      node: "advisor",
      parent: null,
      host: "codex",
      type: "parent.awakened",
      data: {
        child: NODE_ID,
        childStatus: "done",
        wakeGeneration: 1,
        resultPath: RESULT_PATH,
      },
    },
  ];
}

export function syntheticBlockedEvents(): CanonicalEvent[] {
  const [created, launched] = syntheticDoneEvents();
  return [
    created!,
    launched!,
    {
      v: 1,
      seq: 3,
      at: "2026-09-05T08:00:02.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.blocked",
      data: {
        request: {
          kind: "decision",
          text: "Choose the bounded compatibility path.",
          options: ["Public SDK", "Stop"],
        },
      },
    },
    {
      v: 1,
      seq: 4,
      at: "2026-09-05T08:00:03.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.result.written",
      data: { path: RESULT_PATH },
    },
    {
      v: 1,
      seq: 5,
      at: "2026-09-05T08:00:04.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.result.validated",
      data: { path: RESULT_PATH, valid: true, status: "BLOCKED", problems: [] },
    },
    {
      v: 1,
      seq: 6,
      at: "2026-09-05T08:00:05.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.settled",
      data: {
        status: "blocked",
        reason: "Decision required",
        surfaceClosed: false,
      },
    },
    {
      v: 1,
      seq: 7,
      at: "2026-09-05T08:00:06.000Z",
      run: RUN_ID,
      node: "advisor",
      parent: null,
      host: "codex",
      type: "parent.awakened",
      data: { child: NODE_ID, childStatus: "blocked", wakeGeneration: 1 },
    },
  ];
}

export function syntheticProgressEvents(): CanonicalEvent[] {
  return syntheticDoneEvents().slice(0, 3);
}

export function syntheticInvalidResultEvents(): CanonicalEvent[] {
  const [created, launched] = syntheticDoneEvents();
  return [
    created!,
    launched!,
    {
      v: 1,
      seq: 3,
      at: "2026-09-05T08:00:02.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.result.written",
      data: { path: RESULT_PATH },
    },
    {
      v: 1,
      seq: 4,
      at: "2026-09-05T08:00:03.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.result.validated",
      data: {
        path: RESULT_PATH,
        valid: false,
        problems: ["Result artifact is blank"],
      },
    },
    {
      v: 1,
      seq: 5,
      at: "2026-09-05T08:00:04.000Z",
      run: RUN_ID,
      node: NODE_ID,
      parent: "advisor",
      host: "codex",
      type: "node.settled",
      data: { status: "stalled", reason: "Result artifact is invalid" },
    },
    {
      v: 1,
      seq: 6,
      at: "2026-09-05T08:00:05.000Z",
      run: RUN_ID,
      node: "advisor",
      parent: null,
      host: "codex",
      type: "parent.awakened",
      data: { child: NODE_ID, childStatus: "stalled", wakeGeneration: 1 },
    },
  ];
}

export function withRunId(
  events: readonly CanonicalEvent[],
  runId: string,
): CanonicalEvent[] {
  return events.map((event) => ({ ...event, run: runId })) as CanonicalEvent[];
}

export function asJsonl(events: readonly CanonicalEvent[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/** One node restarts, blocks, replies/resumes, then cancels in a planned wave. */
export function syntheticLifecycleEvents(): CanonicalEvent[] {
  const blocked = syntheticBlockedEvents();
  const envelope = { ...blocked[1]! };
  const runEnvelope = { ...blocked[0]! };
  const events: CanonicalEvent[] = [
    blocked[0]!,
    {
      ...runEnvelope,
      type: "graph.planned",
      node: null,
      parent: null,
      data: {
        graph: "current-graph",
        waves: [["builder-1"]],
        maxParallel: 1,
        maxRepairLoops: 1,
      },
    },
    {
      ...runEnvelope,
      type: "wave.started",
      node: null,
      parent: null,
      data: { wave: 1, nodes: ["builder-1"] },
    },
    blocked[1]!,
    {
      ...envelope,
      type: "node.resumed",
      node: "builder-1",
      parent: "advisor",
      data: { reason: "restart" },
    },
    ...blocked.slice(2),
    {
      ...envelope,
      type: "node.reply.sent",
      node: "builder-1",
      parent: "advisor",
      data: { text: "Use the public SDK.", source: "user", replyTo: 6 },
    },
    {
      ...envelope,
      type: "node.resumed",
      node: "builder-1",
      parent: "advisor",
      data: { reason: "reply" },
    },
    {
      ...envelope,
      type: "node.cancel.requested",
      node: "builder-1",
      parent: "advisor",
      data: { reason: "Stop requested" },
    },
    {
      ...envelope,
      type: "node.settled",
      node: "builder-1",
      parent: "advisor",
      data: { status: "cancelled", reason: "Stopped" },
    },
    {
      ...runEnvelope,
      type: "parent.awakened",
      node: "advisor",
      parent: null,
      data: { child: "builder-1", childStatus: "cancelled", wakeGeneration: 2 },
    },
    {
      ...runEnvelope,
      type: "wave.completed",
      node: null,
      parent: null,
      data: { wave: 1, nodes: ["builder-1"] },
    },
  ];
  return events.map((event, index) => ({
    ...event,
    seq: index + 1,
    at: "2026-09-05T09:00:00.000Z",
  }));
}
