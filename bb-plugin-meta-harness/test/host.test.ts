import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { traceHostContract } from "../src/contracts.js";
import metaHarnessPlugin from "../src/server.js";
import {
  projectTrace,
  validateTrace,
  validationProblemsFromEvents,
} from "../src/trace-projector.js";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "../src/host.js";
import {
  asJsonl,
  syntheticDoneEvents,
  syntheticLifecycleEvents,
} from "./fixtures.js";

describe("public host entry", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("preserves current lifecycle fields from the descriptor read through host and server contracts", async () => {
    root = await mkdtemp(join(tmpdir(), "bb-trace-lifecycle-"));
    await mkdir(join(root, "traces"));
    const events = syntheticLifecycleEvents();
    expect(validateTrace(events)).toEqual({ ok: true, problems: [] });
    const path = join(root, "traces", "lifecycle.jsonl");
    await writeFile(path, asJsonl(events));
    const host = experimental_createHostEntryHarness(hostEntry);
    const { bb, harness } = createFakePluginHost({
      pluginId: "meta-harness",
      settings: { hostId: "host-17", stateRoot: root },
      experimental_callHostRpc(call) {
        if (call.method === "readTrace" || call.method === "listTraces") {
          return host.experimental_call(
            call.method,
            traceHostContract[call.method].input.parse(call.input),
          );
        }
        throw new Error(`Unexpected host method ${call.method}`);
      },
    });
    try {
      await metaHarnessPlugin(bb);
      expect(
        await harness.callRpc("readTrace", { fileName: "lifecycle.jsonl" }),
      ).toEqual({
        ok: true,
        trace: {
          fileName: "lifecycle.jsonl",
          partial: false,
          projection: projectTrace(events),
          validationProblems: validationProblemsFromEvents(events),
        },
      });
      // A broken current-protocol order must return no projection through either RPC boundary.
      await writeFile(
        path,
        asJsonl(
          events
            .filter(({ type }) => type !== "node.reply.sent")
            .map((event, index) => ({ ...event, seq: index + 1 })),
        ),
      );
      const rejected = await harness.callRpc("readTrace", {
        fileName: "lifecycle.jsonl",
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: "INVALID_TRACE" },
      });
      expect(rejected).not.toHaveProperty("trace");
    } finally {
      await host.experimental_dispose();
    }
  });

  it("validates RPC input and returns a bounded canonical projection", async () => {
    root = await mkdtemp(join(tmpdir(), "bb-trace-host-"));
    await mkdir(join(root, "traces"));
    await writeFile(
      join(root, "traces", "host.jsonl"),
      asJsonl(syntheticDoneEvents()),
    );
    const harness = experimental_createHostEntryHarness(hostEntry);
    await expect(
      harness.experimental_call("listTraces", { stateRoot: root }),
    ).resolves.toMatchObject({
      ok: true,
      traces: [{ fileName: "host.jsonl" }],
    });
    await expect(
      harness.experimental_call("readTrace", {
        stateRoot: root,
        fileName: "host.jsonl",
      }),
    ).resolves.toMatchObject({
      ok: true,
      trace: { projection: { run: { id: "synthetic-run-1" } } },
    });
    await expect(
      harness.experimental_call("readTrace", {
        stateRoot: root,
        fileName: "../escape.jsonl",
      }),
    ).rejects.toThrow(/Invalid canonical trace filename/u);
    await harness.experimental_dispose();
  });
});
