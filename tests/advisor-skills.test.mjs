import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

// Instruction-surface regressions only: size, absence of retired machinery, and the few
// invariants the runtime relies on. They do not measure live model behavior.
const text = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const section = (source, heading, nextHeading) => {
  const start = source.indexOf(heading);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const end = nextHeading ? source.indexOf(nextHeading, start + heading.length) : -1;
  return source.slice(start, end === -1 ? source.length : end);
};

const REFERENCES = ["graphs", "model-routing", "team", "transport-and-settlement"];
const PI_SKILLS = [
  "skills/advisor/SKILL.md",
  "skills/advisor/doctrine.md",
  ...REFERENCES.map((name) => `skills/advisor/references/${name}.md`),
  "skills/advisor-worker/references/WORKER_CONTRACT.md",
  "skills/advisor-worker/roles/builder/SKILL.md",
  "skills/advisor-worker/roles/checker/SKILL.md",
  "skills/advisor-worker/roles/advisor/SKILL.md",
  "skills/advisor-worker/roles/foreman/SKILL.md",
  "skills/advisor-stock-entry/SKILL.md",
  "skills/cos/SKILL.md",
  "skills/advisor-team/SKILL.md",
  "skills/advisor-pi/SKILL.md",
  "skills/advisor-native/SKILL.md",
];
const NATIVE_SKILLS = [
  "native-skills/advisor/SKILL.md",
  "native-skills/advisor/references/worker-contract.md",
  "native-skills/advisor-role-builder/SKILL.md",
  "native-skills/advisor-role-checker/SKILL.md",
  "native-skills/advisor-role-advisor/SKILL.md",
  "native-skills/advisor-role-foreman/SKILL.md",
  "native-skills/cos/SKILL.md",
  "native-skills/advisor-team/SKILL.md",
];

const core = await text("skills/advisor/doctrine.md");
const contract = await text("skills/advisor-worker/references/WORKER_CONTRACT.md");
const builder = await text("skills/advisor-worker/roles/builder/SKILL.md");
const checker = await text("skills/advisor-worker/roles/checker/SKILL.md");
const child = await text("skills/advisor-worker/roles/advisor/SKILL.md");
const graphs = await text("skills/advisor/references/graphs.md");
const routing = await text("skills/advisor/references/model-routing.md");
const runtimeDoc = await text("docs/advisor-runtime.md");
const doctrine = [core, ...(await Promise.all(REFERENCES.map((name) => text(`skills/advisor/references/${name}.md`))))].join("\n\n");

test("the injected stack stays small and the references index matches the directory", async () => {
  assert.deepEqual(core.match(/^# [^#].*$/gm) ?? [], ["# Advisor"]);
  assert.doesNotMatch(core, /^---\n/, "the injected core carries no skill frontmatter");
  assert.ok(core.length < 9000, `doctrine core is ${core.length} bytes; keep it under 9k`);
  const entry = await text("skills/advisor/SKILL.md");
  assert.ok(entry.length < 3000, `entry skill is ${entry.length} bytes; it must stay a bootstrap`);
  let total = 0;
  for (const path of PI_SKILLS) total += (await text(path)).length;
  assert.ok(total < 40000, `advisor + worker skills total ${total} bytes; keep the whole stack under 40k`);
  const listed = [...section(core, "## References").matchAll(/`references\/([a-z-]+)\.md`/g)].map((m) => m[1]).sort();
  const files = (await readdir(new URL("../skills/advisor/references/", import.meta.url)))
    .filter((name) => name.endsWith(".md")).map((name) => name.replace(/\.md$/, "")).sort();
  assert.deepEqual(listed, files);
  assert.deepEqual(files, [...REFERENCES].sort());
  assert.match(section(core, "## References"), /never at session start/);
});

test("no risk tiers, claim schemas or retired stages survive on any instruction surface", async () => {
  const banned = /risk[ -]tiers?|riskTier|FAIL bar|falsifiable|one-to-one|Proposed criteria|Claims, Evidence|\b(scout|planner|reducer|browser-verifier)\b|Standard\/High|Medium-or-higher|checker-of-checker|non-author/i;
  for (const path of [...PI_SKILLS, ...NATIVE_SKILLS]) assert.doesNotMatch(await text(path), banned, path);
  const workerSource = await text("extensions/advisor-worker.ts");
  const bootstrap = workerSource.slice(workerSource.indexOf("function workerContract"), workerSource.indexOf("function childAdvisorScope"));
  assert.doesNotMatch(bootstrap, /Claims, Evidence, Files|exactly one of four/);
  assert.match(bootstrap, /a Status line first/);
  assert.match(bootstrap, /advisory ceiling, never a reason to stop while your own helpers are live/);
  assert.doesNotMatch(runtimeDoc, /## .*Risk tiers|\| High \|/);
  assert.doesNotMatch(await text("README.md"), /risk tier/i);
  for (const path of ["scripts/claude-advisor-trace.mjs", "scripts/codex-advisor-trace.mjs"]) {
    assert.doesNotMatch(await text(path), /six top-level headings/, path);
  }
  const profiles = JSON.parse(await text("config/bg-agent-profiles.json"));
  assert.deepEqual(Object.keys(profiles.profiles), ["builder", "advisor", "checker"]);
  assert.match(profiles.profiles.checker.description, /repair/);
});

test("the doctrine keeps the invariants the runtime and the user rely on", () => {
  const routes = section(core, "## Route", "## Rules");
  assert.match(routes, /1\. \*\*Direct\.\*\*/);
  assert.match(routes, /2\. \*\*One maker\.\*\*/);
  assert.match(routes, /3\. \*\*Several makers\.\*\*/);
  assert.match(routes, /no scouting, planning or reduction stage/);
  assert.match(routes, /While a maker runs, you wait/);
  assert.match(routes, /shadow-implement/);
  assert.doesNotMatch(routes, /\d+\s*(?:minutes?|hours?)/i);

  const rules = section(core, "## Rules", "## Packets");
  assert.match(rules, /One writer per surface at a time, including you/);
  assert.match(rules, /distinct worktrees/);
  assert.match(rules, /advisor-worktree\.mjs add <path> -b <branch>/);
  assert.match(rules, /copies the untracked `\.env\*` files/);
  assert.match(rules, /Maker ≠ checker/);
  assert.match(rules, /Git is the ledger/);
  assert.match(rules, /commit on their branch or worktree as they go/);
  assert.match(rules, /No hash manifests, alternate indexes or evidence copies/);
  assert.match(rules, /Packets authorize commits by default/);
  assert.match(rules, /Every helper is visible\*\* through `bg_agent`/);
  assert.match(rules, /`codex exec`, `claude --print` or `agent:`/);
  assert.match(rules, /Respect explicit user limits/);
  assert.match(rules, /\*\*Ponytail by default\.\*\*/);

  const packets = section(core, "## Packets", "## Verify and review");
  assert.match(packets, /ten to twenty lines/);
  assert.match(packets, /\*\*done when\*\* line/);
  assert.match(packets, /Never freeze tool versions, command order, retry counts/);
  assert.match(packets, /Fix a formatter by running it, not by making it a criterion/);
  assert.match(packets, /Child advisors launch with `role: "advisor"`/);
  assert.match(packets, /account for descendants before\s+delivering/);

  const review = section(core, "## Verify and review", "## Blocked versus obstacle");
  assert.match(review, /Depth follows consequence/);
  assert.match(review, /A worker PASS is a\s+claim, not proof/);
  assert.match(review, /Checkers repair what they find inside the reviewed surface/);
  assert.doesNotMatch(review, /checker-of-checker|non-author|named uncertainty|fixed stage/);
  assert.match(review, /Do not invent review the repository does not require; do not skip\s+review it does/);

  const blocked = section(core, "## Blocked versus obstacle", "## Transport and settlement");
  assert.match(blocked, /Blocked means a missing product decision, a permission, a credential, or an external\s+action only the user can perform/);
  assert.match(blocked, /`Deviations`/);
  assert.match(blocked, /A safety boundary the packet names is neither/);

  const transport = section(core, "## Transport and settlement", "## State");
  assert.match(transport, /never sleep-poll/);
  assert.match(transport, /A launch receipt proves admission, not delivery/);
  assert.match(transport, /never fall back to an\s+invisible agent/);
  assert.match(transport, /own no routines/);

  const state = section(core, "## State", "## Session start");
  assert.match(state, /hot section \(everything above `## Log`/);
  assert.match(state, /Scope ledger/);
  assert.match(state, /once per settlement or material decision,\s+not per step/);
  assert.match(state, /`<root>\/traces\/<runId>\.jsonl`/);
  assert.match(state, /never writes the parent's file/);

  const start = section(core, "## Session start", "## References");
  assert.match(start, /`advisor_session_init` first/);
  assert.match(start, /`bg_list`\s+once/);
  assert.match(start, /five-line brief/);
  assert.match(start, /Wait only when no task was given/);
});

test("the worker contract and role skills carry commit, handoff, obstacle and journey rules", () => {
  assert.match(contract, /Commit on your branch or worktree as you go/);
  assert.match(contract, /Never push, open a PR, deploy or mutate an external system\s+without explicit authority/);
  assert.match(contract, /a `Status` line first \(`DONE`,\s+`BLOCKED: reason`, `FAILED`, `IN PROGRESS`\)/);
  assert.match(contract, /`Deviations`/);
  assert.match(contract, /`Adjacent findings`/);
  assert.match(contract, /A check you\s+did not run is not a pass/);
  assert.match(contract, /Blocked means a missing product decision, a permission, a credential, or an external\s+action only the user can perform/);
  assert.match(contract, /Never invent a\s+missing product decision or a product fallback/);
  assert.match(contract, /A shared root cause does not authorize\s+edits outside your scope/);
  for (const key of ["graph", "node", "wave", "repair", "upstream", "downstream"]) assert.match(contract, new RegExp("`" + key + "`"));
  assert.match(contract, /`GRAPH:` block/);
  assert.match(contract, /blank line/);
  const journeys = section(contract, "## Verify the affected journeys", "## Ponytail by default");
  assert.match(journeys, /backend auth, API wiring/);
  assert.match(journeys, /real browser\s+against the integrated changed application/);
  assert.match(journeys, /`agent-browser`/);
  assert.match(journeys, /never a ritual/);
  assert.match(journeys, /including dirty content/);
  assert.match(journeys, /A checker that edits is an\s+author/);

  for (const [name, skill] of Object.entries({ builder, checker, child })) assert.match(skill, /WORKER_CONTRACT\.md/, name);
  assert.match(builder, /at most one read-only review helper/);
  assert.match(builder, /it edits nothing and\s+delegates nothing/);
  assert.match(builder, /An honest `FAILED` or partial result is a good result/);
  assert.match(builder, /locked execution packet is an input, not a design\s+invitation/);
  assert.match(checker, /Repair every finding you can inside the reviewed surface/);
  assert.match(checker, /Return instead of\s+repairing only what needs a product or architecture decision/);
  assert.match(checker, /Never weaken a\s+check or the done-when line/);
  assert.match(checker, /a changed oracle is behavior, even in\s+`tests\/`/);
  assert.match(checker, /your own repairs are maker work/);
  assert.match(checker, /review\s+the delta and the reasoning it touches,\s+not the whole change again/);
  assert.match(child, /same installed advisor doctrine/);
  assert.match(child, /never invoke `\/advisor`, `advisor_session_init` or `advisor_launch`/);
  assert.match(child, /never write the parent's workstream file/);
  assert.match(child, /Account for every descendant before delivering/);
});

test("graph and transport references stay plans and mechanics, not permits", async () => {
  assert.match(graphs, /not a permit to launch, repair or finish an agent/);
  assert.match(graphs, /Keep one writer per checkout, including yourself/);
  assert.match(graphs, /distinct\s+registered Git worktrees/);
  assert.match(graphs, /do not stop because a graph counter ran out/);
  assert.match(graphs, /A missing, changed or stale reference is a\s+limitation to report, not a launch veto/);
  assert.match(graphs, /legacy `GRAPH:` block[^.]*correlation metadata/);
  const transport = await text("skills/advisor/references/transport-and-settlement.md");
  assert.match(transport, /`advisor` is always Pi-hosted/);
  assert.match(transport, /It never launches an LLM/);
  assert.match(transport, /Never sleep-and-check through `bg_run`/);
  assert.match(transport, /Never\s+type into permission dialogs/);
  assert.match(transport, /Never clear locks,\s+adopt a pane or resend an ambiguous effect/);
  assert.match(transport, /never read them with a tool/);
});

test("native mirrors carry the same rules for Codex and Claude hosts", async () => {
  const advisor = await text("native-skills/advisor/SKILL.md");
  const nativeContract = await text("native-skills/advisor/references/worker-contract.md");
  const nativeChecker = await text("native-skills/advisor-role-checker/SKILL.md");
  assert.match(advisor, /A root defaults to \*\*host-native orchestration\*\*/);
  assert.match(advisor, /A child inherits its parent's chosen lane and remaining limits/);
  assert.match(advisor, /no scouting, planning or reduction stage/);
  assert.match(advisor, /While a\s+maker runs, wait for it/);
  assert.match(advisor, /Agentic PR review belongs to the\s+project's review\/CI workflow/);
  assert.match(advisor, /Do not preload every role/);
  assert.match(advisor, /not\s+automatically registered native agent types/);
  assert.match(advisor, /Do not claim managed-runtime graph tools or\s+attestations/);
  assert.match(nativeContract, /Commit on your branch as you\s+go when authorized/);
  assert.match(nativeContract, /## Verify the affected journeys/);
  assert.match(nativeContract, /A checker that edits is an author/);
  assert.match(nativeChecker, /Repair every finding you can/);
  assert.match(nativeChecker, /frozen baseline alone does not/);
  assert.match(nativeChecker, /commit only when authorized/);
  for (const path of ["skills/advisor-worker/roles/foreman/SKILL.md", "native-skills/advisor-role-foreman/SKILL.md"]) {
    const legacy = await text(path);
    assert.match(legacy, /compatibility/);
    assert.match(legacy, /advisor\/SKILL\.md/);
  }
});

test("model routing agrees with the three-role profile cards", async () => {
  const [profiles, switcher] = await Promise.all([text("docs/intelligence-profiles.md"), text("skills/switch-intelligence-profile/SKILL.md")]);
  assert.match(routing, /In `codex-max`, every UX builder uses Astra xhigh with `frontend-design`/);
  assert.match(routing, /advisor session, child advisor, and primary builder run on Astra at\s+xhigh/);
  assert.match(routing, /`codex-lean`, regular UX builders use Sol medium/);
  assert.match(routing, /ambiguous or wide-breadth\s+UX builders use Sol max/);
  assert.match(routing, /advisor and child advisor nodes use Astra xhigh/);
  assert.match(routing, /## Locked execution packets/);
  const names = ["codex-max", "codex-lean", "anthropic-heavy", "balanced", "grok-cycle"];
  for (let i = 0; i < names.length; i++) {
    const card = section(profiles, `### \`${names[i]}\``, i + 1 < names.length ? `### \`${names[i + 1]}\`` : "## 📁 Files on disk");
    assert.deepEqual([...card.matchAll(/^\| (advisor|builder|checker) \|/gm)].map((m) => m[1]), ["advisor", "builder", "checker"]);
    assert.doesNotMatch(card, /\| (scout|planner|reducer|browser-verifier) \|/);
    if (names[i].startsWith("codex-")) assert.match(card, /\| advisor \| Astra xhigh/);
  }
  assert.match(switcher, /Browser verification belongs to the author/);
  assert.match(switcher, /https:\/\/github.com\/nourhelmi\/pi-meta-harness\/blob\/main\/docs\/intelligence-profiles.md/);
  for (const name of names) {
    const guide = JSON.parse(await text(`config/intelligence-profiles/${name}.json`));
    for (const [id, model] of Object.entries(guide.models)) {
      assert.doesNotMatch(model.character, /auth, fallback,/, `${name} ${id} still lists fallback as a stop`);
      if (/stops and escalates/.test(model.character)) assert.match(model.character, /resolves environment and tooling obstacles locally/, `${name} ${id}`);
    }
  }
});

test("runtime and protocol docs describe lenient, status-driven results and the Pi reference host", async () => {
  const protocol = await text("docs/advisor-protocol.md");
  const validation = section(protocol, "## Result validation", "## Pi host binding");
  assert.match(validation, /stalls only for a missing, unreadable, or[\s\S]*blank artifact/);
  assert.match(validation, /first ten nonempty lines/);
  assert.match(validation, /node\.result\.validated\.data\.problems[\s\S]*never stall/);
  assert.match(protocol, /^## Step 6 host support$/m);
  assert.match(runtimeDoc, /Protocol step 6[\s\S]*Pi is the[\s\S]*reference implementation/);
  const blocked = section(runtimeDoc, "## Blocked signals", "## 🪜 Adaptive topology");
  assert.match(blocked, /Blocking Pi UI prompts[\s\S]*mark the Herdr pane blocked/);
  assert.match(blocked, /managed runtime, a `BLOCKED` result is a report claim, not the execution\s+completion signal/);
  assert.match(blocked, /legacy backend still maps artifact\s+`BLOCKED` to its pane signal/);
  assert.match(blocked, /Pi artifacts are discovered through the profile's\s+`resultDiscovery` session entry/);
  assert.match(runtimeDoc, /While a maker runs, the advisor waits/);
  assert.match(runtimeDoc, /Makers commit on their branch as they go/);
  assert.match(doctrine, /## Locked execution packets/);
});

test("frozen adaptive prospective case contracts remain byte-identical", async () => {
  const expected = new Map([
    ["evals/prospective/single-maker-fast-path/case.json", "bacfafc735c6f96eb4f7edf01f8dca224c27f0ff2a3ecb7a823df851431c7b8a"],
    ["evals/prospective/cohesive-medium-maker/case.json", "8bda959efc95e3c465ac4121825ceb1b75dbbf356bca43dc144745ca9bfaf9a4"],
    ["evals/prospective/risk-triggered-checker/case.json", "926a7d170f10569ea99b52114c2dafe5ac3e058fde23fefca0461e01476aae01"],
    ["evals/prospective/absolute-request-minimal-fix/case.json", "112088ce47b47973404e7f3a23a4997710ffe47c16f0f69f08a159fbdf389178"],
    ["evals/prospective/two-defects-ship-small-first/case.json", "9c0180489c51f99f14ebb804168e707503e4b3377c686d8ef65ed1e8e430f946"],
  ]);
  for (const [path, digest] of expected) {
    const contents = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(createHash("sha256").update(contents).digest("hex"), digest, path);
  }
});
