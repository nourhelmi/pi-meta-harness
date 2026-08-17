import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import advisorSessionExtension from "../extensions/advisor-session.ts";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface AdvisorLaunchTool {
  name: string;
  execute(
    toolCallId: string,
    params: { cwd: string; workstream?: string; purpose?: string; prompt?: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<{ details: { tabId: string; paneId: string; label: string; cwd: string; workstream?: string } }>;
}

function installedAdvisorLaunch(respond: (args: string[]) => ExecResult) {
  let tool: AdvisorLaunchTool | undefined;
  const calls: string[][] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      return respond(args);
    },
    on: () => undefined,
    registerTool: (candidate: AdvisorLaunchTool) => {
      if (candidate.name === "advisor_launch") tool = candidate;
    },
  } as unknown as ExtensionAPI;
  advisorSessionExtension(pi);
  assert.ok(tool, "advisor_launch is registered");
  return { calls, tool };
}

async function withHerdrEnvironment<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  }
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

test("advisor_launch creates an unfocused tab and sends the advisor bootstrap", async () => {
  const { calls, tool } = installedAdvisorLaunch((args) => {
    if (args[0] === "tab" && args[1] === "create") {
      return ok(JSON.stringify({ result: { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } } }));
    }
    return ok();
  });

  await withHerdrEnvironment(async () => {
    const result = await tool.execute(
      "test-call",
      {
        cwd: ".",
        workstream: "Close Controls",
        purpose: "advisor launch controls",
        prompt: "Inspect the final diff.",
      },
      undefined,
      undefined,
      { cwd: process.cwd() } as ExtensionContext,
    );
    assert.deepEqual(result.details, {
      tabId: "w1:t9",
      paneId: "w1:p9",
      label: "advisor · launch controls",
      cwd: process.cwd(),
      workstream: "close-controls",
    });
  });

  assert.deepEqual(calls, [
    ["tab", "create", "--no-focus", "--cwd", process.cwd(), "--label", "advisor · launch controls"],
    ["pane", "rename", "w1:p9", "advisor · launch controls"],
    ["pane", "run", "w1:p9", "pi"],
    ["agent", "get", "w1:p9"],
    [
      "agent",
      "prompt",
      "w1:p9",
      "/skill:advisor\n\nCall advisor_session_init with workstream \"close-controls\" before any other tool.\n\nAdditional instructions:\nInspect the final diff.",
    ],
  ]);
});

test("advisor_launch closes a created tab when its root pane is missing", async () => {
  const { calls, tool } = installedAdvisorLaunch((args) => {
    if (args[0] === "tab" && args[1] === "create") {
      return ok(JSON.stringify({ result: { tab: { tab_id: "w1:t9" }, root_pane: {} } }));
    }
    return ok();
  });

  await withHerdrEnvironment(async () => {
    await assert.rejects(
      tool.execute("test-call", { cwd: ".", purpose: "tab launch" }, undefined, undefined, { cwd: process.cwd() } as ExtensionContext),
      /did not return the new advisor root pane ID/,
    );
  });

  assert.deepEqual(calls, [
    ["tab", "create", "--no-focus", "--cwd", process.cwd(), "--label", "advisor · tab launch"],
    ["tab", "close", "w1:t9"],
  ]);
});
