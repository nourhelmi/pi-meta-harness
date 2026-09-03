import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrBlockedBridge from "../extensions/herdr-blocked-bridge.ts";

interface PromptEvent {
  type: "ui_prompt_start" | "ui_prompt_end";
  reason: "ui_prompt";
  kind: "select" | "confirm" | "input" | "editor" | "custom";
  title?: string;
}

type PromptHook = (event: PromptEvent) => void;

function loadBridge(enabled: boolean) {
  const previous = process.env.HERDR_ENV;
  if (enabled) process.env.HERDR_ENV = "1";
  else delete process.env.HERDR_ENV;

  const hooks: Record<string, PromptHook> = {};
  const emissions: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    events: {
      emit: (channel: string, data: unknown) => emissions.push({ channel, data }),
    },
    on: (name: string, handler: PromptHook) => {
      hooks[name] = handler;
    },
  } as unknown as ExtensionAPI;
  try {
    herdrBlockedBridge(pi);
  } finally {
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  }
  return { hooks, emissions };
}

test("bridges a titled prompt as one balanced Herdr blocked pair", () => {
  const { hooks, emissions } = loadBridge(true);
  hooks.ui_prompt_start?.({
    type: "ui_prompt_start",
    reason: "ui_prompt",
    kind: "custom",
    title: "Choose a workstream",
  });
  hooks.ui_prompt_end?.({
    type: "ui_prompt_end",
    reason: "ui_prompt",
    kind: "custom",
  });

  assert.deepEqual(emissions, [
    { channel: "herdr:blocked", data: { active: true, label: "Choose a workstream" } },
    { channel: "herdr:blocked", data: { active: false } },
  ]);
});

test("uses the prompt kind as the fallback label", () => {
  const { hooks, emissions } = loadBridge(true);
  hooks.ui_prompt_start?.({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select" });

  assert.deepEqual(emissions, [
    { channel: "herdr:blocked", data: { active: true, label: "select prompt" } },
  ]);
});

test("ignores unmatched prompt ends", () => {
  const { hooks, emissions } = loadBridge(true);
  hooks.ui_prompt_end?.({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
  assert.deepEqual(emissions, []);
});

test("registers no hooks outside Herdr", () => {
  const { hooks, emissions } = loadBridge(false);
  assert.deepEqual(hooks, {});
  assert.deepEqual(emissions, []);
});
