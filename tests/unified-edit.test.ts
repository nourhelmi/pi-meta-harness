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

function coordinatorPi(
  registerTool: (candidate: RegisteredTool) => void,
  existingSource = "builtin",
): ExtensionAPI {
  return {
    getAllTools() {
      return [{ name: "edit", sourceInfo: { source: existingSource } }];
    },
    registerTool,
  } as unknown as ExtensionAPI;
}

test("unified edit fallback applies a row replacement when no external editor loaded", async () => {
  let tool: RegisteredTool | undefined;
  unifiedEditCoordinator(coordinatorPi((candidate) => {
    tool = candidate;
  }));
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
  unifiedEditCoordinator(coordinatorPi(() => {
    registrations += 1;
  }, "npm:pi-better-edit@1.4.0"));
  assert.equal(registrations, 0);
});
