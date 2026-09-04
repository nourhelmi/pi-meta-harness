// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { metaHarnessRpcContract } from "../src/contracts.js";

const generation = "c".repeat(64);
const snapshot = {
  graphId: "bb-adapter-live-canary",
  hash: "d".repeat(64),
  waves: [{ index: 1, nodeIds: ["maker", "blocked-right"] }, { index: 2, nodeIds: ["checker"] }],
  nodes: [
    { id: "maker", role: "builder", dependsOn: [], worktree: "/worktrees/maker", status: "done", runId: "run-maker", threadId: "thread-maker", hostId: "host-1", threadState: "idle", resultStatus: "PASS", logPath: "/detach/maker/output.log", logTail: "build passed", artifactPath: "/advisor/maker/result.md", artifact: "## Status\nPASS" },
    { id: "blocked-right", role: "builder", dependsOn: [], worktree: "/worktrees/blocked", status: "blocked", runId: "run-blocked", threadId: "thread-blocked", hostId: "host-1", threadState: "idle", resultStatus: "BLOCKED waiting" },
    { id: "checker", role: "checker", dependsOn: ["maker", "blocked-right"], worktree: "/worktrees/checker", status: "planned" },
  ],
  edges: [{ from: "maker", to: "checker" }, { from: "blocked-right", to: "checker" }],
  launchReservations: [{
    runId: "run-launch",
    state: "unknown" as const,
    hostId: "host-1",
    projectId: "project-1",
    cwd: "/worktrees/launch",
    createdAt: 1,
    updatedAt: 2,
    failureReason: "spawn response was lost",
  }],
  wakeAdmissions: [{ logicalParentThreadId: "parent-1", settlementGeneration: generation, runId: "run-maker", state: "unknown" as const }],
};

describe("app", () => {
  it("registers one additive nav panel and no replacement slots", async () => {
    const app = await loadPluginApp(() => import("../src/app.js"));
    expect(app.navPanels.map((panel) => panel.id)).toEqual(["meta-harness"]);
    expect(app.threadLists).toHaveLength(0);
    expect(app.experimentalSidebarNavigations).toHaveLength(0);
  });

  it("renders canonical waves, identities, artifacts, and accessible exact-target controls and refetches", async () => {
    const app = await loadPluginApp(() => import("../src/app.js"));
    const panel = app.navPanels[0];
    if (!panel) throw new Error("nav panel was not registered");
    let snapshotCalls = 0;
    const rendered = renderSlot<PluginNavPanelProps, typeof metaHarnessRpcContract>(panel, { subPath: "" }, {
      rpc: {
        snapshot: () => { snapshotCalls += 1; return snapshot; },
        stop: () => ({ ok: true }),
        message: () => ({ ok: true }),
        answerBlocked: () => ({ ok: true }),
        retryWake: () => ({ ok: true }),
        skipWake: () => ({ ok: true }),
      },
    });

    expect(await rendered.findByText("Meta Harness switchboard")).toBeTruthy();
    expect(rendered.getByText("Wave 1")).toBeTruthy();
    expect(rendered.getByText("Wave 2")).toBeTruthy();
    expect(rendered.getByText("blocked-right")).toBeTruthy();
    expect(rendered.getByText("maker → checker")).toBeTruthy();
    expect(rendered.getByText(/thread-blocked/)).toBeTruthy();
    expect(rendered.getAllByText(/run-maker/)).toHaveLength(2);
    expect(rendered.getByText(/Result · \/advisor\/maker\/result.md/)).toBeTruthy();
    expect(rendered.getByText(/Log · \/detach\/maker\/output.log/)).toBeTruthy();
    expect(rendered.getByText("Launch reservations")).toBeTruthy();
    expect(rendered.getByText(/run-launch/)).toBeTruthy();
    expect(rendered.getByText("spawn response was lost")).toBeTruthy();

    fireEvent.click(rendered.getAllByRole("button", { name: "Open" })[1]!);
    expect(rendered.navigateCalls.at(-1)).toMatchObject({ threadId: "thread-blocked" });

    fireEvent.click(rendered.getAllByRole("button", { name: "Stop" })[1]!);
    await waitFor(() => expect(rendered.rpcCalls).toContainEqual({ method: "stop", input: { threadId: "thread-blocked" } }));

    fireEvent.click(rendered.getAllByRole("button", { name: "Message" })[1]!);
	fireEvent.click(rendered.getByRole("button", { name: "Cancel" }));
	expect(rendered.queryByLabelText("Message")).toBeNull();
	expect(rendered.rpcCalls.some((call) => call.method === "answerBlocked")).toBe(false);

	fireEvent.click(rendered.getAllByRole("button", { name: "Message" })[1]!);
    const input = rendered.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "inspect the failure" } });
    fireEvent.click(rendered.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(rendered.rpcCalls).toContainEqual({ method: "message", input: { threadId: "thread-blocked", text: "inspect the failure" } }));

    fireEvent.click(rendered.getByRole("button", { name: "Answer BB-POC-CONTINUE" }));
    await waitFor(() => expect(rendered.rpcCalls).toContainEqual({ method: "answerBlocked", input: { runId: "run-blocked", threadId: "thread-blocked", answer: "BB-POC-CONTINUE" } }));

    fireEvent.click(rendered.getByRole("button", { name: "Retry (may duplicate)" }));
    await waitFor(() => expect(rendered.rpcCalls).toContainEqual({ method: "retryWake", input: { logicalParentThreadId: "parent-1", settlementGeneration: generation } }));

    const beforeInvalidation = snapshotCalls;
    await rendered.emitRealtime("projection-invalidated", { runId: "run-maker" });
    await waitFor(() => expect(snapshotCalls).toBeGreaterThan(beforeInvalidation));
    await rendered.setRealtimeConnectionState("reconnecting");
    const beforeReconnect = snapshotCalls;
    await rendered.setRealtimeConnectionState("connected");
    await waitFor(() => expect(snapshotCalls).toBeGreaterThan(beforeReconnect));
  });
});
