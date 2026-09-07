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
};
const policy = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [
  name, (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\s+/g, " "),
])));

// Instruction-contract regressions only: these do not measure live compliance or latency.
test("prove-once handoffs retain per-claim outcomes, actual coverage, and distinct executions", () => {
  const { contract } = policy;
  assert.match(contract, /Record each distinct proof once with its producer, tested revision\/surface, command\/outcome, and limitations/);
  assert.match(contract, /Claims reference that proof instead of repeating it/);
  assert.match(contract, /Claims map one-to-one to the acceptance criteria, each with its outcome and a precise evidence reference/);
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
  assert.match(advisor, /Required evidence, critical or contested claims, uncertain coverage\/provenance, and contradictions still require the underlying evidence/);
  assert.match(advisor, /Missing or inaccessible proof stays unsatisfied/);
  assert.match(advisor, /Keep required launch criteria and material boundaries explicit/);
  for (const [name, source] of Object.entries(policy)) {
    assert.doesNotMatch(source, /read every evidence path the packet links|read all linked (?:evidence files|logs)/i, name);
  }
});

test("advisor, maker, and checker handoffs reference evidence rather than recopying reports", () => {
  assert.match(policy.advisor, /worker results and your own workstream notes as concise evidence indexes, not duplicate archives/);
  assert.match(policy.advisor, /link supporting detail rather than pasting upstream reports into every packet/);
  assert.match(policy.builder, /Record exact command evidence once and reference it from each matching result Claim/);
  assert.match(policy.builder, /do not repeat the same invocation, output, or diff per claim/);
  assert.match(policy.foreman, /Summarize your integration delta and cite component proof rather than copying helper reports/);
  assert.match(policy.checker, /Record each proof and its provenance once, reference it from the claims it establishes/);
  assert.match(policy.checker, /Do not reproduce the maker's report, full probe programs, or complete logs in your result/);
  assert.match(policy.checker, /accessible linked artifacts under the worker contract's handoff rules/);
});

test("concise reports do not replace maker checks, independent proof, or honest failure", () => {
  assert.match(policy.contract, /Makers run the named checks and exercise the accepted behavior/);
  assert.match(policy.contract, /An unverified criterion is a failure you report/);
  assert.match(policy.builder, /run the named checks, exercise the behavior each criterion claims/);
  assert.match(policy.builder, /test that failure path with the project's normal tooling, and inspect your own diff/);
  assert.match(policy.foreman, /Rerun what the integration changes or invalidates and run the packet's required final checks/);
  assert.match(policy.checker, /clearly identify what you ran versus reused/);
  assert.match(policy.checker, /Reject stale, contradicted, or unverifiable evidence; a PASS summary alone is not proof/);
  assert.match(policy.checker, /Missing evidence remains unsatisfied, not silently omitted from your verdict/);
  for (const name of ["advisor", "contract", "checker"]) {
    assert.match(policy[name], /Explicitly required independent checks must actually run/, name);
  }
  assert.match(policy.advisor, /High-risk boundaries receive independent review before completion/);
  assert.match(policy.checker, /Never weaken acceptance to make a rerun green/);
});

test("lean handoffs add no citation format, length quota, or settlement gate", () => {
  const { contract } = policy;
  assert.match(contract, /Use a short label or artifact locator as convenient; no particular citation syntax or report-length quota is required/);
  assert.match(contract, /no additional report schema is required/);
  assert.match(contract, /only a missing or blank result artifact stalls settlement/);
  assert.match(contract, /Missing, empty, or differently formatted sections are advisory notes for the parent, not settlement failures/);
  assert.match(contract, /Keep the final response short: overall outcome, material unresolved issue, and result path/);
  assert.match(contract, /Do not repeat the result's proof inventory in chat/);
  assert.match(contract, /An LLM statement or an uninspected summary is not evidence that a criterion passed/);
  assert.match(policy.runtime, /This adds no citation syntax or length quota/);
});
