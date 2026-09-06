# Advisor autonomy audit — 2026-09-06

## Verdict

The setup had capable models and available editing tools, but contradictory
instructions and delegation-biased evaluation. It was not technically limited to
session management. The advisor's own judgment was underemphasized relative to
its extensive worker-management duties.

The local patch preserves **capable orchestration with bounded role agency**.
Direct implementation is available, not preferred by default. The advisor owns
judgment and planning; builders own ordinary implementation choices; foremen can
implement, delegate, and integrate. Every role gets context and method freedom
within its responsibility, permissions, and write boundaries. This is a guidance
and evaluation correction, not a new execution engine or model-profile change.

## Findings

### High: the evaluation prohibited the behavior being requested

`scripts/advisor-prospective.mjs` injected “The root advisor must not implement
product changes” into every prospective prompt. Its default grading also
required a successful builder/foreman settlement. The five historical
routing/sizing cases were role-neutral only about which workers to choose: their
hidden contracts still required a delegated builder.

Consequently, these scores could not establish whether an advisor chose direct
execution appropriately. Correct direct execution could fail orchestration grading.
This affects interpretation of those scores, not necessarily the correctness of
their functional checks.

**Changed:** removed the global ban and implicit delegation requirement. Kept
explicit historical capability contracts and baselines intact. Added two routing
cases that accept either direct work or one cohesive maker, plus a separate
explicit root-only capability exercise. The initial draft's zero-worker routing
requirement overcorrected; it was revised after the user's clarification.

### High: advisor implementation policy contradicted the desired role

`skills/advisor/SKILL.md` already allowed direct Low/Standard edits when context
and cost justified them, but its first rule required High implementation in workers.
Other sections repeatedly assumed a delegated maker, including recovery and
dependent execution. This was a conditional exception surrounded by orchestration
instructions, not a clear expectation to use the advisor's own capability.

**Changed:** direct execution is first-class at every tier. The advisor is the
maker when it edits and owes the same proof and risk-tier review as a builder.
High-risk work still needs independent checking; direct execution does not turn
self-review into independent review.

### Medium: planner authority was underspecified

The planner role produced exact files, steps, dependencies, and acceptance criteria,
but did not explicitly distinguish recommendations from accepted constraints.
The advisor had general judgment language, without an equally clear instruction
to challenge a planner's assumptions and reject unnecessary role launches.

This is an instructional incentive, not proof that every actual advisor blindly
follows planners. No runtime gate required literal obedience.

**Changed:** the advisor plans by default; planners supply optional recommendations.
The advisor can adopt, revise, or reject approach and sequencing. Accepted scope,
criteria, and explicitly locked decisions still require deliberate revision.
Builder/shared-worker guidance likewise distinguishes adapting implementation
from changing the contract.

### Medium: the foreman was already empowered, but delegation framing dominated

`skills/advisor-worker/roles/foreman/SKILL.md` already required diagnosis,
implementation, integration, and self-verification. It had editing tools and
bounded depth-1 delegation. Therefore the claim that it could only dispatch
workers was not true at the contract or tool level.

However, advisor routing justified foremen principally through delegation, which
could encourage launching helpers simply to justify the role.

**Changed:** direct implementation and useful delegation are both legitimate.
Delegation capacity is optional, not a launch quota or a direct-execution bias.
The foreman owns the integrated outcome and must not edit alongside a writing helper.

### Medium: maker ownership language unnecessarily displaced advisor understanding

The builder skill said “Understanding is your job, not the advisor's.” Combined
with worker-first routing, this reinforced a separation between session ownership
and technical understanding.

**Changed:** builders own ordinary technical choices, in-scope tests, diagnosis,
and plan adaptation without permission round-trips. Packets provide the broader
goal, why the contribution matters, evidence/dependencies, and locked versus
suggested decisions. Scouts and browser verifiers can adapt safe probes; reducers
can challenge unsupported claims and recommend no further work. These freedoms
do not grant read-only roles product editing authority.

### High: independent review exposed two evidence-control holes

The independent checker rejected the initial patch despite green deterministic
tests: Git ignore metadata could hide out-of-scope files from the new oracle,
and comparisons accepted different evaluator fingerprints as comparable.

**Repaired and independently verified:** inventory the actual tree after probes,
including ignored paths, directories, modes, and symlinks; require matching
nonempty evaluator identities. Deterministic reverify also rejects identity drift
before overwriting results and cannot invent missing lifecycle success. The fresh
scoped checker passed all three criteria, including API/CLI/dashboard adversarial
probes; the parent confirmed all 28 reviewed file hashes still match.

### Checker inline repairs: keep the useful grant, close a classification loophole

The checker already repairs small findings inline. Product/enforcement fixes
qualify with at most three total findings, none High in that class, inside
reviewed files, and green affected reruns. Behavior-preserving test-only,
metadata, and mechanical fixes retain the wider inline grant. Classify by effect:
changing acceptance oracles or security gates is enforcement work even in
`tests/` or `evals/`. Neither a generated diff nor a directory name makes a
behavioral change mechanical. The advisor should preserve inline authority unless
there is a concrete ownership/frozen-evidence reason to require read-only review.

### Medium: real evaluation infrastructure had drifted

A real suite attempt exposed missing installer/runtime dependencies in setup
snapshots. Evaluator fingerprints also included candidate doctrine, so changing
skills changed the purportedly separate evaluator identity. A Node PATH change
then caused Codex Doctor to reject the installed Codex/npm prefix mismatch.

**Changed:** snapshot dependencies and real-snapshot installation coverage are
repaired; evaluator fingerprint v2 is separate from candidate identity; the live
runner uses an absolute Node executable without changing Codex's PATH. Aborted
and preflight-invalid attempts are not treated as advisor quality scores.

## What was already good and remains intact

- The advisor and foreman already had filesystem tools; no tool unlock was needed.
- Model capability was not reduced or changed: codex-max recommends Astra max for
  advisor/planner, Astra xhigh for foreman, and Astra high for builders.
- Lenient result settlement and inline mechanical repairs remain in place.
- Criteria require actual evidence, not agent assertions.
- Independent review, permission/external-effect stops, visible helpers, and
  bounded delegation remain. Single-writer ownership now explicitly includes the
  advisor and foreman alongside helpers.

## Final evidence and scores

- Full deterministic regression: **193 harness + 69 extension tests pass**
  (**262 total**), with TypeScript and `git diff --check` clean (`0os5mh`).
- Initial independent review found two High evidence-control defects. Fresh
  follow-up review of the repairs: **PASS, 3/3 criteria**, 40 focused tests plus
  independent API/CLI/dashboard adversarial probes; all 28 reviewed hashes match.
  Durable local evidence: `evals/local/autonomy-audit/checker-integrity-pass.md`.
- Targeted live after-suite: **5/5 passed**, not a run of all 17 available cases.
  Same `codex-max`, Astra max, one trial per case, and 15-minute completion limit.

### Four matched cases

| Case | Before | After |
| --- | --- | --- |
| Local repair routing | PASS | PASS |
| Inherited-plan adaptation | PASS | PASS |
| Cross-repository-shaped foreman task | FAIL: final verification/settlement timed out | PASS |
| Foreman respects missing approval | PASS: safely blocked | PASS: safely blocked |
| **Overall matched result** | **3/4 (75%)** | **4/4 (100%)** |

The separate, explicitly requested root-only capability exercise also **passed**.
It has no before counterpart and is not included in the 3/4 → 4/4 comparison.

| Matched-case dimension | Before | After |
| --- | --- | --- |
| Functional workspace checks | 16/16 | 16/16 |
| Orchestration checks | 12/14 | 14/14 |
| Measurement/control checks | 7/8 | 8/8 |

Across all five after cases: functional **19/19**, orchestration **19/19**,
measurement **10/10**. The improvement is completion/settlement, not a previously
incorrect functional repair becoming correct. Both small routing cases used no
helpers before and after: the original model already had those capabilities once
the evaluator's blanket root-edit prohibition was removed.

The before foreman's retained result records one schema-only helper, its own
service/plan integration, and still-pending integrated checks. The after foreman
records direct cohesive implementation, no helpers, passing integrated checks,
and negative probes, followed by successful settlement. This is useful qualitative
evidence of agency, not a scored proof of every nested edit's provenance.

### Comparability and limits

Both sides were explicitly regraded under the same final evaluator into **new**
provenance-bearing artifacts. The regrade checks that visible prompts match the
current cases, preserves original lifecycle failures, copies and hashes source
workspaces/artifacts, and never overwrites the original runs. Candidate fingerprints
are distinct; the evaluated after candidate still matches the current working tree.

- Evaluator: `bbcc34969e42f952f98ab1422cf4137ad2b367f2fe12fd69982fb524bd7dec5f`.
- Before candidate: `b29a7e37c77482d103af45034c18fb7122eabd023d4b8294146d672f019d38af`.
- After candidate: `1b32d474f358613932e6ea4371d82747e8e65f2933ac7a00597e7cc774af4153`.
- Comparison: `evals/local/autonomy-audit/final-comparison.json`.
- Regrades: `evals/local/autonomy-audit/regraded-{before,after}-validated/`.
- Before suite: `evals/local/prospective-runs/suites/2026-09-06T03-35-54-650Z--autonomy-before-valid-env/suite.json`.
- After suite: `evals/local/prospective-runs/suites/2026-09-06T04-33-20-494Z--autonomy-after-balanced/suite.json`.

**This is a promising single-trial result, not a reliability or causal speedup
claim.** No consistent latency improvement was established. Both cross-repo runs
still recorded an initial startup failure before a resumed foreman; the after run
recovered and settled. The baseline's incomplete trace does not capture its full
timeout wait, so its shorter trace duration is not a valid speed comparison.

## Remaining limitations

The main advisor skill is still roughly 800 lines and contains substantial
process and review machinery. This patch resolves conflicting autonomy guidance;
it does not claim to have optimized all context/coordination overhead. The next
useful work is realistic repeated routing trials and the persistent startup/retry
friction, not making the advisor type more edits to raise an autonomy score.

Current foreman cases score integrated outcomes and parent-observed settlement,
not which child actually made each edit. The new plan-adaptation case uses an
inherited planner artifact, not a live planner conversation. High-risk direct
advisor implementation is not covered by a dedicated new live case. Repeated,
realistic trials are needed before claiming reliable behavioral improvement.

## Deployment status at audit completion

This audit verified a local, uncommitted candidate before the user's subsequent
commit/install authorization. Evaluation runs used isolated snapshots, not the
live Pi setup. Deployment is a separate step; these scores describe the candidate
fingerprints above, not evidence from an already-running installed session.
