// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import type {
  TraceDetail,
  TraceDetailResponse,
  TraceListResponse,
  TraceSummary,
} from "../src/contracts.js";
import {
  projectTrace,
  validationProblemsFromEvents,
} from "../src/trace-projector.js";
import {
  syntheticBlockedEvents,
  syntheticDoneEvents,
  withRunId,
} from "./fixtures.js";

const mounted: Array<{ lifecycle: { unmount(): void } }> = [];

afterEach(() => {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
});

function detail(
  fileName = "run-1.jsonl",
  events = syntheticDoneEvents(),
  partial = false,
): TraceDetail {
  return {
    fileName,
    partial,
    projection: projectTrace(events),
    validationProblems: validationProblemsFromEvents(events),
  };
}

function summary(trace: TraceDetail): TraceSummary {
  const run = trace.projection.run!;
  return {
    ok: true,
    fileName: trace.fileName,
    partial: trace.partial,
    runId: run.id,
    host: run.host,
    workstream: run.workstream,
    lastState: trace.projection.nodes.at(-1)?.state ?? "created",
    lastAt: run.lastAt,
  };
}

async function loadPanel() {
  const app = await loadPluginApp(() => import("../src/app.js"));
  expect(app.navPanels).toHaveLength(1);
  expect(app.navPanels[0]).toMatchObject({
    id: "trace",
    path: "trace",
    title: "Advisor traces",
  });
  return app.navPanels[0]!;
}

describe("Advisor trace nav panel", () => {
  it("exposes a uniquely labeled busy region without owning a main landmark", async () => {
    const panel = await loadPanel();
    let resolveList!: (response: TraceListResponse) => void;
    const pendingList = new Promise<TraceListResponse>((resolve) => {
      resolveList = resolve;
    });
    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        settings: { hostId: "host-1", stateRoot: "/advisor" },
        rpc: { listTraces: () => pendingList },
      },
    );
    mounted.push(slot);

    const title = slot.getByRole("heading", {
      level: 1,
      name: "Execution traces",
    });
    const region = slot.getByRole("region", { name: "Execution traces" });
    expect(region.tagName).toBe("SECTION");
    expect(region.getAttribute("aria-labelledby")).toBe(title.id);
    expect(title.id).not.toBe("");
    expect(
      Array.from(slot.container.querySelectorAll("[id]")).filter(
        (element) => element.id === title.id,
      ),
    ).toHaveLength(1);
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(slot.container.querySelector("main")).toBeNull();

    resolveList({ ok: true, traces: [] });
    await slot.findByText("No canonical traces");
    expect(region.getAttribute("aria-busy")).toBe("false");
  });

  it("pins a mobile trace index while preserving desktop and wrapping contracts", async () => {
    const css = await readFile(resolve(process.cwd(), "src/app.css"), "utf8");
    const styleElement = document.createElement("style");
    styleElement.textContent = css;
    document.head.append(styleElement);

    try {
      const topLevelRules = Array.from(styleElement.sheet?.cssRules ?? []);
      const isStyleRule = (rule: CSSRule): rule is CSSStyleRule =>
        "selectorText" in rule && typeof rule.selectorText === "string";
      const styleRule = (selector: string): CSSStyleRule | undefined =>
        topLevelRules.find(
          (rule): rule is CSSStyleRule =>
            isStyleRule(rule) && rule.selectorText === selector,
        );
      const groupedStyleRule = (selector: string): CSSStyleRule | undefined =>
        topLevelRules.find(
          (rule): rule is CSSStyleRule =>
            isStyleRule(rule) &&
            rule.selectorText
              .split(",")
              .some((candidate) => candidate.trim() === selector),
        );
      expect(
        styleRule(".trace-layout")?.style.getPropertyValue(
          "grid-template-columns",
        ),
      ).toBe("minmax(17rem, 22rem) minmax(0, 1fr)");
      expect(
        styleRule(".trace-index-row")?.style.getPropertyValue("min-width"),
      ).toBe("0");
      expect(
        groupedStyleRule(".trace-run-id")?.style.getPropertyValue(
          "overflow-wrap",
        ),
      ).toBe("anywhere");
      expect(
        styleRule(".trace-wrap-path")?.style.getPropertyValue("word-break"),
      ).toBe("break-word");

      const mobileRule = topLevelRules.find(
        (rule): rule is CSSMediaRule =>
          "conditionText" in rule &&
          rule.conditionText === "(max-width: 860px)",
      );
      expect(mobileRule).toBeDefined();

      const mobileRules = Array.from(mobileRule?.cssRules ?? []);
      const layoutRule = mobileRules.find(
        (rule): rule is CSSStyleRule =>
          "selectorText" in rule && rule.selectorText === ".trace-layout",
      );
      const indexRule = mobileRules.find(
        (rule): rule is CSSStyleRule =>
          "selectorText" in rule && rule.selectorText === ".trace-index",
      );

      expect(layoutRule?.style.getPropertyValue("grid-template-columns")).toBe(
        "minmax(0, 1fr)",
      );
      expect(layoutRule?.style.getPropertyValue("grid-template-rows")).toBe(
        "clamp(12rem, 36vh, 19rem) auto",
      );
      expect(layoutRule?.style.getPropertyValue("flex")).toBe("0 0 auto");
      expect(indexRule?.style.getPropertyValue("min-height")).toBe("12rem");
      expect(indexRule?.style.getPropertyValue("max-height")).toBe("19rem");
      expect(indexRule?.style.getPropertyValue("overflow-y")).toBe("auto");
      expect(indexRule?.style.getPropertyValue("overscroll-behavior-y")).toBe(
        "contain",
      );
    } finally {
      styleElement.remove();
    }
  });

  it("shows an accessible configuration state without making RPC calls", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(panel, { subPath: "" });
    mounted.push(slot);
    await slot.findByText("Configuration required");
    expect(slot.rpcCalls).toEqual([]);
    expect(
      (slot.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("treats invalid persisted settings as needs-configuration without RPC", async () => {
    const panel = await loadPanel();
    const slot = renderSlot(
      panel,
      { subPath: "" },
      { settings: { hostId: " ", stateRoot: "relative/path" } },
    );
    mounted.push(slot);
    await slot.findByText("Configuration required");
    expect(slot.rpcCalls).toEqual([]);
  });

  it("renders complete run, node, result, validation, blocked, and wake fields", async () => {
    const panel = await loadPanel();
    const current = detail("blocked.jsonl", syntheticBlockedEvents());
    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        settings: { hostId: "host-1", stateRoot: "/advisor" },
        rpc: {
          listTraces: (): TraceListResponse => ({
            ok: true,
            traces: [summary(current)],
          }),
          readTrace: (): TraceDetailResponse => ({ ok: true, trace: current }),
        },
      },
    );
    mounted.push(slot);

    await slot.findByRole("heading", { name: "Surface maker" });
    expect(slot.getByText("surface-test")).not.toBeNull();
    expect(slot.getByText("session-1")).not.toBeNull();
    expect(slot.getByText("surface-graph")).not.toBeNull();
    expect(slot.getByText("Projection is deeply equivalent.")).not.toBeNull();
    expect(
      slot.getByText("Choose the bounded compatibility path."),
    ).not.toBeNull();
    expect(slot.getByText("Decision required")).not.toBeNull();
    expect(slot.getByText("Validation reported no notes.")).not.toBeNull();
    expect(
      slot.container.querySelector(".trace-wake-edge")?.textContent,
    ).toContain("advisor ← builder-1");
    expect(slot.getByText("generation 1")).not.toBeNull();
    expect(
      slot
        .getByRole("button", { name: /synthetic-run-1/u })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps aria-labelledby ids unique when canonical node ids normalize alike", async () => {
    const panel = await loadPanel();
    const [created, launched] = syntheticDoneEvents();
    if (
      created === undefined ||
      launched === undefined ||
      launched.type !== "node.launched"
    ) {
      throw new Error("synthetic launch fixture is incomplete");
    }
    const collision = detail("collision.jsonl", [
      created,
      {
        ...launched,
        node: "worker.a",
        data: { ...launched.data, label: "Dot" },
      },
      {
        ...launched,
        seq: 3,
        at: "2026-09-05T08:00:02.000Z",
        node: "worker-a",
        data: { ...launched.data, label: "Dash" },
      },
    ]);
    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        settings: { hostId: "host-1", stateRoot: "/advisor" },
        rpc: {
          listTraces: () => ({
            ok: true as const,
            traces: [summary(collision)],
          }),
          readTrace: () => ({ ok: true as const, trace: collision }),
        },
      },
    );
    mounted.push(slot);
    await slot.findByRole("heading", { name: "Dash" });
    const labelledIds = Array.from(
      slot.container.querySelectorAll("article[aria-labelledby]"),
      (article) => article.getAttribute("aria-labelledby"),
    );
    expect(labelledIds).toHaveLength(2);
    expect(new Set(labelledIds).size).toBe(2);
  });

  it("replaces rows and detail on explicit refresh without stale or duplicate data", async () => {
    const panel = await loadPanel();
    let current = detail();
    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        settings: { hostId: "host-1", stateRoot: "/advisor" },
        rpc: {
          listTraces: (): TraceListResponse => ({
            ok: true,
            traces: [summary(current)],
          }),
          readTrace: (): TraceDetailResponse => ({ ok: true, trace: current }),
        },
      },
    );
    mounted.push(slot);
    await slot.findByRole("heading", { name: "synthetic-run-1" });

    current = detail(
      "run-1.jsonl",
      withRunId(syntheticDoneEvents(), "replacement-run-2"),
    );
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await slot.findByRole("heading", { name: "replacement-run-2" });
    expect(slot.queryByRole("heading", { name: "synthetic-run-1" })).toBeNull();
    expect(
      slot.getAllByRole("button", { name: /replacement-run-2/u }),
    ).toHaveLength(1);
    expect(slot.rpcCalls.map(({ method }) => method)).toEqual([
      "listTraces",
      "readTrace",
      "listTraces",
      "readTrace",
    ]);
  });

  it("reprojects an appended event on Refresh without duplicating the selected run", async () => {
    const panel = await loadPanel();
    let current = detail("append.jsonl", syntheticDoneEvents().slice(0, 2));
    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        settings: { hostId: "host-1", stateRoot: "/advisor" },
        rpc: {
          listTraces: (): TraceListResponse => ({
            ok: true,
            traces: [summary(current)],
          }),
          readTrace: (): TraceDetailResponse => ({ ok: true, trace: current }),
        },
      },
    );
    mounted.push(slot);
    await slot.findByText("No parent wake recorded.");
    expect(slot.queryByText("Descriptor checks passed.")).toBeNull();

    current = detail("append.jsonl", syntheticDoneEvents().slice(0, 3));
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await slot.findByText("Descriptor checks passed.");
    expect(
      slot.getAllByRole("button", { name: /synthetic-run-1/u }),
    ).toHaveLength(1);
    expect(slot.getAllByText("Descriptor checks passed.")).toHaveLength(1);
  });

  it("refetches once after reconnect but not on the first connection", async () => {
    const panel = await loadPanel();
    const current = detail();
    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        settings: { hostId: "host-1", stateRoot: "/advisor" },
        realtimeConnectionState: "connecting",
        rpc: {
          listTraces: () => ({ ok: true as const, traces: [summary(current)] }),
          readTrace: () => ({ ok: true as const, trace: current }),
        },
      },
    );
    mounted.push(slot);
    await slot.findByRole("heading", { name: "synthetic-run-1" });
    expect(slot.rpcCalls).toHaveLength(2);

    await slot.behavior.setRealtimeConnectionState("connected");
    expect(slot.rpcCalls).toHaveLength(2);
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByRole("heading", { name: "synthetic-run-1" });
    expect(slot.rpcCalls).toHaveLength(4);
  });

  it("refetches on settings change and plugin or host restart remount without retaining old rows", async () => {
    const panel = await loadPanel();
    const settings = { hostId: "host-1", stateRoot: "/advisor-a" };
    let current = detail();
    const rpc = {
      listTraces: () => ({ ok: true as const, traces: [summary(current)] }),
      readTrace: () => ({ ok: true as const, trace: current }),
    };
    const slot = renderSlot(panel, { subPath: "" }, { settings, rpc });
    mounted.push(slot);
    await slot.findByRole("heading", { name: "synthetic-run-1" });

    settings.stateRoot = "/advisor-b";
    current = detail(
      "run-1.jsonl",
      withRunId(syntheticDoneEvents(), "settings-run-2"),
    );
    const Panel = panel.component;
    slot.lifecycle.rerender(<Panel subPath="" />);
    await slot.findByRole("heading", { name: "settings-run-2" });
    expect(slot.queryByRole("heading", { name: "synthetic-run-1" })).toBeNull();

    slot.lifecycle.unmount();
    mounted.splice(mounted.indexOf(slot), 1);
    current = detail(
      "run-1.jsonl",
      withRunId(syntheticDoneEvents(), "restart-run-3"),
    );
    const restarted = renderSlot(panel, { subPath: "" }, { settings, rpc });
    mounted.push(restarted);
    await restarted.findByRole("heading", { name: "restart-run-3" });
    expect(
      restarted.getAllByRole("button", { name: /restart-run-3/u }),
    ).toHaveLength(1);
  });

  it("renders empty, partial, malformed, vanished, and host error states", async () => {
    const panel = await loadPanel();
    const settings = { hostId: "host-1", stateRoot: "/advisor" };

    const empty = renderSlot(
      panel,
      { subPath: "" },
      {
        settings,
        rpc: { listTraces: () => ({ ok: true as const, traces: [] }) },
      },
    );
    mounted.push(empty);
    await empty.findByText("No canonical traces");

    const current = detail("partial.jsonl", syntheticDoneEvents(), true);
    const partial = renderSlot(
      panel,
      { subPath: "" },
      {
        settings,
        rpc: {
          listTraces: () => ({ ok: true as const, traces: [summary(current)] }),
          readTrace: () => ({ ok: true as const, trace: current }),
        },
      },
    );
    mounted.push(partial);
    await partial.findByText(/Partial append detected/u);

    const malformed = renderSlot(
      panel,
      { subPath: "" },
      {
        settings,
        rpc: {
          listTraces: () => ({
            ok: true as const,
            traces: [
              {
                ok: false as const,
                fileName: "bad.jsonl",
                error: { code: "MALFORMED_JSON" as const, message: "bad JSON" },
              },
            ],
          }),
          readTrace: () => ({
            ok: false as const,
            fileName: "bad.jsonl",
            error: { code: "MALFORMED_JSON" as const, message: "bad JSON" },
          }),
        },
      },
    );
    mounted.push(malformed);
    await malformed.findByRole("alert");
    expect(malformed.getByText(/MALFORMED_JSON/u)).not.toBeNull();

    const vanished = renderSlot(
      panel,
      { subPath: "" },
      {
        settings,
        rpc: {
          listTraces: () => ({ ok: true as const, traces: [summary(current)] }),
          readTrace: () => ({
            ok: false as const,
            fileName: "partial.jsonl",
            error: { code: "TRACE_DISAPPEARED" as const, message: "gone" },
          }),
        },
      },
    );
    mounted.push(vanished);
    await vanished.findByText("Selected trace vanished");

    const hostError = renderSlot(
      panel,
      { subPath: "" },
      {
        settings,
        rpc: {
          listTraces: () => {
            throw new Error("host offline");
          },
        },
      },
    );
    mounted.push(hostError);
    await hostError.findByText("Trace index unavailable");
  });
});
