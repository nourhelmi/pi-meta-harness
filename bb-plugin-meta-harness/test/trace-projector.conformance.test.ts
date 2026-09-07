import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  parseTrace,
  projectTrace,
  validateTrace,
} from "../src/trace-projector.js";
import { createTraceStore } from "../src/trace-policy.js";
import {
  asJsonl,
  syntheticBlockedEvents,
  syntheticDoneEvents,
  syntheticInvalidResultEvents,
  syntheticProgressEvents,
  withRunId,
} from "./fixtures.js";

const run = promisify(execFile);
const metaRoot =
  process.env.ADVISOR_META_ROOT ?? resolve(import.meta.dirname, "../..");
const referenceCli = resolve(metaRoot, "scripts/advisor-trace.mjs");
const producerRoot = resolve(import.meta.dirname, "fixtures/native-producers");

async function referenceProject(path: string) {
  const execution = await run(process.execPath, [
    referenceCli,
    "project",
    path,
  ]);
  return JSON.parse(execution.stdout) as {
    ok: boolean;
    problems: unknown[];
    projection: unknown;
  };
}

async function referenceProjectFailure(path: string) {
  const execution = await run(process.execPath, [
    referenceCli,
    "project",
    path,
  ]).catch((error: unknown) => error as { stdout: string });
  return JSON.parse(execution.stdout) as {
    ok: boolean;
    problems: unknown[];
    projection: unknown;
  };
}

describe("Meta reference projector conformance", () => {
  // Synthetic host-shaped replays keep CI independent of private live traces.
  const producerFixtures = ["claude-code-done.jsonl", "codex-done.jsonl"];

  for (const fileName of producerFixtures) {
    it(`deeply matches the committed ${fileName} projection`, async () => {
      const path = resolve(producerRoot, fileName);
      const text = await readFile(path, "utf8");
      const events = parseTrace(text);
      expect(validateTrace(events)).toEqual({ ok: true, problems: [] });
      expect(projectTrace(events)).toEqual(
        (await referenceProject(path)).projection,
      );
    });
  }

  for (const [name, events] of [
    ["done", syntheticDoneEvents()],
    ["blocked", syntheticBlockedEvents()],
    ["progress", syntheticProgressEvents()],
    ["invalid result", syntheticInvalidResultEvents()],
  ] as const) {
    it(`deeply matches the synthetic ${name} projection`, async () => {
      const temporaryRoot = await mkdtemp(
        join(tmpdir(), "bb-trace-conformance-"),
      );
      const temporaryPath = join(
        temporaryRoot,
        `${name.replaceAll(" ", "-")}.jsonl`,
      );
      await writeFile(temporaryPath, asJsonl(events));
      try {
        expect(projectTrace(events)).toEqual(
          (await referenceProject(temporaryPath)).projection,
        );
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });
  }

  it("matches the reference ordering verdict for a noncontiguous trace", async () => {
    const events = structuredClone(syntheticDoneEvents());
    events[3]!.seq = 20;
    const result = validateTrace(parseTrace(asJsonl(events)));
    expect(result.ok).toBe(false);
    expect(result.problems.map(({ code }) => code)).toContain("E_SEQ");
    const temporaryRoot = await mkdtemp(join(tmpdir(), "bb-trace-order-"));
    const path = join(temporaryRoot, "order.jsonl");
    await writeFile(path, asJsonl(events));
    try {
      const reference = await referenceProjectFailure(path);
      expect(result).toEqual({
        ok: reference.ok,
        problems: reference.problems,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("matches the reference parser failure for malformed complete JSON", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "bb-trace-malformed-"));
    const path = join(temporaryRoot, "malformed.jsonl");
    await writeFile(path, '{"v":}\n');
    try {
      expect(() => parseTrace('{"v":}\n')).toThrow(/^line 1: invalid JSON/u);
      const failure = await run(process.execPath, [
        referenceCli,
        "project",
        path,
      ]).catch((error: unknown) => error as { stderr: string });
      expect(failure.stderr).toMatch(/^line 1: invalid JSON/u);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects leading and later-line BOMs like the reference CLI", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bb-trace-bom-"));
    const traces = join(stateRoot, "traces");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(traces));
    const events = syntheticDoneEvents();
    const cases = [
      { fileName: "leading-bom.jsonl", bomIndex: 0, lineNumber: 1 },
      { fileName: "later-bom.jsonl", bomIndex: 3, lineNumber: 4 },
    ];

    try {
      for (const { fileName, bomIndex, lineNumber } of cases) {
        const path = join(traces, fileName);
        await writeFile(
          path,
          `${events
            .map(
              (event, index) =>
                `${index === bomIndex ? "\uFEFF" : ""}${JSON.stringify(event)}`,
            )
            .join("\n")}\n`,
        );
        const response = await createTraceStore().readTrace(
          stateRoot,
          fileName,
        );
        expect(response).toMatchObject({
          ok: false,
          error: {
            code: "MALFORMED_JSON",
            message: expect.stringMatching(
              new RegExp(`line ${lineNumber}: invalid JSON`, "u"),
            ),
          },
        });
        expect(response).not.toHaveProperty("trace");

        const failure = await run(process.execPath, [
          referenceCli,
          "project",
          path,
        ]).then(
          () => {
            throw new Error(`Reference CLI accepted ${fileName}`);
          },
          (error: unknown) =>
            error as { code: number; stderr: string; stdout: string },
        );
        expect(failure.code).toBe(1);
        expect(failure.stderr).toMatch(
          new RegExp(`^line ${lineNumber}: invalid JSON`, "u"),
        );
      }
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("projects a partial append exactly like the reference complete prefix", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bb-trace-partial-"));
    const traces = join(stateRoot, "traces");
    const completePath = join(stateRoot, "complete.jsonl");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(traces));
    const complete = asJsonl(syntheticDoneEvents());
    await writeFile(join(traces, "partial.jsonl"), `${complete}{"v":1`);
    await writeFile(completePath, complete);
    try {
      const response = await createTraceStore().readTrace(
        stateRoot,
        "partial.jsonl",
      );
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      expect(response.trace.partial).toBe(true);
      expect(response.trace.projection).toEqual(
        (await referenceProject(completePath)).projection,
      );
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("projects each same-name replacement like its own reference file", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bb-trace-replacement-"));
    const traces = join(stateRoot, "traces");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(traces));
    const path = join(traces, "replace.jsonl");
    const oldPath = join(traces, "old-source.txt");
    await writeFile(path, asJsonl(syntheticDoneEvents()));
    try {
      const first = await createTraceStore().readTrace(
        stateRoot,
        "replace.jsonl",
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.trace.projection).toEqual(
        (await referenceProject(path)).projection,
      );

      await rename(path, oldPath);
      await writeFile(
        path,
        asJsonl(withRunId(syntheticDoneEvents(), "replacement-reference-2")),
      );
      const second = await createTraceStore().readTrace(
        stateRoot,
        "replace.jsonl",
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.trace.projection).toEqual(
        (await referenceProject(path)).projection,
      );
      expect(second.trace.projection).not.toEqual(first.trace.projection);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

// Invoke the reference only in tests. Production stays an external package.
describe("current protocol conformance and adversarial ordering", async () => {
  const schemaBytes = await readFile(
    resolve(metaRoot, "config/advisor-core/canonical-events.schema.json"),
  );
  const schema = JSON.parse(schemaBytes.toString());
  const fixtures = await Promise.all(
    [
      "one-worker-done",
      "one-worker-blocked",
      "graph-two-waves",
      "blocked-reply-resume",
      "cancel",
    ].map(async (name) => ({
      name,
      path: resolve(metaRoot, `config/advisor-core/fixtures/${name}.jsonl`),
      events: parseTrace(
        await readFile(
          resolve(metaRoot, `config/advisor-core/fixtures/${name}.jsonl`),
          "utf8",
        ),
      ),
    })),
  );
  const deviationPath = resolve(import.meta.dirname, "fixtures/deviation-follow-up.jsonl");
  fixtures.push({
    name: "deviation-follow-up",
    path: deviationPath,
    events: parseTrace(await readFile(deviationPath, "utf8")),
  });
  const { syntheticLifecycleEvents } = await import("./fixtures.js");
  const { traceProjectionSchema, traceDetailResponseSchema } =
    await import("../src/contracts.js");
  type Events = ReturnType<typeof parseTrace>;
  const normalize = (events: Events): Events =>
    events.map((event, index) => ({
      ...event,
      seq: index + 1,
      at: "2026-09-05T12:00:00.000Z",
    }));
  const fixture = (name: string): Events =>
    structuredClone(fixtures.find((item) => item.name === name)!.events);
  const compare = (events: Events, code?: string) => {
    // Invoke the published reference CLI, including its nonzero validation path.
    const temporaryRoot = mkdtempSync(join(tmpdir(), "bb-current-protocol-"));
    const path = join(temporaryRoot, "trace.jsonl");
    const output = (command: "validate" | "project"): string => {
      try {
        return execFileSync(process.execPath, [referenceCli, command, path], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const failure = error as {
          status: number;
          stdout: string;
          stderr: string;
        };
        expect(failure.status).toBe(1);
        expect(failure.stderr).toBe("");
        return failure.stdout;
      }
    };
    let expected: ReturnType<typeof validateTrace>;
    let projection: unknown;
    try {
      writeFileSync(path, asJsonl(events));
      const validationOutput = output("validate");
      const ok = validationOutput.startsWith("ok:");
      expected = {
        ok,
        problems: ok
          ? []
          : validationOutput
              .trimEnd()
              .split("\n")
              .map((line) => {
                const match = /^(\S+) seq (\d+): (.*)$/u.exec(line);
                expect(match, line).not.toBeNull();
                return {
                  code: match![1]!,
                  seq: Number(match![2]),
                  message: match![3]!,
                };
              }),
      };
      if (
        !expected.problems.some(({ code }) => code === "E_SCHEMA") &&
        events[0]?.type === "run.created"
      ) {
        projection = JSON.parse(output("project")).projection;
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
    expect(validateTrace(events)).toEqual(expected);
    if (code) {
      expect(expected.ok).toBe(false);
      expect(expected.problems.map((problem) => problem.code)).toContain(code);
    }
    // The reducer's documented input is a structurally validated trace.
    if (
      !expected.problems.some((problem) => problem.code === "E_SCHEMA") &&
      events[0]?.type === "run.created"
    ) {
      expect(projectTrace(events)).toEqual(projection);
    }
    return expected;
  };

  it("keeps schema bytes identical and covers every current event type", async () => {
    expect(
      await readFile(
        resolve(import.meta.dirname, "../src/canonical-events.schema.json"),
      ),
    ).toEqual(schemaBytes);
    expect(
      [
        ...new Set(
          fixtures.flatMap(({ events }) => events.map(({ type }) => type)),
        ),
      ].sort(),
    ).toEqual([...schema.properties.type.enum].sort());
  });

  for (const { name, path, events } of fixtures) {
    it(`matches current ${name} CLI output and survives strict RPC serialization`, async () => {
      const expected = await referenceProject(path);
      expect(compare(events)).toEqual({ ok: true, problems: [] });
      expect(projectTrace(events)).toEqual(expected.projection);
      expect(traceProjectionSchema.parse(expected.projection)).toEqual(
        expected.projection,
      );
      const response = {
        ok: true,
        trace: {
          fileName: `${name}.jsonl`,
          partial: false,
          projection: expected.projection,
          validationProblems: {},
        },
      };
      expect(
        traceDetailResponseSchema.parse(JSON.parse(JSON.stringify(response))),
      ).toEqual(response);
    });

    // Each mutation starts reference CLI processes; keep the full matrix on slower CI.
    it(`matches every single-event deletion, duplication and adjacent swap in ${name}`, () => {
      for (let index = 0; index < events.length; index += 1) {
        const deleted = structuredClone(events);
        deleted.splice(index, 1);
        compare(normalize(deleted));
        const duplicated = structuredClone(events);
        duplicated.splice(index, 0, duplicated[index]!);
        compare(normalize(duplicated));
        if (index + 1 < events.length) {
          const swapped = structuredClone(events);
          [swapped[index], swapped[index + 1]] = [
            swapped[index + 1]!,
            swapped[index]!,
          ];
          compare(normalize(swapped));
        }
      }
    }, 30_000);
  }

  // Like the ordering matrix, this deliberately spawns many reference CLI processes.
  it("fails closed with identical diagnostics for malformed fields on every event type", () => {
    const samples = new Map(
      fixtures.flatMap(({ events }) =>
        events.map((event) => [event.type, event] as const),
      ),
    );
    for (const event of samples.values()) {
      const invalid = [
        { ...event, extra: true },
        { ...event, data: { ...event.data, extra: true } },
        { ...event, data: {} },
        { ...event, at: "yesterday" },
        { ...event, seq: 0 },
        { ...event, host: "unknown" },
      ];
      for (const value of invalid) compare([value] as Events, "E_SCHEMA");
    }
    for (const data of [
      { graph: "g", waves: [[]], maxParallel: 1, maxRepairLoops: 0 },
      { graph: "g", waves: [["../escape"]], maxParallel: 1, maxRepairLoops: 0 },
      { graph: "g", waves: [["n"]], maxParallel: 0, maxRepairLoops: -1 },
    ]) {
      compare(
        [{ ...fixture("graph-two-waves")[1]!, data }] as Events,
        "E_SCHEMA",
      );
    }
  }, 30_000);

  it("rejects mismatched wave nodes, absent plans, skipped and duplicate waves", () => {
    const graph = fixture("graph-two-waves");
    compare(
      normalize(graph.filter(({ type }) => type !== "graph.planned")),
      "E_WAVE",
    );
    for (const type of ["wave.started", "wave.completed"] as const) {
      const changed = structuredClone(graph);
      const wave = changed.find((event) => event.type === type)!;
      if (wave.type === type) wave.data.nodes = ["unknown"];
      compare(changed, "E_WAVE");
    }
    compare(
      normalize(
        graph.filter(
          (event) =>
            !(event.type === "wave.completed" && event.data.wave === 1),
        ),
      ),
      "E_WAVE",
    );
  });

  it("enforces reply target, node-local adjacency, dangling replies and resume eligibility", () => {
    const reply = fixture("blocked-reply-resume");
    const wrongTarget = structuredClone(reply);
    const sent = wrongTarget.find((event) => event.type === "node.reply.sent")!;
    if (sent.type === "node.reply.sent") sent.data.replyTo = 1;
    compare(wrongTarget, "E_REPLY");
    const replyIndex = reply.findIndex(
      ({ type }) => type === "node.reply.sent",
    );
    compare(reply.slice(0, replyIndex + 1), "E_REPLY");
    compare(
      normalize(reply.filter(({ type }) => type !== "node.reply.sent")),
      "E_RESUME",
    );
    compare(
      normalize(reply.filter(({ type }) => type !== "node.resumed")),
      "E_REPLY",
    );
    const interrupted = structuredClone(reply);
    interrupted.splice(replyIndex + 1, 0, {
      ...sent,
      type: "node.progress",
      node: sent.node!,
      parent: sent.parent!,
      data: { note: "interruption" },
    });
    compare(normalize(interrupted), "E_REPLY");
    const unrelated = structuredClone(reply);
    // A run-level or other node's event does not consume the pending reply.
    const wakeIndex = unrelated.findIndex(
      ({ type }) => type === "parent.awakened",
    );
    const wake = unrelated.splice(wakeIndex, 1)[0]!;
    unrelated.splice(
      unrelated.findIndex(({ type }) => type === "node.resumed"),
      0,
      wake,
    );
    expect(compare(normalize(unrelated))).toEqual({ ok: true, problems: [] });
    for (const reason of ["reply", "restart", "follow-up"] as const) {
      const done = fixture("one-worker-done");
      done.push({
        ...sent,
        type: "node.resumed",
        node: sent.node!,
        parent: sent.parent!,
        run: done[0]!.run,
        data: { reason },
      });
      if (reason === "follow-up") {
        expect(compare(normalize(done))).toEqual({ ok: true, problems: [] });
      } else {
        compare(normalize(done), "E_RESUME");
      }
    }
  });

  it("preserves bounded deviations across done and failed follow-up attempts", () => {
    const events = fixture("deviation-follow-up");
    expect(compare(events)).toEqual({ ok: true, problems: [] });
    const projection = projectTrace(events);
    expect(projection.nodes[0]).toMatchObject({
      attempts: 2,
      deviations: [
        { count: 1, items: ["Used an equivalent local fixture."] },
        { count: 1, items: ["Reused unchanged verification evidence."] },
      ],
    });
    expect(traceProjectionSchema.parse(projection)).toEqual(projection);
    const failed = structuredClone(events);
    const settled = failed.find((event) => event.type === "node.settled")!;
    if (settled.type === "node.settled") settled.data.status = "failed";
    const wake = failed.find((event) => event.type === "parent.awakened")!;
    if (wake.type === "parent.awakened") wake.data.childStatus = "failed";
    expect(compare(failed)).toEqual({ ok: true, problems: [] });
  });

  it("rejects oversized deviations and per-attempt ordering violations like the reference", () => {
    for (const items of [[], [""], ["x".repeat(201)], Array<string>(9).fill("x")]) {
      const events = fixture("deviation-follow-up");
      const deviation = events.find((event) => event.type === "node.deviation")!;
      if (deviation.type === "node.deviation") deviation.data.items = items;
      compare(events, "E_SCHEMA");
    }
    for (const index of [3, 5, 8]) {
      const events = fixture("deviation-follow-up");
      const deviation = events.splice(4, 1)[0]!;
      events.splice(index, 0, deviation);
      compare(normalize(events), "E_RESULT_ORDER");
    }
    const duplicate = fixture("deviation-follow-up");
    duplicate.splice(5, 0, structuredClone(duplicate[4]!));
    compare(normalize(duplicate), "E_RESULT_ORDER");
    const atLimit = fixture("deviation-follow-up");
    const deviation = atLimit.find((event) => event.type === "node.deviation")!;
    if (deviation.type === "node.deviation") {
      deviation.data = { count: 8, items: Array<string>(8).fill("x".repeat(200)) };
    }
    expect(compare(atLimit)).toEqual({ ok: true, problems: [] });
  });

  it("resets validation gates on resume while retaining projected history", () => {
    const events = syntheticLifecycleEvents();
    expect(compare(events)).toEqual({ ok: true, problems: [] });
    const resumed = events.slice(
      0,
      events.findLastIndex(({ type }) => type === "node.resumed") + 1,
    );
    expect(projectTrace(resumed).nodes[0]).toMatchObject({
      state: "running",
      attempts: 1,
      resultValid: true,
      settledStatus: "blocked",
      replies: [{ source: "user" }],
    });
    const done = {
      ...events.find((event) => event.type === "node.settled")!,
      type: "node.settled" as const,
      data: { status: "done" as const, reason: "must revalidate" },
    };
    compare(normalize([...resumed, done]), "E_SETTLE");
    expect(projectTrace(events).nodes[0]).toMatchObject({
      attempts: 2,
      cancelRequested: true,
      settledStatus: "cancelled",
    });
    expect(
      projectTrace(events).wakes.map(({ generation }) => generation),
    ).toEqual([1, 2]);
  });

  it("allows stalled follow-up and pre-settlement restarts but gates later restarts", () => {
    const stalled = syntheticInvalidResultEvents();
    const resume = syntheticLifecycleEvents().find(
      ({ type }) => type === "node.resumed",
    )!;
    expect(
      compare(
        normalize([
          ...stalled,
          { ...resume, data: { reason: "follow-up" } } as Events[number],
        ]),
      ),
    ).toEqual({ ok: true, problems: [] });
    const running = syntheticDoneEvents().slice(0, 3);
    expect(compare(normalize([...running, resume]))).toEqual({
      ok: true,
      problems: [],
    });
  });

  it("allows blocked cancellation with ordered delayed wakes and rejects cancellation without a new request", () => {
    const blocked = syntheticBlockedEvents();
    const lifecycle = syntheticLifecycleEvents();
    const request = lifecycle.find(
      ({ type }) => type === "node.cancel.requested",
    )!;
    const cancelled = lifecycle.find(
      (event) =>
        event.type === "node.settled" && event.data.status === "cancelled",
    )!;
    const wake = lifecycle.findLast(({ type }) => type === "parent.awakened")!;
    const delayed = normalize([
      ...blocked.slice(0, -1),
      request,
      cancelled,
      blocked.at(-1)!,
      wake,
    ]);
    expect(compare(delayed)).toEqual({ ok: true, problems: [] });
    compare(normalize([...blocked, cancelled]), "E_ORDER");
    compare(normalize([...syntheticDoneEvents(), request]), "E_ORDER");
    compare(normalize([...delayed, wake]), "E_WAKE");
    const wrongStatus = structuredClone(delayed);
    const firstWake = wrongStatus.find(
      (event) => event.type === "parent.awakened",
    )!;
    if (firstWake.type === "parent.awakened")
      firstWake.data.childStatus = "cancelled";
    compare(wrongStatus, "E_WAKE");
    const wrongGeneration = structuredClone(delayed);
    const last = wrongGeneration.at(-1)!;
    if (last.type === "parent.awakened") last.data.wakeGeneration = 1;
    compare(wrongGeneration, "E_WAKE");
  });

  it("retains cancellation history across a legal resume", () => {
    const blocked = syntheticBlockedEvents();
    const lifecycle = syntheticLifecycleEvents();
    const request = lifecycle.find(
      ({ type }) => type === "node.cancel.requested",
    )!;
    const resume = lifecycle.find(({ type }) => type === "node.resumed")!;
    const events = normalize([...blocked, request, resume]);
    expect(compare(events)).toEqual({ ok: true, problems: [] });
    expect(projectTrace(events).nodes[0]).toMatchObject({
      state: "running",
      cancelRequested: true,
      attempts: 1,
    });
  });

  it("rejects unknown RPC fields and invalid lifecycle field types without stripping", () => {
    const projection = projectTrace(syntheticLifecycleEvents());
    expect(traceProjectionSchema.parse(projection)).toEqual(projection);
    for (const patch of [
      { attempts: -1 },
      { attempts: 1.5 },
      { cancelRequested: "true" },
      { replies: [{ at: "now", text: "x", source: "system" }] },
      { extra: true },
    ]) {
      expect(
        traceProjectionSchema.safeParse({
          ...projection,
          nodes: [{ ...projection.nodes[0], ...patch }],
        }).success,
      ).toBe(false);
    }
    expect(
      traceProjectionSchema.safeParse({
        ...projection,
        run: {
          ...projection.run,
          waves: [{ ...projection.run!.waves[0], extra: true }],
        },
      }).success,
    ).toBe(false);
  });
});
