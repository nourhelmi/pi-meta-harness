import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  intelligenceGuideErrors,
  REQUIRED_ROLES,
  roleConfigErrors,
} from "../scripts/intelligence-profile.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "intelligence-profile.mjs");
const HARNESS = join(ROOT, "scripts", "meta-harness.mjs");
const NAMES = ["codex-max", "codex-lean", "anthropic-heavy", "balanced", "grok-cycle"];

test("fixed role configuration is standalone and model-free", async () => {
  const config = JSON.parse(await readFile(join(ROOT, "config", "bg-agent-profiles.json"), "utf8"));
  assert.deepEqual(roleConfigErrors(config), []);
  assert.deepEqual(Object.keys(config).sort(), ["defaultAgent", "profiles"]);
  assert.deepEqual(Object.keys(config.profiles), REQUIRED_ROLES);
  for (const profile of Object.values(config.profiles)) {
    assert.equal(typeof profile.skill, "string");
    assert(!profile.excludeTools.includes("edit"));
    assert(!profile.excludeTools.includes("write"));
    assert.equal("model" in profile, false);
    assert.equal("allowedModels" in profile, false);
    assert.equal("allowedThinkingByModel" in profile, false);
  }
});

test("named advisor guides are structurally valid and cover every role", async () => {
  for (const name of NAMES) {
    const guide = JSON.parse(
      await readFile(join(ROOT, "config", "intelligence-profiles", `${name}.json`), "utf8"),
    );
    assert.equal(guide.name, name);
    assert.deepEqual(intelligenceGuideErrors(guide, REQUIRED_ROLES), [], name);
    assert.deepEqual(Object.keys(guide).sort(), ["models", "name", "recommendations"]);
    assert.deepEqual(Object.keys(guide.recommendations), REQUIRED_ROLES);
    for (const choices of Object.values(guide.recommendations)) {
      assert(choices.length > 0);
      for (const choice of choices) {
        assert.equal(typeof choice.fit, "string");
        assert(guide.models[choice.model]);
      }
    }
  }
});

test("recommendation typos remain validation errors", async () => {
  const guide = JSON.parse(
    await readFile(join(ROOT, "config", "intelligence-profiles", "codex-max.json"), "utf8"),
  );
  guide.recommendations.planner[0].model = "missing/model";
  guide.recommendations.builder[0].thinking = "ultra";
  guide.recommendations.chekcer = guide.recommendations.checker;
  const errors = intelligenceGuideErrors(guide, REQUIRED_ROLES).join("\n");
  assert.match(errors, /planner references unknown model: missing\/model/);
  assert.match(errors, /builder recommends invalid reasoning ultra/);
  assert.match(errors, /Recommendations reference unknown role: chekcer/);
});

test("switching changes only the live advisor guide", async () => {
  const target = await mkdtemp(join(tmpdir(), "pi-intelligence-"));
  try {
    const install = spawnSync(process.execPath, [HARNESS, "install", "--target", target], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(install.status, 0, install.stderr);
    const rolesBefore = await readFile(join(target, "bg-agent-profiles.json"));
    const guideBefore = await readFile(join(target, "advisor-intelligence.json"));

    const switched = spawnSync(process.execPath, [SCRIPT, "codex-lean", "--target", target], {
      encoding: "utf8",
    });
    assert.equal(switched.status, 0, switched.stderr);
    assert.match(switched.stdout, /Preferred builder:/);
    assert.deepEqual(await readFile(join(target, "bg-agent-profiles.json")), rolesBefore);
    assert.notDeepEqual(await readFile(join(target, "advisor-intelligence.json")), guideBefore);
    assert.deepEqual(
      await readFile(join(target, "advisor-intelligence.json")),
      await readFile(join(ROOT, "config", "intelligence-profiles", "codex-lean.json")),
    );
    assert.equal(await readFile(join(target, "intelligence-profiles", "ACTIVE"), "utf8"), "codex-lean\n");
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
