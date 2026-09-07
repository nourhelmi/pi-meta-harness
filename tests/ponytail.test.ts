import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ponytail, { PONYTAIL_COMPATIBILITY, registerPonytail } from "../extensions/ponytail.ts";

type PromptHook = (event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>;

function fakePi() {
  const hooks: PromptHook[] = [];
  const messages: unknown[][] = [];
  const commands: string[] = [];
  const entries: unknown[][] = [];
  const api = {
    on: (name: string, hook: PromptHook) => {
      assert.equal(name, "before_agent_start");
      hooks.push(hook);
    },
    registerCommand: (name: string) => commands.push(name),
    appendEntry: (...args: unknown[]) => entries.push(args),
    sendUserMessage: (...args: unknown[]) => { messages.push(args); },
  } as unknown as ExtensionAPI;
  return { api, hooks, messages, commands, entries };
}

async function prompt(hooks: PromptHook[], systemPrompt: string) {
  for (const hook of hooks) {
    const result = await hook({ systemPrompt });
    if (result) systemPrompt = result.systemPrompt;
  }
  return systemPrompt;
}

test("Ponytail preserves chained prompts without accumulating history or forcing a mode", async () => {
  for (const active of [true, false]) {
    const pi = fakePi();
    await registerPonytail(pi.api, (api) => {
      api.on("before_agent_start", async (event) => active
        ? { systemPrompt: `${event.systemPrompt}\nupstream active instructions` }
        : undefined);
    });
    const base = "base system + advisor/worker obligations";
    const expected = `${base}${active ? "\nupstream active instructions" : ""}\n\n${PONYTAIL_COMPATIBILITY}`;
    assert.equal(await prompt(pi.hooks, base), expected);
    assert.equal(await prompt(pi.hooks, base), expected, "next agent loop starts from its base, not prior output");
    assert.equal(await prompt(pi.hooks, "after compaction"), expected.replace(base, "after compaction"));
    assert.deepEqual(pi.messages, []);
    assert.deepEqual(pi.entries, [], "the adapter must not change upstream session modes");
  }
});

test("Ponytail aliases explicitly expand skills and retain queued delivery", async () => {
  const pi = fakePi();
  const originalSend = pi.api.sendUserMessage;
  await registerPonytail(pi.api, (api) => {
    for (const name of ["review", "audit", "debt", "gain", "help"]) {
      api.sendUserMessage(`/skill:ponytail-${name}`);
      api.sendUserMessage(`/skill:ponytail-${name}`, { deliverAs: "followUp" });
    }
    api.appendEntry("ponytail-mode", { mode: "off" });
  });
  assert.equal(pi.api.sendUserMessage, originalSend, "no mutation of another extension's API");
  for (let index = 0; index < pi.messages.length; index += 2) {
    assert.deepEqual(pi.messages[index][1], { expandPromptTemplates: true });
    assert.deepEqual(pi.messages[index + 1][1], { deliverAs: "followUp", expandPromptTemplates: true });
  }
  assert.deepEqual(pi.entries, [["ponytail-mode", { mode: "off" }]]);
});

test("Ponytail loads only the configured agent directory's official adapter", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "ponytail-loader-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await assert.rejects(ponytail(fakePi().api), /Cannot find module/, "missing installation must not silently claim activation");
  const root = join(agentDir, "git", "github.com", "DietrichGebert", "ponytail");
  await mkdir(join(root, "pi-extension"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "pi-extension", "index.js"), 'export default pi => pi.registerCommand("ponytail", { handler() {} });\n');
  const pi = fakePi();
  await ponytail(pi.api);
  assert.deepEqual(pi.commands, ["ponytail"]);
  assert.equal(pi.hooks.length, 1);
});

test("Ponytail package and all six canonical skills share one reviewed pin without duplicate discovery", async () => {
  const config = async (name: string) => JSON.parse(await readFile(new URL(`../config/${name}`, import.meta.url), "utf8"));
  const overlay = await config("settings.overlay.json");
  const extensions = await config("third-party-extensions.lock.json");
  const sources = await config("skill-sources.json");
  const lock = await config("third-party-skills.lock.json");
  const entry = extensions.extensions.find((entry: { name: string }) => entry.name === "ponytail");
  const group = sources.groups.find((entry: { source: string }) => entry.source === "DietrichGebert/ponytail");
  assert.equal(entry.commit, "356918eba965ee1eac64bd3a7f0dd02108350de5");
  assert.equal(entry.tree, "3bb4226d87085db53fbf6a0013f6b5de07fcf815");
  assert.equal(entry.license, "MIT");
  assert.deepEqual(overlay.packages.filter((value: string | { source: string }) =>
    (typeof value === "string" ? value : value.source).includes("DietrichGebert/ponytail")), [
    { source: entry.installSource, extensions: [], skills: [] },
  ]);
  assert.deepEqual(group.skills, ["ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help", "ponytail-review"]);
  assert.equal(group.commit, entry.commit);
  assert.equal(group.tree, entry.tree);
  for (const skill of group.skills) {
    assert.equal(lock.skills[skill].commit, entry.commit);
    assert.equal(lock.skills[skill].tree, entry.tree);
    assert.equal(lock.skills[skill].sourceUrl, group.sourceUrl);
    assert.match(lock.skills[skill].sha256, /^[a-f0-9]{64}$/);
  }
});

test("Ponytail defaults retain native access, owner agency, and binding verification obligations", async () => {
  const doctrine = await readFile(new URL("../skills/advisor/doctrine.md", import.meta.url), "utf8");
  const worker = await readFile(new URL("../skills/advisor-worker/references/WORKER_CONTRACT.md", import.meta.url), "utf8");
  for (const text of [doctrine, worker]) {
    const policy = text.split("## Ponytail by default\n")[1]?.split(/\n## /)[0];
    assert(policy, "each host contract needs its own default policy");
    assert.match(policy, /~\/\.agents\/skills\/ponytail\/SKILL\.md/);
    assert.match(policy, /once/);
    assert.match(policy, /full by\s+default/);
    assert.match(policy, /mode\/off choice/);
    assert.match(policy, /compaction/);
    assert.match(policy, /take[s]? precedence over\s+conflicting Ponytail advice/);
    assert.match(policy, /ONE.check[^;:]*not a test\s+ceiling/);
    assert.match(policy, /required (?:independent checking|independent verification)/);
    assert.match(policy, /(?:single-maker fast path|one empowered maker)/);
    for (const obligation of ["accepted", "safety", "security", "accessibility", "evidence"]) assert(policy.includes(obligation));
  }
  assert.match(worker, /not make the repair-capable checker role globally read-only/);
  assert.match(worker, /shared root cause does not authorize edits outside your scope/);
  for (const role of ["scout", "planner", "builder", "foreman", "checker", "reducer", "browser-verifier"]) {
    const skill = await readFile(new URL(`../skills/advisor-worker/roles/${role}/SKILL.md`, import.meta.url), "utf8");
    assert.match(skill, /WORKER_CONTRACT\.md/, role);
  }
  assert.match(PONYTAIL_COMPATIBILITY, /run every required check/);
  assert.match(PONYTAIL_COMPATIBILITY, /not permission to ship incomplete requirements/);
  assert.match(PONYTAIL_COMPATIBILITY, /does not truncate required reports/);
  assert.match(PONYTAIL_COMPATIBILITY, /never replaces, correctness\/security review or independent\s+verification/);
  assert.match(PONYTAIL_COMPATIBILITY, /Honor explicit mode\/off/);
});
