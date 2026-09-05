import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const text = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const section = (source, heading, nextHeading) => {
  const start = source.indexOf(heading);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const end = nextHeading ? source.indexOf(nextHeading, start + heading.length) : source.length;
  return source.slice(start, end === -1 ? source.length : end);
};

test("advisor topology defaults cohesive work to an empowered maker without making worker count the objective", async () => {
  const source = await text("skills/advisor/SKILL.md");
  const adaptive = section(source, "## Adaptive topology and the single-maker fast path", "## Foreman delegation");

  assert.match(adaptive, /small and cohesive-[\s\S]*medium implementation[\s\S]*default to one empowered maker/);
  assert.match(adaptive, /owns diagnosis, implementation, task-shaped deterministic tests, and[\s\S]*ordinary browser exercise/);
  assert.match(adaptive, /presumption against ceremony, not a one-agent target/);
  assert.match(adaptive, /marginal evidence value and critical-path latency/);
  assert.match(adaptive, /materially resolve uncertainty, shorten genuinely parallel work, or add useful[\s\S]*independent confidence/);
  assert.match(adaptive, /Stop expanding the route when another launch would mostly replay evidence/);
  assert.doesNotMatch(adaptive, /\d+\s*(?:minutes?|hours?)/i);
  assert.doesNotMatch(adaptive, /(?:minimum|maximum)\s+(?:agent|worker|launch)/i);
});

test("advisor sizes work after diagnosis toward the smallest blast radius without a numeric gate", async () => {
  const source = await text("skills/advisor/SKILL.md");
  const sizing = section(source, "### Bound after diagnosis", "Frontend routing is scope- and capacity-aware");

  assert.match(sizing, /smallest change that fixes the observed defect with the smallest blast[\s\S]*radius/);
  assert.match(sizing, /wording sets the goal, not the surface/);
  assert.match(sizing, /does not by itself authorize rewriting shared behavior/);
  assert.match(sizing, /shared primitive is itself the defect, a side[\s\S]*effect or data\/security boundary is at stake, or the user explicitly asked/);
  assert.match(sizing, /lock a packet for the minimal fix first, and present the expansion as[\s\S]*a separate, costed option/);
  assert.match(sizing, /do not let the question gate the minimal fix/);
  assert.match(sizing, /reported and offered, not silently absorbed/);
  assert.match(sizing, /Scope ledger/);
  assert.match(sizing, /there is no file-count threshold/);
  assert.doesNotMatch(sizing, /\d+\s*(?:files?|lines?|minutes?)/i);

  const extension = await text("extensions/advisor-session.ts");
  assert.match(extension, /## Scope ledger/);
  const state = section(source, "## Isolated state convention", "## Context budget");
  assert.match(state, /Scope ledger \(see Bound after diagnosis\)/);
});

test("advisor doctrine keeps one document root and rejects legacy universal gates across the whole skill", async () => {
  const source = await text("skills/advisor/SKILL.md");
  const topLevelHeadings = source.match(/^# [^#].*$/gm) ?? [];

  assert.deepEqual(topLevelHeadings, ["# Advisor"]);
  assert.doesNotMatch(source, /one checker per phase|final whole-diff review before PR/i);
  assert.doesNotMatch(source, /every non-destructive pre-?flight/i);
  assert.doesNotMatch(source, /(?:advisor|delivery)[\s\S]{0,80}(?:reruns?|replays?)[\s\S]{0,40}every (?:deterministic )?criteri/i);

  const graph = section(source, "## Information-value graphing", "## Worker transport recovery");
  assert.match(graph, /task-shaped deterministic criteria still needed for authoritative[\s\S]*proportionate to cost, risk, and oracle strength/);
  assert.doesNotMatch(graph, /Run (?:all )?deterministic criteria/);
});

test("verification ownership is proportional and checker economy has explicit risk triggers", async () => {
  const source = await text("skills/advisor/SKILL.md");
  const verification = section(source, "## Verification ownership", "## Checker economy");
  const checker = section(source, "## Checker economy", "## Status updates");

  assert.match(verification, /maker proves every acceptance criterion[\s\S]*exact commands and[\s\S]*task-shaped evidence/);
  assert.match(verification, /advisor[\s\S]*smallest independent authoritative rerun/);
  assert.match(verification, /need not replay every expensive criterion/);
  assert.match(verification, /checker audits the same acceptance contract and declared risk[\s\S]*independently probes/);
  assert.match(verification, /actual required merge or CI gates once/);
  assert.match(checker, /No phase, merged deliverable, or PR universally requires a checker/);
  assert.match(checker, /schema or migration,[\s\S]*auth, security, privacy, money, destructive or external effects/);
  assert.match(checker, /broad change[\s\S]*weak oracle, conflicting evidence, material residual maker risk/);
  assert.match(checker, /genuinely new finding at or above the declared risk tier remains[\s\S]*valid/);
  assert.doesNotMatch(checker, /one checker per phase|final whole-diff review/i);
  assert.match(checker, /actual required merge or CI gates once[\s\S]*Do not mandate unrelated repository-wide sweeps/);
});

test("worker roles share maker ownership, risk context, conditional delegation, and task-shaped readiness", async () => {
  const [contract, builder, foreman, checker, browser] = await Promise.all([
    text("skills/advisor-worker/references/WORKER_CONTRACT.md"),
    text("skills/advisor-worker/roles/builder/SKILL.md"),
    text("skills/advisor-worker/roles/foreman/SKILL.md"),
    text("skills/advisor-worker/roles/checker/SKILL.md"),
    text("skills/advisor-worker/roles/browser-verifier/SKILL.md"),
  ]);

  assert.match(contract, /every[\s\S]*known acceptance condition, threat-model boundary, risk invariant/);
  assert.match(contract, /Maker roles own cohesive[\s\S]*diagnosis, implementation, task-shaped tests, and ordinary browser exercise/);
  assert.match(contract, /explicit packet revision/);
  assert.match(contract, /task-shaped non-destructive[\s\S]*readiness checks/);
  assert.match(contract, /do not turn pre-flight into a universal checklist/);
  assert.match(contract, /only a missing or blank[\s\S]*stalls settlement/);
  assert.match(contract, /Keep the final response short/);
  assert.doesNotMatch(contract, /at most 12 lines/);
  assert.match(builder, /diagnose it, implement it,[\s\S]*task-shaped deterministic tests[\s\S]*ordinary browser exercise/);
  assert.match(builder, /exact command evidence/);
  assert.match(foreman, /only when delegation[\s\S]*shorten the critical path, resolve material uncertainty, or add useful[\s\S]*evidence/);
  assert.match(foreman, /depth-1 visible subagents/);
  assert.match(checker, /same acceptance[\s\S]*contract and declared risk tier/);
  assert.match(checker, /Do not blindly replay every maker command/);
  assert.match(checker, /new finding at or[\s\S]*above the declared risk tier remains valid/);
  assert.match(browser, /maker owns ordinary browser exercise/);
  assert.match(browser, /baseline behavior is ambiguous[\s\S]*independent persona, safety,[\s\S]*or release witness/);
  assert.match(browser, /task-shaped readiness checks/);
  assert.doesNotMatch(contract + browser, /every non-destructive pre-flight/i);
});

test("adaptive doctrine preserves advisor safety and composition invariants", async () => {
  const source = await text("skills/advisor/SKILL.md");
  const runtime = await text("docs/advisor-runtime.md");

  assert.match(source, /Implement High in workers only/);
  assert.match(source, /High packets always go to a visible worker/);
  assert.doesNotMatch(source, /Never implement in this session/);
  assert.match(source, /Deliberate criteria revision[\s\S]*new packet revision/);
  assert.match(source, /Every helper agent is visible[\s\S]*All delegated LLM work uses `bg_agent`/);
  assert.match(source, /request to use Codex or Claude Code directly means a[\s\S]+configured semantic `role`/);
  assert.match(source, /Never[\s\S]+`agent: "codex"` or `agent: "claude"`/);
  assert.match(source, /no-role freeform worker is Pi-hosted/);
  assert.match(source, /## Freeform workers/);
  assert.match(source, /Use a graph only when work has real independent ownership or dependency/);
  assert.match(source, /Foreman delegation is depth-1 only/);
  assert.match(source, /High-risk boundaries normally receive independent[\s\S]*review/);
  assert.match(source, /Deterministic evidence is authoritative for the[\s\S]*claim it actually proves/);
  assert.match(runtime, /presumption against ceremony, not a target worker[\s\S]*count/);
  assert.match(runtime, /Stop adding launches when another[\s\S]*would mostly replay existing evidence/);
});
test("blocked settlement doctrine documents Pi prompt and worker result signals", async () => {
  const source = await text("skills/advisor/SKILL.md");
  const runtime = await text("docs/advisor-runtime.md");
  const settlement = section(source, "## Settlement ground truth", "## Verdict hygiene");
  const blocked = section(runtime, "## Blocked signals", "## 🪜 Adaptive topology");

  assert.match(settlement, /Settlement[\s\S]*notices carry the worker's result Status line/);
  assert.match(settlement, /`paused` notice means the[\s\S]*worker ended a turn while waiting on its own sub-workers/);
  assert.match(blocked, /blocking Pi UI prompt[\s\S]*marks its Herdr pane blocked through the bridge extension/);
  assert.match(blocked, /Status starts with `BLOCKED`[\s\S]*parent `bg_agent` settles it as blocked[\s\S]*request[\s\S]*sound fires/);
  assert.match(blocked, /pi-detach discovers Pi worker result artifacts through the[\s\S]*`advisor-worker` session entry[\s\S]*`resultDiscovery`/i);
});
test("result validation doctrine is lenient and status-driven", async () => {
  const protocol = await text("docs/advisor-protocol.md");
  const validation = section(protocol, "## Result validation", "## Pi host binding");

  assert.match(validation, /stalls only for a missing, unreadable, or[\s\S]*blank artifact/);
  assert.match(validation, /first ten nonempty lines/);
  assert.match(validation, /Only that status line[\s\S]*blocked[\s\S]*in-progress/);
  assert.match(validation, /node\.result\.validated\.data\.problems[\s\S]*never stall/);
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

test("risk tiers fix the review route and checker bar while makers explore freely and deliver narrowly", async () => {
  const [source, builder, foreman, checker, contract, runtime, roles] = await Promise.all([
    text("skills/advisor/SKILL.md"),
    text("skills/advisor-worker/roles/builder/SKILL.md"),
    text("skills/advisor-worker/roles/foreman/SKILL.md"),
    text("skills/advisor-worker/roles/checker/SKILL.md"),
    text("skills/advisor-worker/references/WORKER_CONTRACT.md"),
    text("docs/advisor-runtime.md"),
    text("config/bg-agent-profiles.json"),
  ]);

  const tiers = section(source, "## Risk tiers", "## Verification ownership");
  assert.match(tiers, /\| Low \|[\s\S]*\| Standard \|[\s\S]*\| High \|/);
  assert.match(tiers, /Unknown coupling selects the higher\s+tier/);
  assert.match(tiers, /`## Risk tiers` section in its `AGENTS.md`/);
  assert.match(tiers, /Standard packet: FAIL on a violated criterion or an unrepaired High finding/);
  assert.match(tiers, /High packet: FAIL on a violated criterion or an unrepaired Medium-or-higher/);
  assert.match(source, /The packet is a floor, not a ceiling/);
  assert.match(source, /links evidence by\s+path rather than paraphrase/);
  assert.match(source, /Phrase each criterion as a\s+failure probe/);

  const economy = section(source, "## Checker economy", "## Status updates");
  assert.match(economy, /Low packet never earns a checker/);
  assert.match(economy, /one\s+reasoning level below their launch/);
  assert.match(economy, /in\s+every round including declared repair rounds/);
  assert.match(economy, /A repaired\s+finding never flips a verdict/);

  assert.match(builder, /## Explore freely, deliver narrowly/);
  assert.match(builder, /trace the\s+capability end to end/);
  assert.match(builder, /`Adjacent findings`/);
  assert.match(builder, /`Proposed criteria`/);
  assert.match(builder, /## Fresh review before handoff/);
  assert.match(builder, /one reasoning level below your own launch/);
  assert.match(builder, /Low packets skip it/);
  assert.match(foreman, /explore-freely, deliver-narrowly/);
  assert.match(foreman, /`Fresh review`/);

  assert.match(checker, /\| Standard \| a violated criterion, or an unrepaired High finding \|/);
  assert.match(checker, /\| High \| a violated criterion, or an unrepaired Medium-or-higher finding \|/);
  assert.match(checker, /A repaired finding never flips the verdict/);
  assert.match(checker, /including declared repair rounds/);

  assert.match(contract, /`Proposed criteria`/);
  assert.match(contract, /every evidence path the packet links/);
  assert.match(runtime, /## 🎚️ Risk tiers/);
  assert.match(runtime, /to the builder\s+for exactly one fresh-review subagent/);
  assert.match(runtime, /Settlement stalls only when that artifact is missing or blank/);
  assert(JSON.parse(roles).profiles.builder.cliArgs.includes("--advisor-worker-allow-subagents"));
});

test("mechanical findings are repaired inline and never bind a verdict or become criteria", async () => {
  const [source, checker, runtime] = await Promise.all([
    text("skills/advisor/SKILL.md"),
    text("skills/advisor-worker/roles/checker/SKILL.md"),
    text("docs/advisor-runtime.md"),
  ]);

  const hygiene = section(source, "## Verdict hygiene", "## Delegation decision tree");
  assert.match(hygiene, /Auto-fixable mechanical\s+findings[\s\S]*formatter output, lint autofix, generated-file drift, result\s+artifact formatting[\s\S]*never bind a verdict or stall a run/);
  assert.match(hygiene, /formatter-only or lint-only FAIL is a\s+note/);
  assert.match(source, /A packet never carries a formatter or lint pass as an acceptance\s+criterion/);
  assert.match(source, /runs the fixer before rerunning\s+it/);

  const mandate = section(checker, "## Inline repair mandate", "## ");
  assert.match(mandate, /formatter-only or lint-only diff[\s\S]*always mechanical/);
  assert.match(mandate, /never return it as a FAIL/);

  assert.match(runtime, /mechanical findings \(formatter output, lint autofix, generated-file drift, result formatting\) are repaired inline by whoever finds them and never bind a verdict/);
  assert.match(runtime, /formatter or lint pass is never an acceptance criterion on its own/);
});
