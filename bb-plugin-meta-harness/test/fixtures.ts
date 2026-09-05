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
