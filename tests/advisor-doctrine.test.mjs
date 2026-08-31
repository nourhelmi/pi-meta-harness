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

  assert.match(source, /Never implement in this session/);
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

test("frozen adaptive prospective case contracts remain byte-identical", async () => {
  const expected = new Map([
    ["evals/prospective/single-maker-fast-path/case.json", "bacfafc735c6f96eb4f7edf01f8dca224c27f0ff2a3ecb7a823df851431c7b8a"],
    ["evals/prospective/cohesive-medium-maker/case.json", "8bda959efc95e3c465ac4121825ceb1b75dbbf356bca43dc144745ca9bfaf9a4"],
    ["evals/prospective/risk-triggered-checker/case.json", "926a7d170f10569ea99b52114c2dafe5ac3e058fde23fefca0461e01476aae01"],
  ]);

  for (const [path, digest] of expected) {
    const contents = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(createHash("sha256").update(contents).digest("hex"), digest, path);
  }
});
