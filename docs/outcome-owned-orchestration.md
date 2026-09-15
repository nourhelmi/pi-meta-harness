# Outcome-owned orchestration

The normal unit of delegation is one maker owning diagnosis, implementation, local
obstacles, verification and reporting. A graph is optional. Review resolves remaining
uncertainty; it does not replay every maker command. Checkers can repair serious
findings inside their authorized surface. Their repairs require verification of the
affected behavior, including plausible browser journeys, not automatic non-author
closure. Extra review resolves a named uncertainty or project/user requirement;
required agentic PR review belongs to the project's review/CI workflow. Resume the
original checker for a justified maker-repaired delta.

## Captured handoffs and continuation

Managed `bg_agent`, `bg_list` and completion messages, and stock-native launch,
status/list and wait responses expose the same runtime handoff. It includes current
status/attempt, eligible continuation, and bounded sections projected from the
existing worker report. No second worker report is required.

`result-<attempt>-<sha256>.md` is a captured, attempt-specific report; `source/result.md`
is worker-owned and mutable. `result.md` is the compatibility alias, not immutable
proof. The runtime rechecks captured bytes on reads. Stock `advisor_worker_artifact`
can read the returned hash-named report or host-check file, as well as the aliases.
A missing or malformed report, changed capture, or missing tested surface is not
verified proof. A worker PASS is a worker assertion, not independent review.

Use the exact run ID as managed `bg_agent.name` or stock `message.runId`; current
identity-checked transport determines whether a message/follow-up is supported.
`keepAlive` is a cleanup preference, not a result-validity capability. A completed
turn, missing/incomplete report, current proof and available session are separate
facts. Search the run's recorded transcript or inspect actual artifacts when the
summary is absent or insufficient. A terminal tail is not the complete transcript.

Historical deliveries retain their original report/attempt alongside current state.
New attempts cannot inherit an old capture as their own output; late/duplicate
callbacks cannot overwrite newer evidence. Supported recovery inspects the recorded
worker identity without blindly resending input. A client reload is not a service
restart or permission to adopt another session.

## Optional graph evidence

Use `advisor_graph_plan` and `advisor_graph_evidence` when recording dependencies
and evidence helps coordination. Graphless work is first-class. A graph records a
plan, not permission to launch or continue a worker; neither missing input metadata
nor repair counters veto otherwise authorized execution.

Associate `{graphId,node,runId}` with the actual owned run/attempt. Keep references
and provenance when useful for downstream work, without pasting whole reports into
every prompt. A changed/missing reference remains visibly unknown; it must not be
upgraded into a claim that the worker consumed newer evidence. Revisions preserve
historical graph/run associations and immutable captures rather than rewriting the
past. No graph node/dependency/parallel/repair quota is imposed by the runtime.

Stock-native `advisor_worker_graph_evidence` uses the same owned principal and
actual tool schema. It never starts a worker. A successor association does not stop
the predecessor, establish its exit, or release a write surface. The advisor must
coordinate actual execution and retain explicit user limits.

Historical captures/checks remain attributable and accessible. A repair can consume
an evidenced FAIL; it need not wait for unrelated upstream proof to become green.
Changed input identities or tested content make affected proof stale/unknown, not
permission to fabricate verification and not a prohibition on unrelated work.

### Trusted host checks, not model attestations

Host integrations holding the existing `AdvisorRuntime` instance may call:

```js
const proof = runtime.checkNode({
  scope: settledNode.snapshot.scope,
  command: process.execPath,
  args: ['--test', 'tests/affected.test.mjs'],
  producer: 'host-affected-check',
});
```

This is a **trusted host API**, not a new model tool or scheduler. It runs only a
host-selected command in the admitted cwd, without a shell, and captures invocation,
producer, exit outcome, output, limitations and before/after content digests in
`check-<sha256>.json`. It clears prior verification before running; a failed or
surface-mutating check cannot inherit a prior PASS. Host integrations must authorize
the invocation and choose its coverage; exit zero alone does not prove every claim
or make a maker-authored check independent. Normal clients can consume these records
but cannot set a `verified` flag. Without such host attestation, worker evidence stays
reported/unknown, even when it names commands and a Git revision. Owner restart
also invalidates current host attestation, including for non-kept terminal workers;
retained report/check locators remain accessible history. A fresh trusted host check
can establish current proof again. Reloading a client on the same owner does not
change the attestation.

The digest covers the whole Git-visible root, including dirty, untracked and deleted
files and file modes, not HEAD alone or just the launch subdirectory. Current proof
requires matching surface, report hash and intact captured check bytes. Code, tests
and Git-visible dependency lock changes invalidate it. The actual tested revision is
retained even when later commits contain identical bytes. Unsupported or unavailable
fingerprinting is reported as unknown rather than a verdict on the task. Ignored
dependencies, external services and environment are not covered. Whole-checkout
freshness is a conservative proof projection, not a launch gate: unrelated work may
continue and affected claims can be checked directly. Never reuse a whole-environment
claim without evidence. Host checks are synchronous; use normal background commands
for long builds while supervising active workers.

## One checkpoint and memory integration

The workstream hot section is authoritative. Session metadata points to it, never
competes with it. Exact session ownership is restored from a matching session entry
or that session's disk pointer. Forks do not inherit their parent's authority.
Missing, corrupt, oversized or foreign-owned checkpoints inject an explicit recovery
warning and fence new worker effects, while owned cancellation remains available.
A failed Herdr initialization may reserve the workstream for retry, but does not
publish a new managed-session pointer or activate checkpoint mode.

The installer copies `extensions/advisor-memory.ts` and an unchanged gentle-engram
0.1.12 snapshot, removes the old npm package activation from managed settings, and
retains its explicit memory tools. The wrapper composes public Pi event hooks:
managed advisor start/prompt, compaction and automatic tool capture use the checkpoint
protocol instead of upstream mandatory diaries. It does not append contradictory
instructions or modify installed upstream code. Raw and expanded advisor entry
prompts select this mode before initialization. Ordinary sessions forward upstream
hooks and prompts unchanged; session switch/shutdown clears transient entry state.

`third-party/gentle-engram/SNAPSHOT.json` records each vendored byte hash; upstream
license and provenance ship with it. Updating this snapshot requires rechecking the
hook contract and isolated installed-context tests. Explicit additional provider
activations are not silently rewritten. `doctor` rejects recognizable extra
`gentle-engram` package/extension entries: disable those before reloading. Pi reports
duplicate tools but still runs both providers' hooks, regardless of load order;
ignoring this diagnostic can restore conflicting mandatory memory instructions.
Arbitrarily renamed copies and project/CLI activations outside managed settings
remain operator-owned and must not duplicate the memory provider.

## Runnable evidence

- Meta: `npm test` and `npm run typecheck`; outcome evidence, stock facade, lifecycle,
  graph, memory, installer, native-boundary and prospective oracle tests are included.
- Detach: `npm test` and `npm run typecheck`; use an isolated `PI_CODING_AGENT_DIR`
  so legacy test doubles never connect to an operator's installed runtime.
- Prospective cases `checker-repairs-inline` and `repair-loop-convergence` exercise
  High in-scope repair/independent probes and same-maker/same-reviewer delta reuse.
  Deterministic oracle/trace tests are not a claim of a live model evaluation run.
