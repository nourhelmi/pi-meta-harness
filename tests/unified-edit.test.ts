import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import unifiedEditExtension from "../extensions/unified-edit.ts";

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

test("unified edit overrides edit and applies a row replacement", async () => {
  let tool: RegisteredTool | undefined;
  const pi = {
    registerTool(candidate: RegisteredTool) {
      tool = candidate;
    },
  } as unknown as ExtensionAPI;
  unifiedEditExtension(pi);
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
