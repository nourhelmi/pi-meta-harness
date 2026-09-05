import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry from "../src/host.js";
import { asJsonl, syntheticDoneEvents } from "./fixtures.js";

describe("public host entry", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
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
