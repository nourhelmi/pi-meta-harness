import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const text = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const REFERENCES = ["graphs", "model-routing", "evidence", "transport-and-settlement"];
// The doctrine is the injected core plus its on-demand references; phrase checks that do not
// care where a rule lives read the concatenation, section checks name the file.
const doctrine = async () =>
  [await text("skills/advisor/doctrine.md"), ...(await Promise.all(REFERENCES.map((name) => text(`skills/advisor/references/${name}.md`))))].join("\n\n");
const section = (source, heading, nextHeading) => {
  const start = source.indexOf(heading);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const end = nextHeading ? source.indexOf(nextHeading, start + heading.length) : source.length;
  return source.slice(start, end === -1 ? source.length : end);
};

test("codex-max guidance agrees on Astra xhigh primaries and Luna max procedural roles", async () => {
  const [advisor, profiles, switcher] = await Promise.all([
    doctrine(),
    text("docs/intelligence-profiles.md"),
    text("skills/switch-intelligence-profile/SKILL.md"),
  ]);
  assert.match(advisor, /in `codex-max`, every UX builder[\s\S]{0,150}uses Astra xhigh with `frontend-design`/);
  assert.match(advisor, /`codex-max` the advisor session, planner, foreman, and primary builder run on\s+Astra at xhigh/);
  assert.match(advisor, /Astra xhigh for all decision-bearing builders in `codex-max`/);
  const card = section(profiles, "### `codex-max`", "### `codex-lean`");
  assert.match(card, /\| advisor \| Astra xhigh/);
  assert.match(card, /\| planner \| Astra xhigh/);
  assert.match(card, /\| builder \| Astra xhigh/);
  assert.match(card, /\| foreman \| Astra xhigh/);
  assert.match(card, /\| scout \| Luna max/);
  assert.match(card, /\| browser-verifier \| Luna max/);
  assert.match(card, /advisor, planner, foreman, and primary builder at\s+xhigh/);
  const row = switcher.split("\n").find((line) => line.startsWith("| `codex-max` |"));
  assert.match(row, /Astra xhigh; Sol high for locked packets \| Sol xhigh \| Luna max/);
  assert.match(switcher, /advisor, planner, foreman, and primary builder use Astra\s+xhigh/);
  assert.match(switcher, /scouting and browser verification use Luna max/);
  assert.match(switcher, /https:\/\/github.com\/nourhelmi\/pi-meta-harness\/blob\/main\/docs\/intelligence-profiles.md/);
});

test("codex-lean guidance reserves Astra for ambiguity and uses Sol for regular work", async () => {
  const [advisor, profiles, switcher] = await Promise.all([
    doctrine(),
    text("docs/intelligence-profiles.md"),
    text("skills/switch-intelligence-profile/SKILL.md"),
  ]);
  assert.match(advisor, /`codex-lean`, regular UX builders use Sol medium/);
  assert.match(advisor, /advisor uses Astra xhigh while planner and foreman nodes use Astra high/);
  assert.match(advisor, /Sol medium for regular\s+builders, locked packets, checking, and reduction in `codex-lean`/);
  const card = section(profiles, "### `codex-lean`", "### `anthropic-heavy`");
  assert.match(card, /\| advisor \| Astra xhigh/);
  assert.match(card, /\| planner \| Astra high/);
  assert.match(card, /\| builder \| Sol medium; Astra medium \(ambiguous or wide breadth\)/);
  assert.match(card, /\| checker \| Sol medium/);
  assert.match(card, /\| reducer \| Sol medium/);
  assert.match(card, /\| scout \| Luna max/);
  assert.match(card, /\| browser-verifier \| Luna max/);
  assert.doesNotMatch(card, /Sonnet|Fable|Grok/);
  assert.match(switcher, /In `codex-lean`, the advisor uses Astra xhigh/);
  assert.match(switcher, /regular builders use Sol medium/);
  assert.match(switcher, /Checking, reduction, and fully locked\s+execution use Sol medium/);
  assert.match(switcher, /scouting and browser verification use Luna max/);
  assert.match(switcher, /only OpenAI Codex models/);
});

test("the advisor entry skill is thin and the injected core stays small with a references index", async () => {
  const [entry, core] = await Promise.all([text("skills/advisor/SKILL.md"), text("skills/advisor/doctrine.md")]);

  assert.match(entry, /^name: advisor$/m);
  assert.match(entry, /advisor_session_init/);
  assert.match(entry, /doctrine\.md/);
  assert.match(entry, /Do not read the doctrine or the guide with a tool/);
  assert.doesNotMatch(entry, /## Non-negotiables|## Risk tiers/);
  assert.ok(entry.length < 3000, `entry skill is ${entry.length} bytes; it must stay a bootstrap`);

  assert.deepEqual(core.match(/^# [^#].*$/gm) ?? [], ["# Advisor"]);
  assert.doesNotMatch(core, /^---\n/, "the injected core carries no skill frontmatter");
  assert.ok(core.length < 26000, `doctrine core is ${core.length} bytes; keep it near six thousand tokens`);
  const references = section(core, "## References");
  for (const name of REFERENCES) {
    assert.match(references, new RegExp("`references/" + name + "\\.md`"));
    await text(`skills/advisor/references/${name}.md`);
  }
  assert.match(references, /do not read them at session start/);
});

test("routes put direct work and the single maker ahead of graphs and planners", async () => {
  const core = await text("skills/advisor/doctrine.md");
  const routes = section(core, "## Routes", "## Non-negotiables");

  assert.match(routes, /1\. \*\*Direct\.\*\*/);
  assert.match(routes, /2\. \*\*Single maker\.\*\*/);
  assert.match(routes, /3\. \*\*Graph\.\*\*/);
  assert.match(routes, /should feel like launching one ordinary agent/);
  assert.match(routes, /no planner, no\s+graph, no checker unless the tier or the user asks/);
  assert.match(routes, /\*\*Direct\.\*\*[\s\S]*First-class at every risk tier/);
  assert.match(routes, /default to one empowered maker: you, a\s+builder, or a foreman/);
  assert.match(routes, /owns diagnosis, implementation, task-shaped\s+deterministic tests, and ordinary browser exercise/);
  assert.match(routes, /presumption against ceremony, not a one-agent target/);
  assert.match(routes, /marginal evidence value\s+and critical-path latency/);
  assert.match(routes, /materially resolve uncertainty, shorten genuinely parallel work, or add useful\s+independent confidence/);
  assert.match(routes, /Stop expanding the route when another launch would\s+mostly replay evidence/);
  assert.match(routes, /Plan the work yourself by default/);
  assert.match(routes, /Adopt, revise, or reject its proposed roles and sequence/);
  assert.match(routes, /planner offers an optional second opinion\s+for product or architecture uncertainty/);
  assert.match(routes, /Tooling, environment,\s+harness and formatting failures belong to the same maker/);
  assert.doesNotMatch(routes, /\d+\s*(?:minutes?|hours?)/i);
  assert.doesNotMatch(routes, /(?:minimum|maximum)\s+(?:agent|worker|launch)/i);
});

test("packets freeze the contract and never the procedure, and are sized after diagnosis", async () => {
  const core = await text("skills/advisor/doctrine.md");
  const packets = section(core, "## Packets", "### Bound after diagnosis");
  const sizing = section(core, "### Bound after diagnosis", "## Risk tiers");

  assert.match(packets, /\*\*Quick packet\*\*/);
  assert.match(packets, /ten to twenty lines/);
  assert.match(packets, /criteria phrased as failure probes/);
  assert.match(packets, /evidence linked by path rather than paraphrase/);
  assert.match(packets, /one risk-tier line with its reason/);
  assert.match(packets, /\*\*What a packet may freeze:\*\*/);
  assert.match(packets, /\*\*What a packet may never freeze:\*\*/);
  assert.match(packets, /tool or runtime versions the repository\s+does not itself pin/);
  assert.match(packets, /"any severity is terminal"/);
  assert.match(packets, /"no retry"/);
  assert.match(packets, /"no install or alternate runtime"/);
  assert.match(packets, /Do not open a packet with "execute\s+exactly"/);
  assert.match(packets, /never carries a formatter or lint pass as an acceptance\s+criterion/);
  assert.match(packets, /judge a maker against a hidden contract/);
  assert.match(packets, /`keepAlive: true`[\s\S]*checker expected to revisit its findings/);
  assert.match(packets, /current continuation eligibility/);

  assert.match(sizing, /Bound the accepted outcome, not an arbitrary number of files or steps/);
  assert.match(sizing, /maker may own the remaining diagnosis and implementation together/);
  assert.match(sizing, /never\s+a partial fix merely because it is shorter/);
  assert.match(sizing, /complete\s+cross-layer repair authorizes that outcome, not unrelated redesign/);
  assert.match(sizing, /shared root cause, integration,\s+or safety boundary is part of the accepted outcome/);
  assert.match(sizing, /without a new packet for\s+each discovery/);
  assert.match(sizing, /Escalate an unaccepted product decision, explicitly excluded\s+surface, changed acceptance, or additional authority/);
  assert.match(sizing, /Scope ledger/);
  assert.doesNotMatch(sizing, /minimal fix first|separate, costed option|file-count threshold/);
  assert.doesNotMatch(sizing, /\d+\s*(?:files?|lines?|minutes?)/i);

  const extension = await text("extensions/advisor-session.ts");
  assert.match(extension, /## Scope ledger/);
  assert.match(section(core, "## Isolated state", "## Session start"), /Scope ledger \(see Bound after\s+diagnosis\)/);
});

test("risk tiers are declared per change with a Standard default and consequence-graded severity", async () => {
  const core = await text("skills/advisor/doctrine.md");
  const tiers = section(core, "## Risk tiers", "## Obstacles, blockers, and verdicts");

  assert.match(tiers, /Tier the \*\*change\*\*, not the workstream/);
  assert.match(tiers, /Standard is\s+the default when no High surface is named/);
  assert.match(tiers, /Classify by behavioral effect, not filename or patch size/);
  assert.match(tiers, /can be Low only when runtime\s+behavior, acceptance oracles, and enforcement semantics remain unchanged/);
  assert.match(tiers, /cannot downgrade a High-risk effect/);
  assert.match(tiers, /take the tier of the boundary they control; the highest applicable tier wins/);
  assert.doesNotMatch(tiers, /repairs are Low by rule/);
  assert.match(tiers, /\| Low \|[\s\S]*\| Standard \|[\s\S]*\| High \|/);
  assert.match(tiers, /unknown coupling\s+selects the higher tier/i);
  assert.match(tiers, /`## Risk tiers` section in its\s+`AGENTS.md`/);
  assert.match(tiers, /violated criterion or unrepaired High finding/);
  assert.match(tiers, /violated criterion or unrepaired Medium-or-higher finding/);
  assert.match(tiers, /Finding severity is consequence/);
  assert.match(tiers, /A violated criterion takes\s+the severity of what it breaks/);
  assert.match(tiers, /re-tiered in a recorded packet revision/);
});

test("obstacles are resolved by workers and Blocked has exactly four meanings everywhere", async () => {
  const [core, contract, builder, foreman, checker, browser, runtime] = await Promise.all([
    text("skills/advisor/doctrine.md"),
    text("skills/advisor-worker/references/WORKER_CONTRACT.md"),
    text("skills/advisor-worker/roles/builder/SKILL.md"),
    text("skills/advisor-worker/roles/foreman/SKILL.md"),
    text("skills/advisor-worker/roles/checker/SKILL.md"),
    text("skills/advisor-worker/roles/browser-verifier/SKILL.md"),
    text("extensions/advisor-worker.ts"),
  ]);
  const hygiene = section(core, "## Obstacles, blockers, and verdicts", "## Review");

  assert.match(hygiene, /\*\*Blocked\*\* means exactly one of four things/);
  assert.match(hygiene, /Nothing else is a blocker/);
  assert.match(hygiene, /wrong tool or runtime version/);
  assert.match(hygiene, /launcher-created placeholder file/);
  assert.match(hygiene, /record what they changed and why under `Deviations`/);
  assert.match(hygiene, /safety boundary the\s+packet names[\s\S]*not an\s+obstacle/);
  assert.match(hygiene, /Auto-fixable mechanical findings \(formatter\s+output, lint autofix, generated-file drift, result formatting\) are repaired\s+inline by whoever finds them and never bind a verdict or stall a run/);
  assert.match(hygiene, /change\s+to an oracle, gate, or runtime behavior is not mechanical/);
  assert.match(hygiene, /Deterministic evidence is authoritative for\s+the claim it actually proves/);

  assert.match(contract, /Distinguish obstacles from blockers/);
  assert.match(contract, /exactly one of four\s+things/);
  assert.match(contract, /record\s+what you changed and why under `Deviations`/);
  assert.match(contract, /only after a bounded attempt to\s+unblock yourself/);
  assert.match(contract, /missing skill name\s+is never a blocker/);
  assert.match(contract, /Never invent a missing product decision or product fallback\s+behavior/);
  assert.match(contract, /Add `Deviations` whenever you resolved an obstacle/);
  assert.match(contract, /placeholder is expected, not a contradiction/);
  assert.doesNotMatch(contract, /permission,\s+credential, or fallback/);

  assert.match(builder, /## Obstacles are yours to clear/);
  assert.match(builder, /none of these is\s+a blocker/);
  assert.match(builder, /Select or install the toolchain the repository pins/);
  assert.match(builder, /Do not add speculative abstractions or unaccepted fallback behavior/);
  assert.match(foreman, /obstacle rule to yourself and to every helper/);
  assert.match(foreman, /never stop for it while your own helpers are live/);
  assert.match(checker, /Environment and tooling obstacles are yours to clear/);
  assert.match(browser, /Runtime setup is an obstacle, not a blocker/);
  assert.match(browser, /wrong data target, a production system,\s+or a missing credential is a safety boundary or a blocker/);

  assert.match(runtime, /Blocked means exactly one of four things/);
  assert.match(runtime, /record it under Deviations/);
  assert.match(runtime, /advisory ceiling, never a reason to stop while your own helpers are live/);

  for (const name of ["codex-max", "codex-lean", "anthropic-heavy", "balanced", "grok-cycle"]) {
    const guide = JSON.parse(await text(`config/intelligence-profiles/${name}.json`));
    for (const [id, model] of Object.entries(guide.models)) {
      assert.doesNotMatch(model.character, /auth, fallback,/, `${name} ${id} still lists fallback as a stop`);
      if (/stops and escalates/.test(model.character)) {
        assert.match(model.character, /resolves environment and tooling obstacles locally/, `${name} ${id}`);
      }
    }
  }
});

test("checkers are repair-first and review converges with the same reviewer", async () => {
  const [core, checker, graphs, roles] = await Promise.all([
    text("skills/advisor/doctrine.md"),
    text("skills/advisor-worker/roles/checker/SKILL.md"),
    text("skills/advisor/references/graphs.md"),
    text("config/bg-agent-profiles.json"),
  ]);
  const review = section(core, "## Review", "## Freeform workers");

  assert.match(review, /No phase, merged deliverable, or PR universally requires a checker/);
  assert.match(review, /schema or migration,[\s\S]*auth, security, privacy, money, destructive or external effects/);
  assert.match(review, /broad change\s+with a weak oracle, conflicting evidence, material residual maker risk/);
  assert.match(review, /High-risk boundaries receive independent review before\s+completion/);
  assert.match(review, /Low tier alone never earns a checker;\s+explicit review requests still apply/);
  assert.match(review, /maker-owned fresh-context reviewer is\s+not automatic on Standard or High/);
  assert.match(review, /Do not stack it ahead of a planned independent checker covering\s+the same purpose/);
  assert.match(review, /\*\*Checkers are repair-first\.\*\*/);
  assert.match(review, /at any severity, unless the fix needs an unaccepted product\s+or architecture decision, unauthorized schema\/migration semantics, or an external effect/);
  assert.match(review, /verdict describes the post-repair state/);
  assert.match(review, /A repaired finding alone does not cause FAIL/);
  assert.match(review, /Resume the same checker for a delta review/);
  assert.match(review, /Two serial review rounds per slice is the default budget/);
  assert.match(review, /not evidence of completion/);
  assert.match(review, /Deliver only when all acceptance criteria,\s+required checks, and safety obligations are satisfied/);
  assert.match(review, /report the work as incomplete/);
  assert.match(review, /never silently reset a cap by renaming the slice or launching another\s+planner/);
  assert.doesNotMatch(review, /one checker per phase|final whole-diff review/i);

  assert.match(checker, /and repair what you find/);
  assert.match(checker, /Your own patch is maker work/);
  assert.match(checker, /reruns are self-verification, not independent review of that patch/);
  assert.match(checker, /## Repair-first mandate/);
  assert.match(checker, /at any severity, inside the surface you reviewed/);
  assert.match(checker, /Three things you do not repair/);
  assert.match(checker, /classify\s+by behavioral effect, not filename/);
  assert.match(checker, /Never weaken\s+acceptance to make a rerun green/);
  assert.match(checker, /The verdict describes the state after your repairs/);
  assert.match(checker, /A repaired finding alone does not cause FAIL/);
  assert.match(checker, /PASS-with-repairs are normal, common outcomes/);
  assert.match(checker, /in every round including declared repair\s+rounds/);
  assert.match(checker, /\| Standard \| a violated criterion, or an unrepaired High finding \|/);
  assert.match(checker, /\| High \| a violated criterion, or an unrepaired Medium-or-higher finding \|/);
  assert.doesNotMatch(checker, /at most three findings|repair none of that class/);

  assert.match(JSON.parse(roles).profiles.checker.description, /repairs every finding it can/);
  assert.match(graphs, /A checker repairs what it can inside the reviewed surface/);
  assert.match(graphs, /resume the same checker\s+for the delta review/);
  assert.match(graphs, /Never exceed the manifest repair-loop cap/);
  assert.match(graphs, /only with all criteria, required checks, and safety obligations satisfied/);
  assert.match(graphs, /Otherwise report incomplete work/);
});

test("the advisor avoids redundant skill reads but loads decision-relevant instructions and keeps a hot section", async () => {
  const [core, transport, native, pi, switcher] = await Promise.all([
    text("skills/advisor/doctrine.md"),
    text("skills/advisor/references/transport-and-settlement.md"),
    text("skills/advisor-native/SKILL.md"),
    text("skills/advisor-pi/SKILL.md"),
    text("skills/switch-intelligence-profile/SKILL.md"),
  ]);

  assert.match(core, /This core stays in your system prompt/);
  const transportPolicy = section(core, "## Worker transport", "## Evidence");
  assert.match(transportPolicy, /Do not preload role\s+skills, the worker contract, or repository skills merely to launch a worker/);
  assert.match(transportPolicy, /Read the relevant skill or contract section when a concrete planning,\s+review, investigation, implementation, or recovery decision needs it/);
  assert.match(transportPolicy, /need not be editing code/);
  assert.match(transportPolicy, /Required task and safety instructions still apply/);
  const state = section(core, "## Isolated state", "## Session start");
  assert.match(state, /\*\*hot section\*\* is everything above the `## Log` heading/);
  assert.match(state, /hot section returns at start and compaction/);
  assert.match(section(core, "## Session start", "## References"), /returns the\s+workstream hot section/);
  assert.doesNotMatch(core, /Re-read the live guide|about 60%|load it completely/);
  assert.match(section(transport, "## Context budget"), /never read\s+them with a tool/);
  assert.match(section(transport, "## Context budget"), /do not write session summaries to a memory system\s+as a substitute for the workstream file/);
  for (const bootstrap of [native, pi]) {
    assert.match(bootstrap, /do not read `\.\.\/advisor\/doctrine\.md` or\s+`advisor-intelligence\.json` with a tool/);
    assert.doesNotMatch(bootstrap, /load it completely|Do not call\s+`bg_agent` until/);
  }
  assert.doesNotMatch(switcher, /re-read `advisor-intelligence\.json`/);
});

test("doctrine rejects legacy universal gates across core and references", async () => {
  const source = await doctrine();
  const graphs = section(await text("skills/advisor/references/graphs.md"), "## Information-value graphing", "## The `GRAPH:` block");

  assert.doesNotMatch(source, /one checker per phase|final whole-diff review before PR/i);
  assert.doesNotMatch(source, /every non-destructive pre-?flight/i);
  assert.doesNotMatch(source, /(?:advisor|delivery)[\s\S]{0,80}(?:reruns?|replays?)[\s\S]{0,40}every (?:deterministic )?criteri/i);
  assert.match(graphs, /task-shaped deterministic criteria still needed for authoritative[\s\S]*proportionate to cost, risk, and oracle strength/);
  assert.doesNotMatch(graphs, /Run (?:all )?deterministic criteria/);
});

test("verification ownership is proportional and review depth stops on resolved risk", async () => {
  const evidence = await text("skills/advisor/references/evidence.md");
  const verification = section(evidence, "## Verification ownership", "## Review depth and closure");
  const depth = section(evidence, "## Review depth and closure", "## Evidence delivery");

  assert.match(verification, /maker proves every acceptance criterion[\s\S]*exact commands and task-shaped evidence/);
  assert.match(verification, /advisor[\s\S]*any still-needed\s+authoritative rerun by risk, oracle strength, and uncertainty/);
  assert.match(verification, /need not\s+replay every expensive criterion/);
  assert.match(verification, /checker audits the same acceptance contract and declared risk tier[\s\S]*Independently\s+probe/);
  assert.match(verification, /genuinely new finding that meets the packet's severity bar remains valid/);
  assert.match(verification, /actual required merge or CI gates once/);
  assert.match(verification, /Do not mandate\s+unrelated repository-wide sweeps/);
  assert.match(depth, /assigned claims and material risks are resolved with current evidence and no\s+material contradiction remains/);
  assert.match(depth, /never launch an automatic checker-of-checker for closed work/);
  assert.match(depth, /not independent review of that patch/);
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
  assert.match(contract, /only\s+a missing or blank[\s\S]*stalls settlement/);
  assert.match(contract, /Keep the final response short/);
  assert.doesNotMatch(contract, /at most 12 lines/);
  assert.match(builder, /diagnose it, implement it,[\s\S]*task-shaped deterministic tests[\s\S]*ordinary browser exercise/);
  assert.match(builder, /exact command\s+evidence/);
  assert.match(foreman, /Use depth-1 visible subagents[\s\S]*shorten the critical[\s\S]*path, isolate useful working context, resolve material uncertainty, or add useful[\s\S]*evidence/);
  assert.match(foreman, /depth-1 visible subagents/);
  assert.match(checker, /same acceptance[\s\S]*contract and declared risk tier/);
  assert.match(checker, /Do\s+not blindly replay every maker command/);
  assert.match(checker, /new finding that meets\s+this packet's severity bar remains valid/);
  assert.match(browser, /maker owns ordinary browser exercise/);
  assert.match(browser, /baseline behavior is ambiguous[\s\S]*independent persona, safety,[\s\S]*or release witness/);
  assert.match(browser, /task-shaped readiness checks/);
  assert.doesNotMatch(contract + browser, /every non-destructive pre-flight/i);
});

test("adaptive doctrine preserves advisor safety and composition invariants", async () => {
  const source = await doctrine();
  const runtime = await text("docs/advisor-runtime.md");

  assert.match(source, /\*\*Direct\.\*\*[\s\S]*First-class at every risk tier/);
  assert.match(source, /maker self-verification at\s+every tier[\s\S]*fresh review on Standard, and independent\s+checking on High/);
  assert.doesNotMatch(source, /Implement High in workers only|High packets always go to a visible worker|Never implement in this session|advisor still never edits implementation/);
  assert.match(source, /Deliberate criteria\s+revision[\s\S]*new packet\s+revision/);
  assert.match(source, /Every helper is visible[\s\S]*All delegated LLM work uses `bg_agent`/);
  assert.match(source, /request to use Codex or Claude Code directly means a configured\s+semantic `role`/);
  assert.match(source, /never\s+translate it into `agent: "codex"` or `agent: "claude"`/);
  assert.match(source, /no-role\s+freeform worker is Pi-hosted/);
  assert.match(source, /## Freeform workers/);
  assert.match(source, /Use a graph only when work has real independent ownership or dependency/);
  assert.match(source, /Foreman delegation is\s+depth-1 only/);
  assert.match(source, /High-risk boundaries receive independent review before\s+completion/);
  assert.match(source, /Deterministic evidence is authoritative for\s+the claim it actually proves/);
  assert.match(runtime, /presumption\s+against ceremony, not a target worker\s+count/);
  assert.match(runtime, /Stop adding launches when another[\s\S]*would mostly replay existing evidence/);
});

test("role agency includes context and local decisions without erasing write boundaries", async () => {
  const [core, contract, builder, scout, reducer, browser, checker] = await Promise.all([
    text("skills/advisor/doctrine.md"),
    text("skills/advisor-worker/references/WORKER_CONTRACT.md"),
    text("skills/advisor-worker/roles/builder/SKILL.md"),
    text("skills/advisor-worker/roles/scout/SKILL.md"),
    text("skills/advisor-worker/roles/reducer/SKILL.md"),
    text("skills/advisor-worker/roles/browser-verifier/SKILL.md"),
    text("skills/advisor-worker/roles/checker/SKILL.md"),
  ]);
  assert.match(core, /accepted decisions separated from\s+suggestions/);
  assert.match(core, /the worker's authority to act/);
  assert.match(core, /Context should enable judgment, not encode a recipe/);
  assert.match(contract, /agency over\s+methods, evidence, and\s+ordinary local decisions/);
  assert.match(contract, /downstream consumers, and which decisions are\s+locked versus suggested/);
  assert.match(builder, /You own ordinary technical choices/);
  assert.match(builder, /do not bounce routine choices\s+back to the advisor/);
  assert.match(builder, /explicit edit boundaries stay\s+binding/);
  assert.match(builder, /complete accepted behavior, including necessary\s+shared-root-cause repairs, integration, and tests/);
  assert.match(scout, /suggested search route is not a script/);
  assert.match(scout, /Do not edit product code or configuration/);
  assert.match(reducer, /including no further work/);
  assert.match(reducer, /Stay product\/config read-only/);
  assert.match(browser, /not only a supplied click script/);
  assert.match(browser, /Do not edit\s+product code/);
  assert.match(checker, /acceptance\s+oracle, or a security gate/);
  assert.match(checker, /own the reviewed write surface/);
  assert.match(checker, /Never weaken\s+acceptance/);
});

test("advisor and foreman own execution and planning while proposals remain nonbinding", async () => {
  const [advisor, foreman, planner, builder, contract] = await Promise.all([
    doctrine(),
    text("skills/advisor-worker/roles/foreman/SKILL.md"),
    text("skills/advisor-worker/roles/planner/SKILL.md"),
    text("skills/advisor-worker/roles/builder/SKILL.md"),
    text("skills/advisor-worker/references/WORKER_CONTRACT.md"),
  ]);
  assert.match(advisor, /technical lead and orchestrator/);
  assert.match(advisor, /not an\s+obligation or a preference over delegation/);
  assert.match(advisor, /Plan the work yourself by default/);
  assert.match(advisor, /Adopt, revise, or reject its proposed roles and sequence/);
  assert.match(advisor, /Reclaim\s+ownership explicitly after settlement/);
  assert.match(advisor, /Your own\s+rerun of your own work is self-verification, not independent review/);
  assert.match(advisor, /explicit acceptance requirement for a particular transport or worker stays\s+unsatisfied if bypassed by direct work/);
  assert.match(foreman, /choose direct implementation or useful delegation/);
  assert.match(foreman, /not a launch quota; direct execution is available, not the preferred route/);
  assert.match(foreman, /never edit alongside a writing helper/);
  assert.match(foreman, /escalate only changes to accepted scope, criteria, explicitly locked\s+decisions/);
  assert.match(planner, /advisor owns the plan and may adopt, revise, or reject/);
  assert.match(planner, /Do not edit product code/);
  assert.doesNotMatch(builder, /Understanding is your job, not the advisor's/);
  assert.match(contract, /Suggested implementation steps are not\s+frozen/);
  assert.match(contract, /never revise criteria yourself/);
});

test("blocked settlement doctrine documents Pi prompt and worker result signals", async () => {
  const transport = await text("skills/advisor/references/transport-and-settlement.md");
  const runtime = await text("docs/advisor-runtime.md");
  const settlement = section(transport, "## Settlement ground truth", "## Status updates");
  const blocked = section(runtime, "## Blocked signals", "## 🪜 Adaptive topology");

  assert.match(settlement, /current handoff separates admission, worker status, captured report, attempt,\s+proof and continuation/);
  assert.match(settlement, /`paused` worker remains supervised while its own helpers run/);
  assert.match(settlement, /do not require re-reading\/re-hashing an unchanged packet/);
  assert.match(settlement, /Historical deliveries refer to their original attempts/);
  assert.match(settlement, /Do not use worktree commits, report mtimes or branch movement to override/);
  assert.match(blocked, /blocking Pi UI prompt[\s\S]*marks its Herdr pane blocked through the bridge extension/);
  assert.match(blocked, /Status starts with `BLOCKED`[\s\S]*parent `bg_agent` settles it as blocked[\s\S]*request[\s\S]*sound fires/);
  assert.match(blocked, /pi-detach discovers Pi worker result artifacts through the[\s\S]*`advisor-worker` session entry[\s\S]*`resultDiscovery`/i);
});

test("protocol step 6 fixes GRAPH syntax and host support boundaries", async () => {
  const [advisor, contract, protocol, runtime] = await Promise.all([
    doctrine(),
    text("skills/advisor-worker/references/WORKER_CONTRACT.md"),
    text("docs/advisor-protocol.md"),
    text("docs/advisor-runtime.md"),
  ]);

  for (const source of [advisor, contract]) {
    for (const key of ["graph", "node", "wave", "repair", "upstream", "downstream"]) {
      assert.match(source, new RegExp("`" + key + "`"));
    }
    assert.match(source, /`GRAPH:`/);
    assert.match(source, /blank line/);
  }
  assert.match(protocol, /^## Step 6 host support$/m);
  assert.match(protocol, /\| Pi \+ pi-detach \| yes \| yes \| yes \| yes \| yes \|/);
  assert.match(protocol, /\| Claude Code \| yes \| single-maker correlation only \| no \| no \| no \|/);
  assert.match(protocol, /\| Codex \| yes \| single-maker correlation only \| no \| no \| no \|/);
  assert.match(protocol, /\| 6\. Graphs, BLOCKED replies, cancellation, resume \| done \(Pi reference; native hosts graph correlation only\) \|/);
  assert.match(runtime, /Protocol step 6[\s\S]*Pi is the[\s\S]*reference implementation/);
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

test("makers explore freely and deliver narrowly while the packet stays a floor", async () => {
  const [core, builder, foreman, contract, runtime, roles] = await Promise.all([
    text("skills/advisor/doctrine.md"),
    text("skills/advisor-worker/roles/builder/SKILL.md"),
    text("skills/advisor-worker/roles/foreman/SKILL.md"),
    text("skills/advisor-worker/references/WORKER_CONTRACT.md"),
    text("docs/advisor-runtime.md"),
    text("config/bg-agent-profiles.json"),
  ]);

  assert.match(core, /The packet is a floor, not a ceiling/);
  assert.match(core, /maker traces the capability end to end\s+before editing/);
  assert.match(core, /suggested file list is a starting point, not an exhaustive\s+write boundary unless explicitly locked/);
  assert.match(builder, /## Explore freely, deliver narrowly/);
  assert.match(builder, /trace the\s+capability end to end/);
  assert.match(builder, /`Adjacent findings`/);
  assert.match(builder, /`Proposed criteria`/);
  assert.match(builder, /## Fresh review before handoff/);
  assert.match(builder, /model and\s+effort by the review need and live guide/);
  assert.match(builder, /fresh-context helper is optional, not an\s+automatic Standard\/High step/);
  assert.match(foreman, /explore-freely, deliver-narrowly/);
  assert.match(foreman, /`Fresh review`/);
  assert.match(contract, /`Proposed criteria`/);
  assert.match(contract, /inspect the linked proof needed for\s+your assigned work/);
  assert.match(contract, /Required evidence and material contract\/threat context\s+must still be read/);
  assert.match(runtime, /## 🎚️ Risk tiers/);
  assert.match(runtime, /to the builder\s+for at most one optional read-only review helper/);
  assert.match(runtime, /Settlement stalls only when that artifact is missing or blank/);
  assert.match(runtime, /mechanical findings \(formatter output, lint autofix, generated-file drift, result formatting\) are repaired inline by whoever finds them and never bind a verdict/);
  assert.match(runtime, /formatter or lint pass is never an acceptance criterion on its own/);
  assert(JSON.parse(roles).profiles.builder.cliArgs.includes("--advisor-worker-allow-subagents"));
});
