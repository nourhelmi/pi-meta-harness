import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const text = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\s+/g, " ");
const core = await text("skills/advisor/doctrine.md");
const graphs = await text("skills/advisor/references/graphs.md");
const transport = await text("skills/advisor/references/transport-and-settlement.md");
const managed = await text("skills/advisor-stock-entry/SKILL.md");
const native = await text("native-skills/advisor/SKILL.md");

// Wording regressions complement the runtime tests; they do not prove live model behavior.
test("outcome ownership does not fragment necessary repairs into new packets", async () => {
  for (const path of ["skills/advisor-worker/roles/builder/SKILL.md", "skills/advisor-worker/references/WORKER_CONTRACT.md", "native-skills/advisor/references/worker-contract.md"]) {
    const source = await text(path);
    assert.match(source, /(?:Fix|fix|Own) necessary in-scope/);
    assert.match(source, /blast radius/);
    assert.doesNotMatch(source, /never widen a repair round beyond|repair round as scoped to its enumerated findings/);
  }
  assert.match(core, /not a partial fix|never a partial fix/);
  assert.doesNotMatch(core, /lock a packet for the minimal fix first/);
});

test("both checker skill surfaces repair frozen baselines without claiming independent self-review", async () => {
  for (const path of ["skills/advisor-worker/roles/checker/SKILL.md", "native-skills/advisor-role-checker/SKILL.md"]) {
    const source = await text(path);
    assert.match(source, /Repair every finding you can/);
    assert.match(source, /(?:serious|Serious)\/High/);
    assert.match(source, /frozen baseline alone does not/);
    assert.match(source, /(?:explicit|Explicit) read-only/);
    assert.match(source, /non-author/);
    assert.match(source, /(?:Commit|commits).*authoriz/);
    assert.doesNotMatch(source, /read-only or frozen|or frozen-revision|decision the packet did not lock/);
  }
  for (const source of [core, managed, native]) {
    assert.match(source, /non-author/);
    assert.match(source, /same (?:checker|reviewer)/);
    assert.match(source, /frozen baseline.*(?:not|does not).*read-only/i);
  }
});

test("graph guidance carries current attempts on stable outcome nodes without inventing native APIs", () => {
  assert.match(graphs, /node represents an accepted outcome, not a single model turn or repair attempt/);
  assert.match(graphs, /retain the graph\/node\/run and explicitly refresh/);
  assert.match(graphs, /preserve repair budgets/);
  assert.match(graphs, /returned task\/evidence prompt with the ordinary launch tool/);
  assert.match(graphs, /graphless repair does not require this block/);
  assert.match(managed, /advisor_worker_graph_evidence/);
  assert.match(native, /Do not claim managed-runtime graph tools or attestations/);
  for (const source of [graphs, managed]) {
    assert.match(source, /replacesRunId/); assert.match(source, /replacesAttempt/);
    assert.match(source, /[Aa]dmission/); assert.match(source, /not currently green/);
  }
  assert.match(native, /maker owns remaining diagnosis/);
});

test("captured handoffs replace routine forensic hunts but never bypass recovery fences", () => {
  for (const source of [core, transport, managed]) {
    assert.match(source, /captured (?:result|report|proof)/);
    assert.match(source, /continuation|reply\/task|permits `task`/);
    assert.match(source, /missing.*capture|Missing.*capture/);
    assert.match(source, /(?:Never|never).*(?:replay|relaunch|clear locks)/);
  }
  assert.match(transport, /Historical deliveries refer to their original attempts/);
  assert.match(transport, /Do not use worktree commits, report mtimes or branch movement to override/);
  assert.match(transport, /explicit acceptance requirement.*stays unsatisfied if bypassed by direct work/);
});

test("readiness and integration evidence have owners rather than mandatory repeated sweeps", async () => {
  const routing = await text("skills/advisor/references/model-routing.md");
  const evidence = await text("skills/advisor/references/evidence.md");
  assert.match(routing, /Assign task-shaped readiness to the maker or browser verifier and reuse current proof/);
  assert.match(routing, /missing safe target, credential or authority is a real stop/);
  assert.match(evidence, /unchanged patch does not prove an unchanged dependency or environment/);
  assert.match(evidence, /rerun invalidated criteria and required merge gates/);
  assert.doesNotMatch(evidence, /single criterion rerun is the maximum|carries every prior verdict/);
  for (const source of [managed, native]) {
    assert.match(source, /one (?:current|authoritative) operational checkpoint/);
    assert.match(source, /(?:not every read|not every read or status tick)/);
    assert.match(source, /parallel memory diaries/);
  }
});

test("routing scales with decision context rather than a shared product goal", () => {
  for (const source of [core, native]) {
    assert.match(source, /small (?:and|or) cohesive-medium/);
    assert.match(source, /Cohesion means shared decisions and useful working context, not merely one product goal/);
    assert.match(source, /sustained multi-domain work, normally delegate bounded outcomes/);
    assert.match(source, /One accountable owner does not mean one executor/);
    assert.match(source, /Front-load the hardest uncertain acceptance claim with a small real proof/);
  }
});

test("child advisors share strategy doctrine without topology quotas or lost boundaries", async () => {
  for (const source of [core, native]) {
    assert.match(source, /Delegate the outcome and constraints, not the execution strategy/i);
    assert.match(source, /Do not prescribe read-only helpers, forbid builders, or lock role order as management preferences/i);
    assert.match(source, /parent outcome/);
    assert.match(source, /independent checking|independent review/);
  }
  const child = await text("skills/advisor-worker/roles/advisor/SKILL.md");
  const nativeChild = await text("native-skills/advisor-role-advisor/SKILL.md");
  assert.match(child, /same installed advisor doctrine/);
  assert.match(child, /parent.*outcome/);
  assert.match(child, /result\.md/);
  assert.match(core, /no graph, delegation depth, role sequence or launch quota is required/);
  assert.match(core, /creating a child, graph or repair attempt never creates a fresh budget/);
  assert.match(graphs, /never edit alongside a writing helper in the same checkout/);
  assert.match(core, /child advisor's self-review is still maker evidence/);
  assert.match(nativeChild, /shared advisor guidance/);
  assert.match(nativeChild, /Inherit the parent's execution lane, actual authority, remaining spend\/depth limits/);
  assert.match(nativeChild, /Do not report completion with unaccounted live children/);
  for (const path of ["skills/advisor-worker/roles/foreman/SKILL.md", "native-skills/advisor-role-foreman/SKILL.md"]) {
    const legacy = await text(path);
    assert.match(legacy, /compatibility/); assert.match(legacy, /advisor\/SKILL\.md/);
    assert.doesNotMatch(legacy, /mini-advisor|depth-1/);
  }
});
