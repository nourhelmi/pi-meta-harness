import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const paths = {
  advisor: "skills/advisor/SKILL.md",
  contract: "skills/advisor-worker/references/WORKER_CONTRACT.md",
  builder: "skills/advisor-worker/roles/builder/SKILL.md",
  foreman: "skills/advisor-worker/roles/foreman/SKILL.md",
  checker: "skills/advisor-worker/roles/checker/SKILL.md",
  runtime: "docs/advisor-runtime.md",
  readme: "README.md",
};
const policy = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [
  name, (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\s+/g, " "),
])));

// These are instruction-contract regressions, not a claim about live model behavior.
test("review admission keeps maker proof and High independence without automatic stacked reviewers", () => {
  assert.match(policy.advisor, /maker proves every acceptance criterion, inspects its own diff/);
  assert.match(policy.builder, /run the named checks, exercise the behavior/);
  assert.match(policy.builder, /inspect your own diff/);
  assert.match(policy.advisor, /maker-owned fresh-context reviewer is not automatic on Standard or High/);
  assert.match(policy.builder, /helper is optional, not an automatic Standard\/High step/);
  assert.match(policy.foreman, /no automatic integrated fresh-review launch on Standard\/High/);
  assert.match(policy.advisor, /Do not stack it ahead of a planned independent checker covering the same purpose/);
  assert.match(policy.builder, /Do not stack a maker-owned reviewer ahead of a planned independent checker covering the same purpose/);
  assert.match(policy.foreman, /named distinct uncertainty, not duplicate the parent advisor's planned independent checker/);
  assert.match(policy.advisor, /High-risk boundaries receive independent review before completion/);
  assert.match(policy.advisor, /if unavailable, report the requirement as unsatisfied rather than relabeling maker review/);
  assert.match(policy.builder, /High still requires the parent advisor's designated independent checker/);
  assert.match(policy.foreman, /independent checker remains the parent advisor's responsibility when justified and is required for High/);
  assert.match(policy.advisor, /Low tier alone never earns a checker; explicit review requests still apply/);
});

test("optional review capacity retains delegation boundaries and needs a distinct review purpose", () => {
  assert.match(policy.builder, /at most one read-only review helper, not a launch quota or general delegation permission/);
  assert.match(policy.builder, /named material uncertainty/);
  assert.match(policy.builder, /Forbid editing, further delegation, or messaging any session/);
  assert.match(policy.builder, /supplemental maker evidence, never an independent checker verdict/);
  assert.match(policy.builder, /model and effort by the review need and live guide/);
  assert.match(policy.foreman, /Never launch a checker or present your own review as independent/);
  assert.match(policy.contract, /Every granted subagent inherits the full prohibition/);
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
  assert.match(policy.contract, /no additional report schema is required/);
  assert.match(policy.advisor, /Assign delivery gates to an owner rather than every layer/);
  assert.match(policy.foreman, /carry forward current component evidence with its provenance/);
  assert.match(policy.foreman, /integration changes or invalidates and run the packet's required final checks/);
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

test("delta closure preserves independent risk escalation and the existing inline repair safety envelope", () => {
  assert.match(policy.advisor, /carry forward unaffected valid evidence/);
  assert.match(policy.advisor, /repair invalidates prior independent reasoning or leaves material independent risk/);
  assert.match(policy.advisor, /Review that delta first; expand only when the risk crosses its boundary/);
  assert.match(policy.advisor, /not merely because a file changed or a test once failed/);
  assert.match(policy.checker, /delta and its blast radius and rerun affected criteria/);
  assert.match(policy.checker, /not a checker-of-checker/);
  assert.match(policy.checker, /own the reviewed write surface/);
  assert.match(policy.checker, /explicit read-only or frozen-revision packet limits you to findings/);
  assert.match(policy.checker, /at most three findings in total and no product or enforcement finding is High/);
  assert.match(policy.checker, /every fix stays inside files you already reviewed/);
  assert.match(policy.checker, /affected deterministic criteria rerun green/);
  assert.match(policy.checker, /If any product or enforcement finding exceeds these bounds, repair none of that class/);
  assert.match(policy.checker, /Classify by behavioral effect, not filename/);
  assert.match(policy.checker, /Never weaken acceptance to make a rerun green/);
  assert.match(policy.checker, /High \| a violated criterion, or an unrepaired Medium-or-higher finding/);
  assert.match(policy.checker, /A repaired finding never flips the verdict/);
});
