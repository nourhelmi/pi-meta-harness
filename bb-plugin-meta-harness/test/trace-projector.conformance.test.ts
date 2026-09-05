import { execFile } from "node:child_process";
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
const liveRoot = "/Users/nour/.advisor/pi-meta-harness-0c8d98ab/traces";

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
  const liveFixtures = [
    "cc-7f4cbf58226aaebc-1.jsonl",
    "cx-a1b2a3c4c829ebae-1.jsonl",
  ];

  for (const fileName of liveFixtures) {
    it(`deeply matches the live ${fileName} projection`, async () => {
      const path = resolve(liveRoot, fileName);
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
