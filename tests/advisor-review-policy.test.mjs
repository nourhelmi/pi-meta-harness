import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const REFERENCES = ["graphs", "model-routing", "evidence", "transport-and-settlement"];
const paths = {
  contract: "skills/advisor-worker/references/WORKER_CONTRACT.md",
  builder: "skills/advisor-worker/roles/builder/SKILL.md",
  child: "skills/advisor-worker/roles/advisor/SKILL.md",
  checker: "skills/advisor-worker/roles/checker/SKILL.md",
  runtime: "docs/advisor-runtime.md",
  readme: "README.md",
};
const collapse = (source) => source.replace(/\s+/g, " ");
const policy = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, collapse(await read(path))])));
// Check the injected core separately too: a reference must not mask a missing core boundary.
const advisorCore = collapse(await read("skills/advisor/doctrine.md"));
const advisorReferences = Object.fromEntries(await Promise.all(REFERENCES.map(async (name) =>
  [name, collapse(await read(`skills/advisor/references/${name}.md`))],
)));
policy.advisor = [advisorCore, ...Object.values(advisorReferences)].join(" ");
// Child behavior comes from the shared core and worker evidence contract, not a duplicated role.
policy.child = [policy.child, advisorCore, policy.contract].join(" ");
// These are instruction-contract regressions, not a claim about live model behavior.
test("project-owned review replaces risk-tier and local reviewer choreography", () => {
  assert.match(policy.advisor, /maker proves every acceptance criterion, inspects its own diff/);
  assert.match(policy.builder, /run the named checks, exercise the behavior/);
  assert.match(policy.builder, /inspect your own diff/);
  for (const source of [advisorCore, policy.runtime]) {
    assert.match(source, /No (?:phase, risk tier|tier mandates)/);
    assert.match(source, /agentic PR review/i);
    assert.match(source, /current PR revision/);
    assert.match(source, /(?:pending|Pending), unavailable or stale required/);
    assert.match(source, /(?:substitute|cannot substitute)/);
    assert.match(source, /If no external review is required, do not invent one/);
    assert.match(source, /scope and authorization/);
    assert.doesNotMatch(source, /High(?:-risk boundaries receive independent review| requires a designated independent checker)|one maker and a designated independent checker/);
  }
  assert.match(policy.builder, /helper is optional, not an automatic Standard\/High step/);
  assert.match(policy.builder, /Risk alone never mandates a harness checker/);
  assert.match(policy.child, /Follow project\/user review requirements for the integrated outcome/);
  assert.match(policy.advisor, /Do not stack it ahead of a planned independent checker covering the same purpose/);
});

test("optional review capacity retains delegation boundaries and needs a distinct review purpose", () => {
  assert.match(policy.builder, /at most one read-only review helper, not a launch quota or general delegation permission/);
  assert.match(policy.builder, /named material uncertainty/);
  assert.match(policy.builder, /Forbid editing, further delegation, or messaging any session/);
  assert.match(policy.builder, /supplemental maker evidence, never an independent checker verdict/);
  assert.match(policy.builder, /model and effort by the review need and live guide/);
  assert.match(policy.child, /Do not prescribe read-only helpers, forbid builders/);
  assert.match(policy.child, /child advisor's self-review is still maker evidence/);
  assert.doesNotMatch(policy.child, /Never launch a checker/);
  assert.match(policy.child, /may delegate further within their authority and explicit user limits/);
  assert.match(policy.contract, /specialists never start another agent or graph unless their role explicitly grants bounded depth-1 helpers; those helpers inherit the leaf prohibition/);
  for (const [name, source] of Object.entries(policy)) {
    assert.doesNotMatch(source, /one reasoning level below|with the same model family|launch exactly one read-only subagent|Makers run one fresh-context review|one maker with (?:maker-owned )?fresh review/i, name);
  }
});

test("scoped evidence reuse preserves provenance, explicit independent checks, and honest missing proof", () => {
  for (const name of ["advisor", "checker", "contract"]) {
    assert.match(policy[name], /Explicitly required independent checks must actually run/, name);
    assert.match(policy[name], /command\/outcome/, name);
    assert.match(policy[name], /limitations/, name);
  }
  assert.match(policy.advisor, /commit alone is not a revision identity for a dirty worktree/);
  assert.match(policy.advisor, /code, test, dependency, or environment change invalidates/);
  assert.match(policy.advisor, /Never inherit stale, contradicted, or unverifiable evidence/);
  assert.match(policy.checker, /revision \(including uncommitted content\)/);
  assert.match(policy.checker, /a PASS summary alone is not proof/);
  assert.match(policy.checker, /assigned review claims from the full contract supplied for context/);
  assert.match(policy.checker, /every assigned claim with inspected or newly produced evidence/);
  assert.match(policy.checker, /Missing evidence remains unsatisfied/);
  assert.match(policy.contract, /Full contract context does not expand the assigned work/);
  assert.match(policy.contract, /Do not relabel inherited evidence as your own execution, or maker evidence as independent proof/);
  assert.match(policy.contract, /An unverified criterion is a failure you report/);
  assert.match(policy.contract, /not a mandatory schema/);
  assert.match(policy.advisor, /Assign delivery gates to an owner rather than every layer/);
  assert.match(policy.child, /Carry evidence forward only with its tested revision/);
  assert.match(policy.child, /rerun what a code, test, dependency, or environment change invalidates/);
  assert.match(policy.child, /Run the repository's actual merge or CI gates once for the delivered revision, with one owner/);
});

test("review stops on resolved claims and material risks, not test counts or a time target", () => {
  for (const name of ["advisor", "checker", "runtime"]) {
    assert.match(policy[name], /assigned claims and material risks are resolved with current evidence and no material contradiction remains/, name);
    assert.match(policy[name], /concrete gap or contradictory/, name);
  }
  assert.match(policy.advisor, /more possible tests or files alone do not justify continuing/);
  assert.match(policy.advisor, /Neither elapsed time nor absence of findings is proof/);
  assert.match(policy.checker, /elapsed time and absence of findings alone do not establish safety/);
  assert.match(policy.checker, /A genuine new risk may justify widening the investigation/);
  assert.match(policy.checker, /request a packet revision if it needs work outside your mandate/);
  assert.match(policy.runtime, /packet explicitly requires generated reference or mutation checks, run them/);
});

test("repair-first checkers close their own findings and delta review reuses the same reviewer", () => {
  assert.match(policy.advisor, /carry forward unaffected valid evidence/);
  assert.match(policy.advisor, /repair invalidates prior reasoning or leaves a named uncertainty/);
  assert.match(policy.advisor, /Review that delta first; expand only when the risk crosses its boundary/);
  assert.match(policy.advisor, /not merely because a file changed or a test once failed/);
  assert.match(policy.advisor, /Checkers are repair-first/);
  assert.match(policy.advisor, /Resume the same checker for a delta review of a maker's repair/);
  assert.match(policy.advisor, /Reassess a loop when another attempt would repeat the same strategy without new\s+information/);
  assert.match(policy.checker, /delta and its blast radius and rerun affected criteria/);
  assert.match(policy.checker, /no automatic checker-of-checker/);
  assert.match(policy.checker, /own the reviewed write surface/);
  assert.match(policy.checker, /explicit read-only instruction or immutable historical artifact limits you to findings/);
  assert.match(policy.checker, /a frozen baseline alone does not revoke repair authority/);
  assert.match(policy.checker, /only when the packet authorizes commits/);
  assert.match(policy.checker, /Repair every finding you can, in every round including declared repair rounds, at any severity, inside the surface you reviewed/);
  assert.match(policy.checker, /Three things you do not repair/);
  assert.match(policy.checker, /classify by behavioral effect, not filename/);
  assert.match(policy.checker, /Never weaken acceptance to make a rerun green/);
  assert.match(policy.checker, /High \| a violated criterion, or an unrepaired Medium-or-higher finding/);
  assert.match(policy.checker, /A repaired finding alone does not cause FAIL/);
  for (const [name, source] of Object.entries(policy)) {
    assert.doesNotMatch(source, /at most three findings in total|repair none of that class/, name);
  }
  assert.match(policy.readme, /checkers repair/i);
});

// Counterexample-oriented wording guards, not a semantic or live-behavior evaluator.
// Check each active surface independently and reject contradictory legacy absolutes,
// even if the correct rule also occurs elsewhere in the same policy.
test("checker repairs keep honest provenance without mandatory non-author closure", () => {
  const sources = { core: advisorCore, checker: policy.checker, evidence: advisorReferences.evidence, runtime: policy.runtime };
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /not independent review of that patch/, name);
    assert.match(source, /(?:does not|do not) automatically require|No material checker delta automatically requires/, name);
    assert.match(source, /project\/user (?:review )?(?:requirements|gates)/, name);
    assert.doesNotMatch(source, /Material checker-authored changes require a non-author|The checker's reruns alone cannot close it|advisor or another non-author closes a material checker delta/i, name);
    assert.doesNotMatch(source, /Independence is a property of (?:the|your) verdict, not of (?:the|your) keystrokes|has not compromised its review|does not compromise your review/, name);
  }
  assert.match(advisorReferences.graphs, /Preserve maker\/checker independence wherever independent review is required/);
  assert.match(advisorReferences.graphs, /PASS summary never establishes verification by itself/);
  assert.match(policy.checker, /journey-impact browser verification rule for your repairs/);
  assert.match(advisorCore, /No phase, risk tier, merged deliverable, or PR universally requires a harness checker/);
});

test("removed review quotas do not weaken completion or explicit user limits", () => {
  for (const [name, source] of Object.entries({ core: advisorCore, runtime: policy.runtime })) {
    assert.match(source, /all (?:acceptance )?criteria, required checks,? and safety obligations/, name);
    assert.match(source, /report what remains|report the unmet work/, name);
    assert.match(source, /[Uu]ser-set limits.*user approval to change/, name);
    assert.doesNotMatch(source, /binding user, graph, or runtime cap|Two serial review rounds/, name);
  }
  assert.match(advisorCore, /Never claim completion because a counter ran out/);
  assert.match(advisorCore, /Reassess a loop when another attempt would repeat the same strategy without new information/);
  assert.match(advisorReferences.graphs, /do not stop because a graph counter ran out/);
  assert.match(advisorReferences.graphs, /Explicit user limits remain binding/);
  assert.match(advisorReferences.graphs, /actual evidence needed before delivery or teardown/);
});

test("test and instruction changes inherit the controlled boundary's risk, not a filename exemption", () => {
  for (const [name, source] of Object.entries({ core: advisorCore, runtime: policy.runtime })) {
    assert.match(source, /behavioral effect, not filename or patch size/, name);
    assert.match(source, /can be Low only when runtime behavior, acceptance oracles, and enforcement semantics remain unchanged/, name);
    assert.match(source, /acceptance oracle, security gate, or safety-relevant instruction take the tier of the boundary they control/, name);
    assert.match(source, /cannot downgrade a High-risk effect/, name);
    assert.match(source, /highest applicable tier wins/, name);
    assert.doesNotMatch(source, /repairs are Low by rule/, name);
  }
  assert.match(policy.checker, /an oracle in `tests\/` is enforcement work, not a harmless test-only change/);
});

test("skill loading is decision-driven even when the advisor is not editing", () => {
  const sources = { core: advisorCore, transport: advisorReferences["transport-and-settlement"], runtime: policy.runtime };
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /repository skills merely to launch a worker/, name);
    assert.match(source, /planning, review, investigation, implementation, or recovery decision needs it/, name);
    assert.match(source, /you need not be editing code/, name);
    assert.match(source, /Required task and safety instructions still apply/, name);
    assert.match(source, /Reuse material already in context and keep additional reads bounded/, name);
    assert.doesNotMatch(source, /\bnever reads?\b[^.;]*\b(?:role skills?|worker contract|repository skills?)\b|repository skill only when you edit/i, name);
  }
});
