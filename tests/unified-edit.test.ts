import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import unifiedEditCoordinator from "../extensions/unified-edit.ts";

interface RegisteredTool {
  name: string;
  execute(
    toolCallId: string,
    params: { text: string },
    signal: AbortSignal,
    onUpdate: undefined,
    context: { cwd: string },
  ): Promise<{ content: { type: string; text: string }[] }>;
}

function coordinatorHarness(
  registerTool: (candidate: RegisteredTool) => void,
  existingSource = "builtin",
): { pi: ExtensionAPI; start(): void } {
  let startHandler: (() => void) | undefined;
  const pi = {
    on(event: string, handler: () => void) {
      assert.equal(event, "session_start");
      startHandler = handler;
    },
    getAllTools() {
      return [{ name: "edit", sourceInfo: { source: existingSource } }];
    },
    registerTool,
  } as unknown as ExtensionAPI;
  return {
    pi,
    start() {
      assert.ok(startHandler);
      startHandler();
    },
  };
}

test("unified edit fallback applies a row replacement when no external editor loaded", async () => {
  const registered: RegisteredTool[] = [];
  const harness = coordinatorHarness((candidate) => {
    registered.push(candidate);
  });
  unifiedEditCoordinator(harness.pi);
  assert.equal(registered.length, 0, "tool inspection must wait until runtime initialization");
  harness.start();
  const tool = registered[0];
  assert.equal(tool?.name, "edit");

  const cwd = await mkdtemp(join(tmpdir(), "pi-unified-edit-"));
  try {
    await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");
    const result = await tool?.execute(
      "test-call",
      { text: "[sample.txt]\n@REPLACE\n-beta\n+gamma" },
      new AbortController().signal,
      undefined,
      { cwd },
    );
    assert.equal(await readFile(join(cwd, "sample.txt"), "utf8"), "alpha\ngamma\n");
    assert.match(result?.content[0]?.text ?? "", /Edited sample\.txt/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unified edit fallback does not override a loaded hash-anchored editor", () => {
  let registrations = 0;
  const harness = coordinatorHarness(() => {
    registrations += 1;
  }, "npm:pi-better-edit@^1.4.0");
  unifiedEditCoordinator(harness.pi);
  harness.start();
  assert.equal(registrations, 0);
});
