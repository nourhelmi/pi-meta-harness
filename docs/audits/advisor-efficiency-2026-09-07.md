# Advisor efficiency audit — 2026-09-07

Scope: why delegated work bounces between advisor, builders, and checkers,
whether the doctrine or the runtime causes it, and whether the evals would
notice. Evidence comes from the live advisor state under `~/.advisor/` (745
result artifacts across 15 state roots, 408 of them since 2026-09-01), the
canonical traces written since 2026-09-05 (95 runs, 624 events), the packets
and workstream files of the largest recent workstream, the installed doctrine
(identical to this checkout), the worker runtime, pi-detach, and the eval
suite. No live eval was run for this audit. Nothing in `skills/`, `config/`,
`extensions/`, or `evals/` was changed.

## Verdict

The feeling is correct and it is measurable. The harness is optimized for the
auditability of every handoff, not for the throughput of outcomes. The doctrine
already contains the right sentences about blockers, inline repair, and
convergence. They lose to more specific and more forceful instructions about
freezing, exactness, severity, and independence, and to the packets the advisor
writes under that pressure. Workers then do exactly what they are told: they
stop on obstacles a colleague would route around, and checkers report findings
they could have fixed in the same context.

Four mechanisms produce the ceremony:

1. **Obstacles are treated as blockers.** The doctrine defines Blocked as a
   missing decision, permission, credential, or external action, but gives
   workers no rule for environment or tooling obstacles, and the packets the
   advisor writes routinely forbid the workaround.
2. **The checker mandate excludes the findings that matter.** A violated
   criterion is by definition High, High is never repaired inline, and one High
   disables inline repair of every other product finding. The advisor's packets
   go further and declare any finding at any severity terminal.
3. **Risk tier collapsed to High.** Almost every launch is declared High, which
   makes the independent-checker route and the Medium FAIL bar the default,
   and the advisor adds a fresh checker after every repair even though the
   doctrine only asks for a delta review.
4. **The freeze vocabulary spread from criteria to procedure.** Packets freeze
   runtimes, tool versions, directory modes, hash manifests, and literal
   ordering. Workers obey the letter, and the letter is frequently wrong.

The evals cannot see any of this. They grade workspace outcome and role
compliance. Both checker cases require a read-only checker, the only blocked
case rewards blocking, no case contains an environment obstacle or a fixable
finding, and the deterministic tests are regular expressions over the doctrine
text.

## Evidence

### Real-world numbers

| Measure | Value | Source |
| --- | --- | --- |
| Result artifacts | 745 total, 408 since Sep 1 | `~/.advisor/*/runs` |
| Artifacts with a FAIL status | 126 | grep over result Status lines |
| Artifacts with a BLOCKED status | 20 | same |
| Artifacts with a `Repaired inline` section | 93 | same |
| Artifacts stating the contract forbade repair | 21 | same |
| Traced runs Sep 5 to Sep 7 | 95 launched, 87 done, 12 blocked, 1 stalled | canonical traces |
| Blocked events answered by a reply | 7 | `node.reply.sent` |
| Launches declared High tier | 88 of 95 | `node.launched.data.riskTier` |
| Launch role mix | 32 builder, 29 checker, 17 planner, 9 freeform, 4 scout, 2 browser, 2 foreman | same |
| Median worker duration | 18 minutes, p90 35 minutes | launched to settled |
| Blocked to reply latency | 4 to 15 minutes | `node.blocked` to `node.reply.sent` |
| Median launch prompt | 2.5k characters, 6 criteria | `run.created.data.goal` |

The 12 canonical blocked events, classified by what actually stopped the worker:

| Class | Count | Examples |
| --- | --- | --- |
| Harness or packet ceremony | 6 | pre-created zero-byte `result.md` contradicted "directory must be absent"; result directory mode 0755 instead of the packet's 0700; packet forbade retry after a closed stdin; driver "not frozen" before submission; pnpm 10.18.3 instead of 11.19.0 while the packet prohibited install, alternate runtime, and retry; builder blocked on a criterion that required a review only the parent could launch |
| Real product contradiction | 3 | title limit 240 versus 160 in the calendar path; a second SQL defect discovered during a test-only repair (recorded twice) |
| Credential or security boundary | 3 | migration dry-run consumed the only credential; native read confinement unresolved (twice) |

The advisor's own reply to the credential block says it was "NOT a
missing-user-permission blocker". So at least 7 of 12 blocks needed no human
and no product decision.

The 8 blocked artifacts outside the traced window follow the same pattern: a
checker refused to start because a named skill did not exist on disk; a builder
received the literal text `[paste #1 +12 lines]` as its task; a locked packet
told a builder to stop when `db:pull` regenerated unrelated files; a browser
verifier stopped on a database name mismatch; a dev-persona login returned 500.

### The Node architecture case

The "node binary is x64" obstacle appears in 28 result artifacts. Workers that
passed treated it as an environment note and used the arm64 Node that was
already installed, for example: "I used the active arm64 Node v25.2.1 runtime
for local Supabase and Vitest because the installed Node 22 runtime is x64 and
cannot load the required arm64 native packages. I record this as an environment
note." Workers that failed or blocked did so because their packet pinned the
runtime: "Required Node 22 verification could not start because the installed
Node v22.17.0 binary is x86_64". Same machine, same obstacle, opposite outcome,
decided by packet wording.

### One workstream in detail

`mobile-integration-p3` in the `a-couple-thing` state root is the largest
recent workstream and the clearest specimen.

| Measure | Value |
| --- | --- |
| Packets written | 114, average 124 lines, longest 657 lines |
| Packets declaring a tier | 17 High, 1 Low |
| Packets overriding the tiered FAIL bar with "any severity is terminal" | 18 |
| Packets forbidding install, retry, or an alternate runtime | 16 |
| Traced launches | 67 |
| Serial handoff gaps between launches | 65, median 4.4 minutes |
| Time inside gaps shorter than 30 minutes | 353 minutes |
| Worker time | 1445 minutes |

One slice, `s3c2c`, needed eight packets: build, repair 1, repair 2, repair 2
checker, repair 3, integrated review, final checker, commit. Each repair round
was followed by a fresh checker that found one more High race, and the
convergence log records that the maker "already consumed its exactly one
required same-family fresh-context review", so the maker's own reviewer was
not allowed to look again.

The Problems S1 sub-saga is worse. Between 2026-09-05 12:45 and 2026-09-06
15:47 the advisor launched 57 workers for one migration plus one hosted
integration test: 17 checkers, 17 planners, 15 builders, 8 freeform helpers,
5 of them blocked, over about 27 hours. Checkers failed on a TypeScript patch
version mismatch (6.0.2 versus 6.0.3), on `test ! -e` against a directory the
launcher had created, on unescaped backticks in a generated command, on a Low
finding about "frozen literal order" that the packet had made terminal, and on
a pnpm minor version. Every tooling error triggered a planner. The loop ended
with decision D117, written after you intervened: "Treat prior packets and
failures as evidence, not an immutable execution contract ... Remove redundant
version-output checks, repeated whole-tree/hash inventories, automatic
stop/replan after ordinary tooling errors, mandatory review after a zero-effect
metadata failure". After that decision the same advisor closed S1 with four
launches: builder 9 minutes, checker 17 minutes, builder 40 minutes, checker
11 minutes. The capability was there all along. The incentives were wrong.

### Checker verdicts

Of 25 sampled FAIL artifacts, 8 contain no High finding at all. Examples of
what still produced FAIL: "merge readiness is blocked by one documentation
finding"; "three actionable correctness or maintainability findings remain,
PASS is withheld"; "No High or Medium finding exists. The packet makes any
acceptance violation at any severity terminal, so the result is FAIL." Where
findings were High, the checkers say so plainly: "no checker repair commit
exists because the checker contract forbids inline repair of High-severity
product findings"; "Product findings were not repaired because both are HIGH."
One checker even reports repairing a stale comment because "the checker
contract required its inline repair even though the product verdict is FAIL".
The mandate lets checkers fix comments and forbids them from fixing the race
they just proved.

## First principles: what an efficient orchestrator is

Efficiency is verified outcome per unit of wall clock, tokens, and human
attention, under fixed correctness and safety constraints. Ceremony is any step
that produces no new information and retires no risk. From that definition:

1. **Decisions belong where the context is.** The worker standing in front of
   the obstacle knows more about it than the advisor ever will. Escalate only
   decisions that are irreversible, product-level, or cross a boundary the
   worker does not own. Everything else is resolved locally and reported as a
   deviation for post-hoc review, which is cheaper than pre-approval because
   most deviations are accepted.
2. **Independence is a property of the verdict, not of the keystrokes.** A
   checker that repairs the defect it found has not compromised its review. The
   review found the defect. What needs independence afterwards is bounded: a
   rerun of the affected criteria and a read of the small patch. The doctrine
   already accepts exactly that closure for "small" findings; the size cutoff
   is arbitrary.
3. **The unit of cost is the handoff, not the worker.** Each handoff costs the
   advisor a packet, the worker several minutes of re-onboarding, and both a
   settlement. In the sampled workstream the median gap is over four minutes
   and the median worker runs eighteen, so serial handoffs alone consume about
   a fifth of wall clock before counting re-reading inside the worker.
4. **Freeze the contract, never the procedure.** Criteria, safety boundaries,
   and the write surface may be frozen. Tool versions, directory modes,
   retry counts, hash manifests, and literal command order may not, unless the
   repository itself enforces them.
5. **Severity is consequence; tier is the change.** A violated criterion takes
   the severity of its consequence. A formatting fix inside a High workstream
   is a Low change.
6. **Loops must converge by construction.** A repair is reviewed as a delta by
   the reviewer who already holds the context, rounds are capped, and the cap
   ends in "ship with disclosed residual" or "ask the user", never in another
   planner.
7. **Measure the process, not only the outcome.** Blocked events, replies,
   repair rounds, launches per delivered criterion, and handoff gaps are the
   efficiency signal. The canonical trace already records all of them.

## Findings

### F1 High: workers are told to stop on obstacles, and packets forbid the workaround

The runtime contract injected into every Pi worker says "Stop and report
Blocked when a missing product decision, permission, credential, or external
action prevents the anchor" (`extensions/advisor-worker.ts`, `workerContract`).
The worker contract adds "Stop as `Blocked` instead of inventing a missing
product decision, permission, credential, or fallback"
(`skills/advisor-worker/references/WORKER_CONTRACT.md:52`). The builder skill
says "do not add fallback behavior". The Sol character in `codex-max` says it
"stops and escalates rather than deciding product, architecture, schema,
migration, auth, fallback, destructive behavior, or external effects". The
word "fallback" appears in every stop list and an environment workaround reads
as one. A grep of the advisor skill, worker contract, and role skills for
environment, tooling, toolchain, runtime version, install, or workaround finds
no guidance at all.

The advisor fills that gap with prohibitions. Sixteen packets in one workstream
forbid install, retry, or an alternate runtime. The pnpm block records the
result: "The packet says that a wrong runtime stops this packet and prohibits
install, alternate-runtime selection, and retry. The selected test did not
run." The trace vocabulary cannot even express what should have happened: the
blocked request kinds are decision, permission, credential, and
external-action. There is no "resolved with deviation".

### F2 High: the checker mandate excludes the findings that matter

`skills/advisor-worker/roles/checker/SKILL.md` defines High as a finding that
"violates a risk invariant, an acceptance criterion, or a security, data,
money, auth, or destructive boundary". Any violated criterion is therefore
High. Product findings qualify for inline repair only when there are "at most
three findings in total and no product or enforcement finding is High", and
"If any product or enforcement finding exceeds these bounds, repair none of
that class and report them all" (lines 92 to 106). So a checker that finds one
real defect must return FAIL, the advisor must write a repair packet, resume or
launch a maker, and then launch another checker. That is the four-launch loop
the `s3c2c` slice ran three times. Twenty-one artifacts say in their own words
that the contract forbade the fix.

### F3 High: the freeze vocabulary spread from criteria to procedure

The advisor skill freezes criteria (`skills/advisor/SKILL.md:68`), defines
locked execution packets (line 354), and freezes the reviewed surface for
review (line 616). The worker contract calls criteria immutable (line 22). The
checker skill says "Never weaken acceptance to make a rerun green" (line 93).
None of those sentences is wrong. Together they produce packets whose launch
text begins "Execute the frozen packet exactly", "Execute this frozen
hash-locked hosted continuation exactly", and packets that pin SHA-256
manifests of 46 files, directory mode 0700, pnpm 11.19.0, TypeScript 6.0.2,
and the literal order of two reads. Workers at xhigh reasoning then enforce
those pins and fail on 6.0.3, 0755, and a placeholder file. The doctrine has a
tiered FAIL bar; 18 packets replaced it with "any acceptance violation at any
severity is terminal FAIL".

### F4 High: risk tier collapsed to High and every repair gets a fresh checker

88 of 95 traced launches and 17 of 18 tiered packets declare High. Planners,
scouts, and formatting repairs inherit the workstream's tier. High makes the
designated independent checker mandatory and sets the FAIL bar at Medium. The
advisor skill says a fresh checker is needed "only when the repair invalidates
prior independent reasoning or leaves material independent risk; use a scoped
delta review before a whole re-review" (Checker economy, item 4), yet the
workstream decisions read "Require one new fresh adversarial full-harness
checker rather than reusing the first checker" (D46), and the same sentence
recurs at D44, D51, D54. Each fresh checker re-reads the whole candidate and
finds one more thing.

### F5 Medium: planners are launched for tooling errors

The advisor skill says "Plan the work yourself by default". The Problems S1
saga launched 17 planners at Astra max, almost all named "replan" and each
following a tooling error, a version mismatch, or a checker failing on its own
harness. A planner cannot fix a shell quoting error. It writes a longer packet.

### F6 Medium: handoff overhead is large and unmeasured

Blocked-to-reply latency is 4 to 15 minutes. Replies instruct the worker to
"read the revision packet completely and verify its SHA-256". Serial gaps
under 30 minutes sum to 353 minutes in one workstream against 1445 minutes of
worker time. None of this appears in any report, dashboard, or eval.

### F7 High: the evals cannot observe any of this

What the prospective suite grades: workspace outcome, completion signal, root
trajectory presence, lifecycle validity, required delegation, allowed roles,
successful-worker ceiling, graph-plan ceiling, user-question ceiling, and
maker-before-checker order (`scripts/advisor-prospective-results.mjs`). Wall
time, root token usage, and width utilization are recorded as diagnostics.

What it does not observe: worker blocked events, replies and resumes, repair
rounds, launches per delivered criterion, checker inline-repair rate, packet
size, or recorded deviations, even though the canonical trace carries the
first four.

What the cases reward: `false-fail-review` and `scoped-recheck` both say "Do
not modify the workspace", so the only two checker cases require a read-only
checker. `foreman-blocked-decision` rewards a blocked outcome for a genuinely
missing approval, which is correct, but it is the only blocked case and there
is no mirror case where an obstacle must be routed around. No case plants a
fixable finding. No case contains an environment obstacle. `criteria-revision`
and `safety-redirect` prescribe a planner for a decision already written in a
file. Nine of eighteen cases are capability cases that prescribe the role
chain, so the suite's centre of gravity is compliance with a chain, not the
cost of the chain.

The full-current-realistic suite from 2026-09-06 passed 18 of 18 with a median
attempt of about 14 minutes. That is a real result, and it is compatible with
everything above: the cases are small, the obstacles are absent, and the
chains are prescribed.

The deterministic tests (`tests/advisor-doctrine.test.mjs`,
`tests/advisor-review-policy.test.mjs`) assert phrases in the skill files. They
would pass unchanged if every packet in production said "any severity is
terminal". The Harbor rubric has an `efficiencyParallelism` criterion, but it
judges recorded trajectories that do not change when the setup changes.

### F8 Medium: runtime friction manufactures blocks

- pi-detach reserves the native result artifact as a zero-byte file before
  launch (`src/tools/bg-agent.ts`, `reserveResultArtifact`). The advisor did
  not know this, wrote "the directory must be absent or empty" and "mode
  0700", and lost two blocked settlements, two checker FAILs, and two packet
  revisions (D80, D86, D92) to it.
- A named required skill that is missing on disk makes a checker refuse to
  start and settle Blocked without reviewing anything.
- A builder once received `[paste #1 +12 lines]` as its whole task and
  correctly blocked.
- Native packets carry `TURN CAP: N` as plain text
  (`src/agent-profiles.ts`, `rolePrompt`). The advisor now passes 30 and 50
  as if the number bounded tool turns. For Pi workers the cap is advisory too:
  worker manifests record foremen at 7 of 6 and 9 of 6 cycles.
- A resumed Pi worker keeps its context; a resumed native worker keeps its
  interactive pane. Both are fine. The cost is in the reply text, which asks
  the worker to re-read and re-hash the packet.

## What is already right

- The Verdict hygiene section says Blocked is "a missing product decision,
  permission, credential, or external action only" and that mechanical
  findings never bind a verdict.
- The inline-repair mandate exists, checkers use it 93 times, and the doctrine
  says its closure is "deterministic criterion reruns and the next natural
  gate, not a dedicated fresh checker".
- Convergence judgment asks for a changed strategy before every retry.
- Transport recovery distinguishes a failed launch from a wrong route.
- After D117 the advisor delivered in four launches what had taken 57. The
  models and tools do not need to change.

## Recommendations

Not applied in this audit. Ordered by expected effect on round trips.

### R1. Separate obstacles from blockers

Add one short section to the worker contract, the builder, checker, foreman,
and browser-verifier skills, and the injected runtime contract: an obstacle is
anything that stands between the worker and its criteria that is not a
product decision, a permission, a credential, or an external effect. Examples:
a wrong tool version, a binary for the wrong architecture, a missing optional
dependency, a pre-existing failing check on an unchanged file, a misnamed
skill, a flaky upstream in a test. The worker resolves an obstacle with the
least invasive local means, keeps working, and records it under a new
`Deviations` heading in `result.md` with what it changed and why. Blocked
remains reserved for the four kinds, and only after the worker has spent a
bounded attempt on self-unblocking. Drop the word "fallback" from the stop
lists or qualify it as product fallback behavior. Add a `deviation` request
kind, or a `node.deviation` event, to the canonical trace so the advisor and
the surfaces can see it.

### R2. Make the checker repair-first

Invert the mandate. A checker repairs every finding it can inside the reviewed
surface, at any severity, unless the fix needs a product decision, changes
schema or migration semantics, or has an external effect. The verdict describes
the post-repair state. Each repair is listed with its rerun evidence. The
advisor closes small repairs with a diff read and criterion rerun, exactly as
today. For High tier, when the checker's patch is itself nontrivial, resume the
original maker for a bounded delta read of that patch rather than launching a
fresh full checker. Redefine High as consequence: a violated criterion takes the
severity of what it breaks. Delete "repair none of that class and report them
all".

### R3. Put the packet on a diet

Add a packet template with a hard length cap and two lists. May be frozen:
acceptance criteria, safety boundaries, write surface, locked product
decisions. May not be frozen: tool versions unless the repository's engines
field or lockfile enforces them, directory modes, retry counts, hash manifests
outside a release gate, literal command order, "any severity is terminal".
Replace "Execute the frozen packet exactly" with the goal, the invariants, and
the evidence paths. Ask the doctrine test to reject the forbidden phrases in
the advisor skill's own packet guidance.

### R4. Tier the change, default Standard

A packet's tier comes from what the packet touches, not from the workstream.
Formatting, test-only, docs, and metadata repairs are Low by rule. Standard is
the default when no High surface is named. Record the tier's reason in one
line. This alone removes the mandatory checker from most repair rounds.

### R5. Converge with the same reviewer

For a repair round, resume the checker that found the finding with
`keepAlive` and ask for a delta review. Launch a fresh checker only when the
repair changed the reasoning the first review relied on. Cap serial review
rounds per slice at two, and make the cap terminal: ship with a disclosed
residual, or ask the user with a recommended default. Never let the cap resolve
into another planner.

### R6. Planners only for invalidated direction

A planner is launched when product or architecture direction is invalidated,
never after a tooling, environment, harness, or formatting failure. Those go
back to the same worker as an obstacle under R1.

### R7. Fix the runtime friction

- Have the native launcher append one sentence to the packet: the result path
  already exists as an empty file with the launcher's default modes.
- Treat a missing required skill as a Deviations note, not a block.
- Reject a launch whose prompt contains an unexpanded paste placeholder.
- Either make `maxTurns` mean something for native workers or stop printing
  `TURN CAP` into native packets.

### R8. Make the evals see the process

1. **Process metrics in every result.** Derive from the canonical trace and
   the settlement records: launches, blocked settlements, replies, resumes,
   repair rounds, launches per passed criterion, and serial gap minutes.
   Report them in `result.json` dimensions, suite summaries, comparisons, and
   the dashboard. Diagnostic first; thresholds once baselines exist.
2. **`builder-environment-obstacle`.** A workspace whose `npm test` fails on
   an unchanged environment obstacle with a legitimate local workaround, for
   example a script that demands a tool version the repository does not pin
   while an equivalent installed tool works. The hidden verifier requires
   completion, no blocked settlement, and a Deviations entry.
3. **`checker-repairs-inline`.** A completed diff with one planted High and
   two planted Medium findings inside the reviewed files. The verifier
   requires a PASS-after-repair settlement, green public checks, and no second
   maker launch.
4. **`repair-loop-convergence`.** A defect that needs one repair round after
   review. The verifier caps total launches and requires the second review to
   be a resume of the first checker, not a fresh launch.
5. **A Harbor calibration task from the Problems S1 trace**, normalized under
   the existing privacy boundary, rewarding the judgment recorded in D117:
   treat tooling errors as obstacles, drop hash inventories, reuse the
   reviewer, and ship.
6. **Doctrine tests** that assert the obstacle definition exists, that the
   checker skill no longer contains "repair none of that class", and that the
   advisor skill forbids the packet phrases in R3.

## Expected effect

Counterfactual on the Problems S1 saga under R1, R2, R4, and R5: the pnpm,
placeholder, stdin, and driver blocks disappear as blocks; the Low formatting
and literal-order FAILs become inline repairs; the seventeen planners reduce
to the two that followed real product findings; the fresh checker per round
becomes a resumed delta review. That is on the order of ten launches instead
of 57. This is an estimate from the recorded decisions, not a measurement, and
the only way to make it one is R8.

## Limits of this audit

Severity counts come from word matches inside artifacts and are approximate.
Traces cover three days; the older evidence is artifact-only. The correlation
between Sol at xhigh and literal-minded FAILs is real in the sample but the
packets those checkers received were themselves literal, so no model
attribution is made. No live eval was run. The recommendations change
doctrine, one launcher message, and the eval suite; they do not change models
or transports.

## Part 2 — Context and token efficiency

Added the same day after the question: is reloading skills after a compaction
necessary, and why does context sit at about 38% immediately after one?

Evidence: two real advisor sessions from the `a-couple-thing` state root,
read from their Pi session files. Session A is the Sep 6 owner of
`mobile-integration-p3` on Astra (700 assistant turns, 9 compactions).
Session B is the Sep 4 predecessor (1959 turns, 28 compactions). Token
figures come from Pi's recorded usage per assistant message; file sizes are
bytes divided by four.

### Verdict

Skill reloading is real but secondary, and most of it is unnecessary. The
38% floor after a compaction is produced by three other things: the Codex
native compaction keeps up to 64k tokens of the most recent user-role
messages verbatim, and pi-detach delivers every worker settlement notice as a
user-role message with up to 120 lines of pane tail, so the retained budget
fills with old notices; the system prompt costs about 33k tokens on every
turn, most of it tool schemas; and the advisor re-reads its own state files
and worker results in the first turns after every compaction. Engram adds a
mandatory memory protocol that consumed 12% of all assistant turns in
session A and was almost never read back.

### What every turn carries

| Item | Tokens | Measured how |
| --- | --- | --- |
| System prompt, a-couple-thing | 33k | first-turn input minus the first message |
| System prompt, pi-meta-harness | 27k to 29k | same |
| System prompt, ai-tutor | 38k to 39k | same; its `AGENTS.md` alone is 8.4k |
| Engram protocol inside the system prompt | 0.6k | `MEMORY_INSTRUCTIONS` literal |
| Advisor doctrine when read | 13.2k plus about 1k of hashline prefixes, in two reads because the 52 KB file exceeds the 50 KB tool-output cap | file size and session reads |
| Intelligence guide when read | 1.2k | file size |
| Workstream file when read | about 10k | 402 lines |
| Mean context per turn, session A | 170k | usage sum over 700 turns |
| Mean context per turn, session B | 182k | usage sum over 1959 turns |
| Session cost | $191 (A), $323 (B); cache reads are 60% of it | Pi cost fields |

Compaction triggers at about 257k tokens in every case, which is Pi's default
of window minus 16,384. The doctrine's instruction to compact at 60% was never
followed: session A contains zero manual compactions, and the model cannot see
its own context usage.

### What survives a compaction

The `pi-codex-compaction` package replaces history with the encrypted
compaction item plus the most recent user-role items up to
`RETAINED_USER_TOKEN_BUDGET`, which is 64,000 tokens
(`native-compaction.ts`, `retainRecentUserMessages`). pi-detach delivers
settlement notices through `pi.sendMessage` as custom messages with
`display: true` and a tail of up to 120 lines (`notify.ts`, `TAIL_ON_AGENT`),
and the Codex transport sends those as user-role items. The last compaction of
session A retained 63 items: 51 `[detach]` notices worth about 51k tokens and
11 messages from you worth about 1k.

| Session | Floor after compaction 1 | Floor after the last compaction |
| --- | --- | --- |
| A | 47k | 98k |
| B | 59k | 108k, flat from compaction 4 once the 64k budget was full |

A floor of about 100k on a 272k window is the 38%. Roughly 33k of it is the
system prompt, about 60k is retained notices plus the encrypted item, and the
rest is whatever was read in the first turn.

### What gets re-read in the first 15 turns after a compaction

Session A, tokens returned by reads, per compaction window:

| Window | Total | Largest categories |
| --- | --- | --- |
| 1 | 46k | repository 15k, advisor state 11k, workstream 11k, doctrine 7k |
| 2 | 55k | workstream 15k, doctrine 12k, results 6k, session file 4k |
| 4 | 64k | results 24k, doctrine 13k, workstream 11k |
| 5 | 75k | repository skills 26k, doctrine 14k, workstream 11k, packets 7k |
| 8 | 39k | doctrine 13k, packets 6k, workstream 6k, session file 4k |
| 9 | 48k | workstream 18k, doctrine 13k, session file 5k |

The doctrine was re-read in six of nine windows, the guide in most, role skills
in two. Engram's recovery notice orders `mem_session_summary` as the first
action after every compaction, and `mem_context` followed in every window.

### Whole-session reads and writes, session A

| What | Reads | Tokens returned |
| --- | --- | --- |
| Worker `result.md` files | 32 | 130k |
| Workstream file | 33 full, 86 including partial | 114k to 144k |
| Advisor doctrine | 14 to 16 | 104k to 106k |
| Intelligence guide | 24 | 30k |
| Session file | 9 | 16k |
| Role skills and worker contract | 12 | 16k |
| Repository skills the advisor never applied | 7 | 16k |
| `mem_context` | 12 | 27k |

Turn accounting: 1149 tool calls, 436 of them reads. 82 turns (12%) called
only memory tools: 50 `mem_save`, 30 `mem_session_summary`, 12
`mem_context`, against 4 `mem_search` and 1 `mem_get_observation`. Of 155
edit and write calls, 146 targeted advisor state (workstream 38, session file
27, packets and specs 24, other state 55, events 2) and 9 targeted the
repository.

### Was loading the checker skill before launching a checker necessary?

No. pi-detach prepends "Load and follow the advisor-role-checker skill at
<path>" to every role packet and the worker runtime injects the contract, so
the worker loads its own mandate. The advisor's doctrine already summarizes
the mandate in Checker economy. Each such read cost about 1.2k tokens and one
turn; session A did it eight times for role skills and four for the worker
contract. It happens because the packets restate the mandate ("Bounded inline
repair ONLY if ≤3 findings, none High"), which is itself a symptom of F3.

### Findings

**F9 High: settlement notices are retained across compactions.** The 64k
retention budget is filled by `[detach]` notices with pane tails. This is the
single largest contributor to the post-compaction floor and it grows with
every launch.

**F10 High: the doctrine is loaded the expensive way.** The bootstrap
(`advisor-session.ts`, `advisorContinuation`; `skills/advisor-native/SKILL.md`)
orders a `read` of the full doctrine, which the 50 KB output cap splits into
two calls with hashline prefixes. The same extension already knows how to
inject the live doctrine into the system prompt (`withLiveAdvisorDoctrine`)
but only does so on session resume, and only when the restored skill text
differs, which in native sessions is always, so a resumed session carries the
doctrine twice. After an in-session compaction nothing injects it, the
retained bootstrap message still says "read it completely", and the model
obeys.

**F11 Medium: instructions that mandate repeated reads.** "Re-read the live
guide before each launch" (`skills/advisor/SKILL.md:184`) produced 24 guide
reads. "Load every routed project skill before edits" made an orchestrator
that wrote nine repository edits read `backend-development` six times.

**F12 Medium: the workstream file is the memory but has no hot section.**
It is a 402-line ledger with 149 decisions, re-read whole after every
compaction and often between. `advisor_session_init` returns only paths.

**F13 Medium: Engram's protocol competes with the workstream file.** Its
instructions are "mandatory", its recovery notice preempts the first turn
after every compaction, and its write-to-read ratio in session A was 92 to 5.

**F14 Medium: the fixed tool surface is large.** About sixty tools are
registered in every advisor session, including nineteen `mem_*` tools, six
routine tools that the doctrine forbids in advisor sessions, three goal tools,
and the pi-lens extras. Pi exposes `setActiveTools` and `getActiveTools`, and
pi-lens already uses them for situational tools. The tool-schema share of the
33k system prompt was not measured directly; the spread between repositories
(27k to 39k) is explained by `AGENTS.md` and project skills, which bounds the
tools plus base prompt at roughly 25k.

### Recommendations

**R9. Shrink and relocate the notices.** A settlement notice should carry the
header line, the result Status, and the result path. Include a tail only for
blocked, failed, and stalled settlements, and point to `bg_output` otherwise.
In pi-detach this is `TAIL_ON_AGENT` and the `agentFinished` builder. In
addition, lower the compaction retention budget or exclude custom messages
from retention; `retainRecentUserMessages` only checks the role, so a marker on
detach messages plus a filter would do it. Either change alone cuts the
post-compaction floor by tens of thousands of tokens.

**R10. Put the doctrine core in the system prompt for the whole session.**
Use the existing `before_agent_start` hook for every advisor session, not
only resumed ones, and remove the "read it completely" bootstrap and the
duplicate injection on resume. Then split the skill: a core of roughly 3k to
4k tokens (non-negotiables, routing decision tree, packet template, verdict
hygiene, state convention, blocked versus obstacle) stays in the prompt, and
the rest becomes reference files loaded when the situation arises: graphing,
evidence delivery, rebase policy, browser preflight, freeform workers,
intelligence-guide details, transport recovery, routines. Also inject the
active guide's recommendation table (1.2k) and refresh it only on a profile
switch; delete "re-read before each launch".

**R11. Never read role skills or repository skills from the advisor.** The
worker loads its role skill from the packet path. Repository skills are read
only when the advisor itself edits repository code.

**R12. Give the workstream file a hot section and return it automatically.**
The first sixty lines hold Goal, Current state, active runs, open decisions,
and Next. The rest is an appendix read by offset when needed.
`advisor_session_init` returns the hot section inline, and a
`session_compact` hook returns it again after every compaction, the way
Engram returns its recovery notice, so no read call is needed to re-orient.

**R13. Make Engram passive in advisor sessions.** Disable its mandatory save
protocol and recovery instruction for sessions that own a workstream file;
keep `mem_search` available and save one session summary at handoff. This
removes about 80 turns per long session.

**R14. Trim the active tool set for advisor sessions.** Use `setActiveTools`
in the advisor-session extension to drop routines, goal tools, all but two or
three memory tools, and situational pi-lens tools. Measure the system prompt
before and after with the first-turn input figure.

**R15. Bound worker results for handoff.** Results of 100 KB were read whole.
Have the settlement notice carry Status and Claims, keep detailed evidence in
linked files as the contract already says, and let the advisor read a result
only when a claim needs inspection.

### Expected effect

With R9, R10, R12, R13, and R14 the floor after a compaction should fall from
about 100k to roughly 45k to 50k tokens, re-orientation after a compaction
from 40k to 75k down to about 10k, and memory-only turns from 82 to a handful.
Mean context per turn would drop by 40k to 60k, which is most of the cache-read
cost. These are estimates from the measured composition, not measurements.
The first-turn input figure and the post-compaction floor are the two numbers
to track; both can be read from the session file without any new tooling.

## Part 3 — Consolidated change list

Everything Parts 1 and 2 imply, grouped by the file or component that
changes. Status as of the same day: items 1 to 25 and 28 to 36 are applied on branch
`feat/efficient-orchestration` (harness) and local `main` of pi-detach; the
Harbor task (34) is not yet written; 26, 27, 37, and 38 remain open. Item 39
was found while delivering and is applied in pi-detach.

### Doctrine: `skills/advisor/SKILL.md`

1. Split into a core and references. The core, targeted at 3k to 4k tokens,
   keeps the non-negotiables condensed, adaptive topology in short form, the
   delegation decision tree, the packet template, risk tiers, verdict hygiene
   with the obstacle rule, checker economy in short form, the state
   convention, and session start. Move to `skills/advisor/references/`:
   information-value graphing, foreman delegation, freeform workers, locked
   execution packets, transport recovery, convergence judgment, evidence
   proportionality, verification ownership detail, evidence delivery, rebase
   policy, settlement ground truth, status updates, routines, context budget.
   The installer copies the whole `skills/advisor` directory, so references
   install with it.
2. Delete the model-specific routing text (the frontend routing paragraphs,
   the Fable, Opus, and Astra capacity notes, "For non-UX work, normally
   pick") and point to the live guide instead. Update the doctrine test that
   asserts those phrases.
3. Delete "Re-read the live guide before each launch" and the session-start
   file reads. State that the doctrine core and the active guide are in the
   system prompt.
4. Add the obstacle rule to Verdict hygiene: an obstacle is anything between
   the worker and its criteria that is not a decision, permission,
   credential, or external effect. Resolve it with the least invasive local
   means, including selecting or installing a toolchain the repository pins,
   record it under Deviations, and reserve Blocked for the four kinds after a
   bounded self-unblock attempt.
5. Add a packet template with a length cap and two lists. May be frozen:
   criteria, safety boundaries, write surface, locked product decisions. May
   not be frozen: tool versions unless the repository pins them, directory
   modes, retry counts, hash manifests outside a release gate, literal command
   order, "any severity is terminal", "no retry", "no install or alternate
   runtime". Replace "Execute the frozen packet exactly" with goal,
   invariants, and evidence paths.
6. Tier the change, not the workstream. Standard by default; formatting,
   test-only, docs, and metadata repairs are Low by rule; one-line reason.
7. Convergence: resume the same checker with `keepAlive` for a delta review;
   fresh checker only when the repair invalidated its reasoning; two rounds
   per slice, then ship with a disclosed residual or ask the user; never a
   planner from a cap; planners only for invalidated direction.
8. Update checker economy item 5 and the `keepAlive` guidance for the
   repair-first checker and for kept-alive checkers.
9. Reading rules: never read role skills or the worker contract; read
   repository skills only when the advisor edits repository code; read the
   workstream hot section, not the whole file; read a worker result only
   when a claim needs inspection. Drop "compact at 60%".
10. Trim bookkeeping: one line per cycle in the convergence log, decisions
    recorded only when material.

### Bootstrap skills: `skills/advisor-native/SKILL.md`, `skills/advisor-pi/SKILL.md`

 1. Remove the two mandatory `read` calls. Keep `advisor_session_init` first
    and the harness rule.

### Worker contract and roles: `skills/advisor-worker/**`

 1. Worker contract: add the obstacle item; drop "fallback" from item 7 or
    qualify it as product fallback; add `Deviations` to the result headings;
    a missing named skill is a Deviations note, not a block.
 2. Builder: qualify "do not add fallback behavior" as product fallback; add
    the obstacle paragraph; limit the locked-packet stop list to product,
    architecture, schema, migration, auth, destructive, and external
    decisions.
 3. Checker: repair-first at any severity inside the reviewed surface unless
    the fix needs a product decision, changes schema or migration semantics,
    or has an external effect; verdict on the post-repair state; delete
    "repair none of that class and report them all"; define High by
    consequence.
 4. Foreman and browser verifier: same obstacle rule; the browser verifier
    tries the documented local setup before blocking on environment.

### Runtime: `extensions/advisor-worker.ts`, `extensions/advisor-session.ts`, `extensions/advisor-pi-host.ts`

 1. Worker runtime contract text: obstacle sentence and Deviations heading.
 2. Inject the doctrine core and the active guide into the system prompt for
    every advisor session in `before_agent_start`; remove the resume-only path
    and the "read it completely" continuation; re-read the guide file each
    turn so a profile switch is picked up.
 3. `advisor_session_init` returns the workstream hot section inline.
 4. A `session_compact` hook queues the hot section as the post-compaction
    notice.
 5. `setActiveTools` for advisor sessions: drop routines, goal tools, most
    memory tools, and situational pi-lens tools. Measure first-turn input
    before and after.
 6. Reject a `bg_agent` launch whose prompt contains an unexpanded paste
    placeholder.
 7. Canonical trace and schema (`config/advisor-core/canonical-events.schema.json`,
    `docs/advisor-protocol.md`): add a deviation event or request kind.

### pi-detach (separate repository)

 1. `src/notify.ts`: `TAIL_ON_AGENT` to zero for done and idle settlements;
    a capped tail only for blocked, failed, and stalled; the notice carries
    the header, Status, a bounded Claims excerpt, and the result path. Same
    cap for promoted `bg_run` notices.
 2. Mark detach notices with a recognizable customType so a compaction filter
    can drop them.
 3. `src/agent-profiles.ts`: native packets state that the result path already
    exists as an empty file with default modes; implement `maxTurns` for
    native workers or stop printing `TURN CAP`.

### Third-party packages: `@ogulcancelik/pi-codex-compaction`, `gentle-engram`

 1. Compaction retention: make `RETAINED_USER_TOKEN_BUDGET` configurable and
    set it near 16k, or exclude detach notices. Upstream change or a pinned
    patched fork through the harness's third-party lock.
 2. Engram passive in advisor sessions: remove the package from the managed
    setup, or hide its tools with `setActiveTools` and neutralize the
    mandatory protocol and the post-compaction `mem_session_summary`
    instruction for sessions that own a workstream file. Keep search and one
    summary at handoff.

### Intelligence profiles: `config/intelligence-profiles/*.json`, `docs/intelligence-profiles.md`

 1. Sol and the other cheap-executor characters: remove "fallback" from the
    escalate list; add "resolves environment and tooling obstacles locally
    and records deviations".

### Workstream and result conventions

 1. Workstream file template: a hot header (Goal, Current state, Active runs,
    Open decisions, Next) within sixty lines; decision and execution logs in
    an appendix. Update the state convention in the doctrine.
 2. Result artifact: `Deviations` heading; Status plus Claims bounded;
    evidence linked. The native maker definitions under
    `config/advisor-core/hosts/*` mention Deviations and the obstacle rule.
 3. `config/bg-agent-profiles.json`: checker description "repair-first
    review"; decide whether turn caps are enforced or advisory.

### Evals, tests, docs

 1. Process metrics in `result.json`, suite summaries, comparisons, and the
    dashboard: launches, blocked settlements, replies, resumes, repair
    rounds, launches per passed criterion, serial gap minutes, compactions,
    first-turn input, post-compaction floors, doctrine and guide read counts.
 2. New prospective cases: `builder-environment-obstacle`,
    `checker-repairs-inline`, `repair-loop-convergence`.
 3. A Harbor calibration task from the Problems S1 trace rewarding the D117
    judgment.
 4. Doctrine tests: replace the model-text assertions; assert the obstacle
    definition and the absence of "repair none of that class", "read
    completely", "re-read before each launch", and the forbidden packet
    phrases.
 5. Docs: `docs/advisor-runtime.md`, `docs/advisor-evals.md`,
    `docs/intelligence-profiles.md`, `README.md` highlights.
 6. Validate with the same-evaluator before-and-after protocol in
    `docs/advisor-evals.md`, and read first-turn input and post-compaction
    floor from a real session.

### Found while delivering

 1. Herdr refuses `agent prompt` for any pane reported blocked, and the
    worker extension reports a pane blocked whenever `result.md` says
    BLOCKED, so the doctrine's "answer a blocked worker by name" path failed
    for exactly the common case; earlier advisors typed into the pane by hand
    and called `bg_agent` again only to re-attach supervision. pi-detach now
    types the reply into the pane when the reused agent's latest run settled
    blocked with a BLOCKED result, then supervises the turn as usual.

### Machine

 1. Install an arm64 Node 22 through nvm and put pnpm 11.19.0 first on the
    PATH that native workers inherit, so the most frequent obstacle
    disappears at its source.

## Part 4 — Guarantees and execution plan

### What must not be lost

The advisor's direct execution, the foreman as a hands-on maker with optional
depth-1 delegation, and a single-maker path that behaves like launching one
ordinary agent are all already doctrine (`skills/advisor/SKILL.md`
non-negotiable 1, "Adaptive topology and the single-maker fast path", and the
delegation decision tree). The evals already reward them:
`advisor-direct-repair`, `advisor-direct-capability`, `single-maker-fast-path`,
`cohesive-medium-maker`, and `medium-ticket-search` all passed in the Sep 6
suite. Graphs are already rare in practice: 2 `graph.planned` events in 95
traced launches. The cost is the serial planner, checker, and repair chain and
the packets, not `advisor_graph_plan`.

Every item in Part 3 either leaves those routes alone or makes them cheaper.
The doctrine core keeps three routes at the top, in this order: direct, single
maker, graph. Single maker is the default for small and medium work and means
one builder or foreman with a short packet, no planner, and no checker below
High tier or an explicit request. The repair-first checker, the obstacle
rule, tiering the change, and planners only for invalidated direction all
remove launches from the chain. System-prompt injection removes the 27k-token
startup cost that makes `/advisor` feel heavy for small tasks. Tool trimming
applies to the advisor's own session and never removes editing, reading,
shell, or diagnostics tools; worker sessions keep `bg_agent` and `bg_run` for
foremen and builders with a helper grant.

Additions that strengthen the fast path:

- A quick-launch packet template of ten to twenty lines: goal, write surface,
  anchors, evidence paths, one tier line. No `GRAPH:` block, no manifests.
- Advisory turn caps for foremen stay advisory and become generous; a foreman
  never stops for the cap while it owns live helpers.
- The foreman applies the same obstacle rule and repair-first review to its
  helpers.
- Process metrics report launches per task, so the fast path is visible.

Two choices are the user's, not the audit's: whether Engram stays active in
advisor sessions at all, and whether the maker and checker blur is acceptable
at High tier (the plan keeps an independent verdict at High; only the
keystrokes move).

### Stages

Each stage is independently committable on a branch with `npm test` and
`npm run typecheck` green, so a session can stop after any stage and the next
session resumes from this document.

| Stage | Scope | Files | Check |
| --- | --- | --- | --- |
| 1 | Doctrine text: obstacle rule, repair-first checker, packet template and freeze lists, tier per change, convergence and planner rules, reading rules, bootstrap skills, profile wording; doctrine tests updated | `skills/**`, `config/intelligence-profiles/*.json`, `tests/advisor-doctrine.test.mjs`, `tests/advisor-review-policy.test.mjs` | `npm run test:harness` |
| 2 | Doctrine split into core and references; system-prompt injection of core and guide; hot section from `advisor_session_init` and after compaction; `setActiveTools`; paste-placeholder guard; runtime contract text | `skills/advisor/**`, `extensions/advisor-session.ts`, `extensions/advisor-worker.ts`, `tests/*.test.ts` | `npm test`, `npm run typecheck`, first-turn input measured in a real session |
| 3 | pi-detach notices, native packet note, `TURN CAP`; pin update | `~/.pi/agent/git/github.com/nourhelmi/pi-detach/src/{notify,agent-profiles}.ts`, harness pin | pi-detach `npm run check`, then a real launch |
| 4 | Compaction retention, Engram passive, deviation event in the canonical schema, workstream and result conventions, native maker definitions | third-party lock or patches, `config/advisor-core/**`, `docs/advisor-protocol.md` | `npm test`, one compaction observed in a real session |
| 5 | Process metrics, three new cases, Harbor task, docs, README | `scripts/advisor-prospective*.mjs`, `evals/prospective/**`, `evals/harbor/**`, `docs/**` | `npm test`, then the same-evaluator before-and-after suite |

Stage 1 is pure text and carries the most behavioral effect per hour. Stages
2 and 3 remove the token cost. Stage 5 makes regressions visible and consumes
Codex quota through the prospective runner, not Anthropic quota.
