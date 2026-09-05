import { describe, expect, it } from "vitest";
import {
  projectTrace,
  validateTrace,
  validationProblemsFromEvents,
} from "../src/trace-projector.js";
import {
  syntheticBlockedEvents,
  syntheticDoneEvents,
  syntheticInvalidResultEvents,
} from "./fixtures.js";

describe("canonical trace mirror", () => {
  it("derives done, progress, wake, and advisory validation notes", () => {
    const events = syntheticDoneEvents();
    expect(validateTrace(events)).toEqual({ ok: true, problems: [] });
    const projection = projectTrace(events);
    expect(projection.run).toMatchObject({
      id: "synthetic-run-1",
      host: "codex",
      lastSeq: 7,
    });
    expect(projection.nodes[0]).toMatchObject({
      state: "settled",
      settledStatus: "done",
      resultValid: true,
      resultStatus: "PASS",
      progress: [
        {
          at: "2026-09-05T08:00:02.000Z",
          note: "Descriptor checks passed.",
        },
      ],
    });
    expect(projection.wakes).toEqual([
      {
        parent: "advisor",
        child: "builder-1",
        childStatus: "done",
        generation: 1,
        at: "2026-09-05T08:00:06.000Z",
      },
    ]);
    expect(validationProblemsFromEvents(events)).toEqual({
      "builder-1": ["Evidence section is terse"],
    });
  });

  it("derives blocked requests without turning validation notes into policy", () => {
    const events = syntheticBlockedEvents();
    expect(validateTrace(events).ok).toBe(true);
    expect(projectTrace(events).nodes[0]).toMatchObject({
      state: "settled",
      settledStatus: "blocked",
      blockedRequest: {
        kind: "decision",
        text: "Choose the bounded compatibility path.",
      },
    });
  });

  it("keeps invalid-result problems trace-derived and permits stalled settlement", () => {
    const events = syntheticInvalidResultEvents();
    expect(validateTrace(events)).toEqual({ ok: true, problems: [] });
    expect(projectTrace(events).nodes[0]).toMatchObject({
      state: "settled",
      resultValid: false,
      resultStatus: null,
      settledStatus: "stalled",
    });
    expect(validationProblemsFromEvents(events)).toEqual({
      "builder-1": ["Result artifact is blank"],
    });
  });

  it("rejects malformed ordering and unsupported event types", () => {
    const gap = structuredClone(syntheticDoneEvents());
    gap[2]!.seq = 8;
    expect(validateTrace(gap).problems.map(({ code }) => code)).toContain(
      "E_SEQ",
    );

    const unsupported = structuredClone(
      syntheticDoneEvents(),
    ) as unknown as Array<Record<string, unknown>>;
    unsupported[2]!.type = "node.cancelled";
    expect(
      validateTrace(unsupported as never).problems.map(({ code }) => code),
    ).toContain("E_SCHEMA");
  });
});
