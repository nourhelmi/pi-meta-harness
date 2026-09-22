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
const GPT6_SOL = "openai-codex/gpt-6-sol";
const GPT6_LUNA = "openai-codex/gpt-6-luna";
const OPUS55 = "claude-bridge/claude-opus-5-5";
const LOCKED_EXECUTORS = {
  "codex-max": [GPT6_SOL, "high"],
  "codex-lean": [GPT6_SOL, "xhigh"],
  "anthropic-heavy": [OPUS55, "medium"],
  balanced: [GPT6_SOL, "high"],
  "grok-cycle": [OPUS55, "medium"],
};

test("fixed role configuration is standalone and model-free", async () => {
  const config = JSON.parse(await readFile(join(ROOT, "config", "bg-agent-profiles.json"), "utf8"));
  assert.deepEqual(roleConfigErrors(config), []);
  assert.deepEqual(Object.keys(config).sort(), ["defaultAgent", "profiles"]);
  assert.deepEqual(REQUIRED_ROLES, ["builder", "advisor", "checker"]);
  assert.deepEqual(Object.keys(config.profiles), REQUIRED_ROLES);
  for (const role of ["scout", "planner", "reducer", "browser-verifier"]) {
    assert.equal(config.profiles[role], undefined);
    await assert.rejects(readFile(join(ROOT, "skills", "advisor-worker", "roles", role, "SKILL.md")), { code: "ENOENT" });
  }
  assert.equal(config.profiles.advisor.harness, "pi");
  assert(config.profiles.advisor.cliArgs.includes("--advisor-worker-allow-subagents"));
  assert.equal("excludeTools" in config.profiles.advisor, false);
  assert.equal(config.profiles.advisor.cliArgs.includes("--exclude-tools"), false);
  assert.equal(config.profiles.foreman, undefined);
  for (const [role, profile] of Object.entries(config.profiles)) {
    assert.equal(typeof profile.skill, "string");
    assert.equal(typeof profile.skillPath, "string");
    assert.equal("tools" in profile, false);
    assert.equal("excludeTools" in profile, false);
    assert.equal("turnCapFlag" in profile, false);
    assert.equal("model" in profile, false);
    assert.equal("allowedModels" in profile, false);
    assert.equal("allowedThinkingByModel" in profile, false);
    assert.equal("allowSubagents" in profile, false);
    assert.equal(profile.harness === "pi", role === "advisor");
    if (profile.agent === "pi") assert.equal(profile.resultDiscovery, "advisor-worker");
  }
});

test("fixed role validation rejects deterministic tool and turn enforcement", async () => {
  const config = JSON.parse(await readFile(join(ROOT, "config", "bg-agent-profiles.json"), "utf8"));
  config.profiles.builder.tools = ["read"];
  config.profiles.checker.excludeTools = ["edit"];
  config.profiles.builder.turnCapFlag = "--max-turns";
  config.profiles.advisor.harness = "other";
  const errors = roleConfigErrors(config).join("\n");
  assert.match(errors, /builder contains deterministic enforcement field: tools/);
  assert.match(errors, /checker contains deterministic enforcement field: excludeTools/);
  assert.match(errors, /builder contains deterministic enforcement field: turnCapFlag/);
  assert.match(errors, /invalid harness constraint: advisor/);
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

test("codex-max retains maker/reviewer identities without a browser role", async () => {
  const guide = JSON.parse(
    await readFile(join(ROOT, "config", "intelligence-profiles", "codex-max.json"), "utf8"),
  );
  const sol = GPT6_SOL;
  const luna = GPT6_LUNA;
  const identities = (role) => guide.recommendations[role].map(({ model, thinking }) => [model, thinking]);
  assert.equal(guide.models[sol].defaultThinking, "xhigh");
  assert.deepEqual(identities("advisor"), [[sol, "xhigh"]]);
  assert.deepEqual(identities("builder"), [
    [sol, "xhigh"],
    [sol, "high"],
    ["cursor/grok-4.6", "high"],
  ]);
  assert.deepEqual(identities("checker"), [[sol, "xhigh"], [sol, "high"]]);
  assert.equal(guide.recommendations["browser-verifier"], undefined);
  assert(!Object.keys(guide.models).some((model) => /^(anthropic|claude-bridge)\//.test(model)));
  assert.match(guide.models[sol].character, /advisor session, child advisor, primary decision-bearing builder, and fresh-context checker model at xhigh/);
  assert.match(guide.models[sol].character, /every kind of UX work with frontend-design loaded/);
  assert.equal(guide.models[luna].defaultThinking, "max");
  assert.match(guide.models[luna].character, /assigned builder or checker/);
});

test("codex-lean is Codex-only and assigns the requested effort ladder", async () => {
  const guide = JSON.parse(
    await readFile(join(ROOT, "config", "intelligence-profiles", "codex-lean.json"), "utf8"),
  );
  const sol = GPT6_SOL;
  const luna = GPT6_LUNA;
  const identities = (role) => guide.recommendations[role].map(({ model, thinking }) => [model, thinking]);

  assert(Object.keys(guide.models).every((model) => model.startsWith("openai-codex/")));
  assert.equal(guide.models[sol].defaultThinking, "xhigh");
  assert.deepEqual(identities("builder"), [[sol, "xhigh"], [sol, "max"]]);
  assert.deepEqual(identities("advisor"), [[sol, "high"]]);
  assert.deepEqual(identities("checker"), [[sol, "xhigh"]]);
  assert.equal(guide.recommendations["browser-verifier"], undefined);
  assert.match(guide.models[sol].character, /GPT-6 Sol runs at high/);
  assert.match(guide.models[sol].character, /Use max for materially ambiguous or wide-breadth implementation/);
  assert.match(guide.models[sol].character, /regular workhorse at xhigh/);
  assert.equal(guide.models[luna].defaultThinking, "max");
  assert.match(guide.models[luna].character, /not a separate role or required stage/);
});

test("anthropic-heavy routes Opus 5.5 across advice, implementation, and review", async () => {
  const guide = JSON.parse(
    await readFile(join(ROOT, "config", "intelligence-profiles", "anthropic-heavy.json"), "utf8"),
  );
  const opus = OPUS55;
  const identities = (role) => guide.recommendations[role].map(({ model, thinking }) => [model, thinking]);

  assert.deepEqual(Object.keys(guide.models), [opus]);
  assert.deepEqual(identities("advisor"), [[opus, "high"]]);
  assert.deepEqual(identities("builder"), [[opus, "medium"], [opus, "high"]]);
  assert.deepEqual(identities("checker"), [[opus, "medium"]]);
});

test("balanced routes Opus 5.5 advice and UX with GPT-6 Sol implementation/review", async () => {
  const guide = JSON.parse(
    await readFile(join(ROOT, "config", "intelligence-profiles", "balanced.json"), "utf8"),
  );
  const opus = OPUS55;
  const sol = GPT6_SOL;
  const identities = (role) => guide.recommendations[role].map(({ model, thinking }) => [model, thinking]);

  assert.deepEqual(Object.keys(guide.models).sort(), [opus, sol].sort());
  assert.deepEqual(identities("advisor"), [[opus, "high"]]);
  assert.deepEqual(identities("builder"), [[sol, "high"], [opus, "high"]]);
  assert.deepEqual(identities("checker"), [[sol, "xhigh"]]);
});

test("shipped guides use refreshed model IDs and bound Opus 5.5 effort", async () => {
  const expectedModels = {
    "codex-max": [GPT6_SOL, GPT6_LUNA, "cursor/grok-4.6"],
    "codex-lean": [GPT6_SOL, GPT6_LUNA],
    "anthropic-heavy": [OPUS55],
    balanced: [OPUS55, GPT6_SOL],
    "grok-cycle": [OPUS55, "cursor/grok-4.6"],
  };
  for (const name of NAMES) {
    const guide = JSON.parse(
      await readFile(join(ROOT, "config", "intelligence-profiles", `${name}.json`), "utf8"),
    );
    assert.deepEqual(Object.keys(guide.models).sort(), expectedModels[name].sort(), name);
    for (const [model, details] of Object.entries(guide.models)) {
      if (model === OPUS55) assert(["medium", "high"].includes(details.defaultThinking), name);
    }
    for (const choice of Object.values(guide.recommendations).flat()) {
      if (choice.model === OPUS55) assert(["medium", "high"].includes(choice.thinking), name);
    }
  }
});

test("every guide provides a native-routable choice for every semantic role", async () => {
  const nativeProviders = new Set(["openai-codex", "openai", "claude-bridge", "anthropic"]);
  for (const name of NAMES) {
    const guide = JSON.parse(
      await readFile(join(ROOT, "config", "intelligence-profiles", `${name}.json`), "utf8"),
    );
    for (const role of REQUIRED_ROLES) {
      assert(
        guide.recommendations[role].some((choice) => nativeProviders.has(choice.model.split("/")[0])),
        `${name}/${role} has no Codex-or-Claude native route`,
      );
    }
  }
});

test("every guide provides a locked-packet executor", async () => {
  for (const name of NAMES) {
    const guide = JSON.parse(
      await readFile(join(ROOT, "config", "intelligence-profiles", `${name}.json`), "utf8"),
    );
    const [model, thinking] = LOCKED_EXECUTORS[name];
    const choice = guide.recommendations.builder.find(
      (candidate) => candidate.model === model && candidate.thinking === thinking,
    );
    assert(choice, `${name} has no locked executor recommendation`);
    assert.match(choice.fit, /locked execution packet/i, name);
    assert.match(choice.fit, /stop-on-material-ambiguity/i, name);
    assert.match(guide.models[model].character, /escalate(?:s)? material (?:ambiguity|decisions) outside/i, name);
    assert.match(guide.models[model].character, /deterministic anchors/i, name);
  }
});

test("recommendation typos remain validation errors", async () => {
  const guide = JSON.parse(
    await readFile(join(ROOT, "config", "intelligence-profiles", "codex-max.json"), "utf8"),
  );
  guide.recommendations.advisor[0].model = "missing/model";
  guide.recommendations.builder[0].thinking = "ultra";
  guide.recommendations.chekcer = guide.recommendations.checker;
  const errors = intelligenceGuideErrors(guide, REQUIRED_ROLES).join("\n");
  assert.match(errors, /advisor references unknown model: missing\/model/);
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
