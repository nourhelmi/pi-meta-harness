import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import metaHarnessPlugin from "../src/server.js";

describe("typed server bridge", () => {
  it("reports needs-configuration and dispatches nothing without both settings", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "meta-harness" });
    await metaHarnessPlugin(bb);

    expect(harness.needsConfigurationMessages).toEqual([
      "Set hostId and an absolute advisor stateRoot, then reload the plugin.",
    ]);
    await expect(harness.callRpc("listTraces", null)).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_CONFIGURATION" },
    });
    expect(harness.experimental_hostRpcCalls).toEqual([]);
  });

  it("uses only the configured explicit host and root for typed host RPC", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "meta-harness",
      settings: { hostId: "host-17", stateRoot: "/advisor/state" },
      experimental_callHostRpc(call) {
        if (call.method === "listTraces") return { ok: true, traces: [] };
        return {
          ok: false,
          fileName: "run-1.jsonl",
          error: { code: "TRACE_DISAPPEARED", message: "gone" },
        };
      },
    });
    await metaHarnessPlugin(bb);

    expect(harness.needsConfigurationMessages).toEqual([]);
    await harness.callRpc("listTraces", null);
    await harness.callRpc("readTrace", { fileName: "run-1.jsonl" });
    expect(harness.experimental_hostRpcCalls).toMatchObject([
      {
        method: "listTraces",
        hostId: "host-17",
        input: { stateRoot: "/advisor/state" },
      },
      {
        method: "readTrace",
        hostId: "host-17",
        input: { stateRoot: "/advisor/state", fileName: "run-1.jsonl" },
      },
    ]);
    expect(harness.sdk.calls).toEqual([]);
    expect(harness.registrations.services).toEqual([]);
    expect(harness.registrations.schedules).toEqual([]);
  });

  it("validates byte-bounded settings and rereads settings on every request", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "meta-harness",
      settings: { hostId: "host-a", stateRoot: "/root-a" },
      experimental_callHostRpc: () => ({ ok: true, traces: [] }),
    });
    await metaHarnessPlugin(bb);

    await expect(
      harness.setSettings({ stateRoot: "relative/path" }),
    ).rejects.toThrow(/absolute path/u);
    await expect(
      harness.setSettings({ hostId: "x".repeat(129) }),
    ).rejects.toThrow(/128 UTF-8 bytes/u);
    await expect(
      harness.setSettings({ stateRoot: "/root\nother" }),
    ).rejects.toThrow(/control characters/u);

    await harness.callRpc("listTraces", null);
    await harness.setSettings({ hostId: "host-b", stateRoot: "/root-b" });
    await harness.callRpc("listTraces", null);
    expect(harness.experimental_hostRpcCalls).toMatchObject([
      { hostId: "host-a", input: { stateRoot: "/root-a" } },
      { hostId: "host-b", input: { stateRoot: "/root-b" } },
    ]);
  });
});
