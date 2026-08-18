import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { intelligenceMapErrors } from "../scripts/intelligence-profile.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "intelligence-profile.mjs");
const HARNESS = join(ROOT, "scripts", "meta-harness.mjs");

test("named profiles are valid and cursor-only grok", async () => {
  for (const name of ["codex-max", "codex-lean", "anthropic-heavy", "grok-cycle"]) {
    const config = JSON.parse(
      await readFile(join(ROOT, "config", "intelligence-profiles", `${name}.json`), "utf8"),
    );
    assert.deepEqual(intelligenceMapErrors(config), [], name);
    for (const modelId of Object.keys(config.models)) {
      if (modelId.startsWith("cursor/")) assert.equal(modelId, "cursor/grok-4.6");
    }
  }
});

test("cursor models other than grok-4.6 are rejected", async () => {
  const config = JSON.parse(
    await readFile(join(ROOT, "config", "intelligence-profiles", "codex-max.json"), "utf8"),
  );
  config.models["cursor/gpt-5.6-terra"] = {
    character: "forbidden",
    thinking: ["high"],
    defaultThinking: "high",
  };
  assert.match(
    intelligenceMapErrors(config).join("\n"),
    /Cursor model is not allowed: cursor\/gpt-5.6-terra/,
  );
});

test("switcher copies the named profile over the live map", async () => {
  const target = await mkdtemp(join(tmpdir(), "pi-intelligence-"));
  const install = spawnSync(process.execPath, [HARNESS, "install", "--target", target], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr);
  const switched = spawnSync(process.execPath, [SCRIPT, "codex-lean", "--target", target], {
    encoding: "utf8",
  });
  assert.equal(switched.status, 0, switched.stderr);
  const live = JSON.parse(await readFile(join(target, "bg-agent-profiles.json"), "utf8"));
  const named = JSON.parse(
    await readFile(join(ROOT, "config", "intelligence-profiles", "codex-lean.json"), "utf8"),
  );
  assert.deepEqual(live, named);
  await rm(target, { recursive: true, force: true });
});
