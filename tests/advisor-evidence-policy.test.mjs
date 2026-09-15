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
};
const collapse = (source) => source.replace(/\s+/g, " ");
const policy = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, collapse(await read(path))])));
// The advisor's policy is the injected core plus its references.
policy.advisor = collapse(
  [await read("skills/advisor/doctrine.md"), ...(await Promise.all(REFERENCES.map((name) => read(`skills/advisor/references/${name}.md`))))].join("\n\n"),
);

// Instruction-contract regressions only: these do not measure live compliance or latency.
test("prove-once handoffs retain per-claim outcomes, actual coverage, and distinct executions", () => {
  const { contract } = policy;
  assert.match(contract, /Record each distinct proof once with its producer, tested revision\/surface, command\/outcome, and limitations/);
  assert.match(contract, /Claims reference that proof instead of repeating it/);
  assert.match(contract, /Account for every assigned criterion and attribute the relevant evidence/);
  assert.match(contract, /One proof may support several criteria only when its coverage actually establishes each claim/);
  assert.match(contract, /Distinct executions retain separate outcomes and provenance even when the command is the same/);
  assert.match(contract, /Attribute inherited proof; never present it as a new execution or independent verification/);
  assert.match(policy.runtime, /one maker test run can support two claims when it actually tests both/);
  assert.match(policy.runtime, /independent rerun is a separate execution with its own provenance and outcome/);
});

test("linked artifacts preserve reproducible proof and cannot hide failures or limitations", () => {
  const { contract } = policy;
  assert.match(contract, /`result.md` is a concise handoff, not a transcript archive/);
  assert.match(contract, /Store bulk logs, probe source, full diffs, and repeated command output once in the run directory or reference an existing durable artifact/);
  assert.match(contract, /Keep the exact reproducible invocation and necessary probe source available through a precise path\/section locator/);
  assert.match(contract, /Keep failures, missing proof, material findings, and limitations visible in the handoff, not buried behind a link/);
  assert.match(contract, /If a separate artifact is unavailable or forbidden by the packet, include the necessary proof inline rather than omit it/);
  assert.match(contract, /Concision must not weaken criteria or lose reproducibility/);
  assert.match(policy.runtime, /A failing claim stays explicit even when its detailed log is linked/);
});

test("selective evidence reading removes blanket log consumption without skipping required context", () => {
  const { advisor, contract, builder } = policy;
  assert.match(contract, /Read the upstream claim\/evidence summaries relevant to your node, then inspect the linked proof needed for your assigned work/);
  assert.match(contract, /Required evidence and material contract\/threat context must still be read/);
  assert.match(contract, /Drill into source or raw output when coverage, provenance, a critical claim, or a contradiction needs resolving/);
  assert.match(contract, /Load every skill named under `REQUIRED SKILLS` before task work/);
  assert.match(builder, /Read required contract inputs and inspect linked proof relevant to your work; a packet summary alone is not proof/);
  assert.match(advisor, /Required evidence, critical or contested claims, uncertain coverage or provenance, and contradictions still require the underlying evidence/);
  assert.match(advisor, /Missing or inaccessible proof stays unsatisfied/);
  assert.match(advisor, /Keep required launch criteria and material boundaries explicit/);
  assert.match(advisor, /Read a worker result only when a claim needs inspection|summary is useful when it answers the question/);
  for (const [name, source] of Object.entries(policy)) {
    assert.doesNotMatch(source, /read every evidence path the packet links|read all linked (?:evidence files|logs)/i, name);
  }
});

test("advisor, maker, and checker handoffs reference evidence rather than recopying reports", () => {
  assert.match(policy.advisor, /worker results and your own workstream notes as concise evidence indexes, not duplicate archives/);
  assert.match(policy.advisor, /link supporting detail rather than pasting upstream reports into every packet/);
  assert.match(policy.builder, /Record exact command evidence once and reference it from each matching result Claim/);
  assert.match(policy.builder, /do not repeat the same invocation, output, or diff per claim/);
  assert.match(policy.child, /Carry forward attributable component evidence and rerun what integration invalidates/);
  assert.match(policy.contract, /Claims reference that proof instead of repeating it/);
  assert.match(policy.checker, /Record each proof and its provenance once, reference it from the claims it establishes/);
  assert.match(policy.checker, /Do not reproduce the maker's report, full probe programs, or complete logs in your result/);
  assert.match(policy.checker, /accessible linked artifacts under the worker contract's handoff rules/);
});

test("concise reports do not replace maker checks, independent proof, or honest failure", () => {
  assert.match(policy.contract, /Makers run the named checks and exercise the accepted behavior/);
  assert.match(policy.contract, /An unverified criterion is a failure you report/);
  assert.match(policy.builder, /run the named checks, exercise the behavior each criterion claims/);
  assert.match(policy.builder, /test that failure path with the project's normal tooling, and inspect your own diff/);
  assert.match(policy.child, /rerun what integration invalidates/);
  assert.match(policy.advisor, /Run the repository's actual merge or CI gates once for the delivered revision/);
  assert.match(policy.checker, /clearly identify what you ran versus reused/);
  assert.match(policy.checker, /Reject stale, contradicted, or unverifiable evidence; a PASS summary alone is not proof/);
  assert.match(policy.checker, /Missing evidence remains unsatisfied, not silently omitted from your verdict/);
  for (const name of ["advisor", "contract", "checker"]) {
    assert.match(policy[name], /Explicitly required independent checks must actually run/, name);
  }
  assert.match(policy.advisor, /A pending, unavailable or stale required verdict remains an unmet delivery gate/);
  assert.match(policy.checker, /Never weaken acceptance to make a rerun green/);
});

test("lean handoffs add no citation format, length quota, or settlement gate", () => {
  const { contract } = policy;
  assert.match(contract, /evidence locators and remaining risk/);
  assert.match(contract, /not a mandatory schema/);
  assert.match(contract, /missing or differently formatted summary does not prevent execution completion, notification or follow-up/);
  assert.match(contract, /If the task explicitly requests a report, producing it remains a deliverable/);
  assert.match(contract, /Keep the final response useful and concise: outcome, unresolved issue, and relevant artifact or evidence locators/);
  assert.match(contract, /Do not duplicate bulk logs/);
  assert.match(contract, /A summary assertion is not proof/);
  assert.match(policy.runtime, /This adds no citation syntax or length quota/);
});

test("obstacles and child ownership do not silently require an extra report file", () => {
  assert.match(policy.contract, /under `Deviations` in your chosen handoff/);
  assert.match(policy.contract, /under `Proposed criteria` in your chosen handoff/);
  assert.match(policy.contract, /references to `result.md` or named headings in this contract and role presets apply to your chosen handoff; they do not require an additional file/);
  assert.match(policy.contract, /If the task explicitly requests a report, producing it remains a deliverable/);
  assert.doesNotMatch(policy.contract, /under `(?:Deviations|Proposed criteria)` in `result\.md`/);
  assert.match(policy.child, /decisions, outstanding descendants, acceptance evidence and next steps in your recorded session or an assigned handoff\/checkpoint/);
  assert.match(policy.child, /`result.md` when a file is useful or explicitly requested/);
  assert.doesNotMatch(policy.child, /Use your assigned `result.md` as the operational checkpoint and final handoff/);
  assert.match(policy.advisor, /A scoped child uses its recorded session or assigned handoff\/checkpoint/);
  assert.match(policy.child, /Never write the parent's workstream file/);
});

test("journey-impact verification belongs to every author without blanket browser work", async () => {
  const native = collapse(await read("native-skills/advisor/references/worker-contract.md"));
  for (const [name, source] of Object.entries({ managed: policy.contract, native })) {
    assert.match(source, /builder implementation, checker repairs(?:,? and| and) direct advisor work/, name);
    assert.match(source, /actual diff and call\/data flow/, name);
    assert.match(source, /plausible (?:affected user journeys|consumers)/, name);
    assert.match(source, /every transitively reachable screen/, name);
    assert.match(source, /backend auth, API wiring/, name);
    assert.match(source, /real browser against the integrated changed application/, name);
    assert.match(source, /persona\/state and meaningful failure or edge path/, name);
    assert.match(source, /Reuse current project browser tests when they actually cover that flow/, name);
    assert.match(source, /screenshot.*(?:alone|do not).*prove/i, name);
    assert.match(source, /Internal changes.*(?:unit, API|unit, API or integration)/, name);
    assert.match(source, /Uncertain impact/, name);
    assert.match(source, /missing browser coverage and why/, name);
    assert.match(source, /dirty content|including dirty/, name);
    assert.match(source, /no mandatory manifest or screenshot quota/i, name);
    assert.match(source, /rerun (?:the )?affected flow/, name);
    assert.match(source, /A checker that edits is an author/, name);
    assert.match(source, /safe targets, credentials|safe targets, credentials, accessibility/, name);
  }
  assert.match(policy.builder, /worker contract's journey-impact browser verification rule/);
  assert.match(policy.checker, /journey-impact browser verification rule for your repairs/);
  assert.match(policy.child, /journey-impact browser rule to direct edits and integration/);
  assert.match(policy.advisor, /including checker repairs and direct advisor work/);
});

test("required external agentic review cannot be replaced or silently waived", async () => {
  const surfaces = [policy.advisor, policy.contract, await read("skills/advisor-stock-entry/SKILL.md"), await read("native-skills/advisor/references/worker-contract.md"), await read("native-skills/advisor/SKILL.md")].map(collapse);
  for (const source of surfaces) {
    assert.match(source, /agentic PR review/);
    assert.match(source, /pending, unavailable or stale|Pending, unavailable or stale/);
    assert.match(source, /(?:current PR revision|required PR verdict)/);
    assert.match(source, /local checker|local\s+checker/);
    assert.match(source, /green (?:test|deterministic)/);
    assert.match(source, /old(?:er)? (?:PR )?verdict/);
    assert.match(source, /scope and authorization/);
    assert.doesNotMatch(source, /High requires a designated independent checker/i);
  }
});
