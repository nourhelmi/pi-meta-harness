# Outcome-owned orchestration

The normal unit of delegation is one maker owning diagnosis, implementation, local
obstacles, verification and reporting. A graph is optional. Review resolves remaining
uncertainty; it does not replay every maker command. Checkers can repair serious
findings inside their authorized surface. Material checker-authored changes still
need independent delta closure. Resume the original checker for maker-repaired deltas.

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

`continuation: reply` means a currently answerable BLOCKED request; `task` means a
kept PASS/FAIL worker eligible for a fresh task; `none` grants no continuation.
Use the exact run ID as managed `bg_agent.name` or stock `message.runId`. Replay
retains effect identity but refreshes the **current** handoff. Historical deliveries
retain their original report and attempt alongside the current handoff. New attempts
clear current proof/capture availability before dispatch. Late/duplicate callbacks
cannot overwrite the next attempt's evidence. Cancellation, ownership, generation,
and recovery fences still apply. Restarted kept workers require recovery;
reloading a client connected to the same live owner is not a runtime restart.

## Optional graph evidence

1. Create the existing plan with `advisor_graph_plan`.
2. Launch its maker with the existing worker tool.
3. Call `advisor_graph_evidence({graphId, node, runId})` to bind that outcome node to
   the exact owned run/attempt. After a same-worker repair, repeat this call to
   explicitly refresh the **same node and run**, not a new graph. Optional `attempt`
   fences stale refresh requests. A read without `runId` never advances the binding.
4. Call `advisor_graph_evidence({graphId, node: downstreamId})`. Use the returned
   `prompt` intact within the existing downstream launch or continuation. Its input
   token binds the exact supplied evidence block at admission, before dispatch.
   Later binding never infers consumed inputs from newer current state. A same-worker
   continuation without a fresh block retains its prior input lineage. Missing tokens
   on dependent work mean unknown lineage, not inferred proof.
5. Keep the graph ID, run/attempt and proof locators in the workstream current section.
   Requery before consuming proof; do not treat a copied checkpoint verdict as current.

Stock-native `advisor_worker_graph_evidence` accepts `graph` as JSON
`{graphId,nodes:[{id,task,dependsOn}],maxRepairLoops?,contract?}` plus `node`, optional
`runId`/`attempt` and `replacesRunId`/`replacesAttempt` for explicit succession;
the facade supplies its authenticated session identity.
No graph call launches work. Links live in the existing owner's SQLite store,
scoped to its principal and immutable graph contract. The managed plan fingerprints
its full acceptance/role/worktree/budget contract, not only task text.

A newer upstream attempt makes current and transitive downstream claims unknown,
even when source bytes match. Historical reports and checks must remain intact and
attributable, but their old source checks need not remain currently verified: a
repair-first checker can consume an evidenced FAIL and establish valid current
output on repaired bytes. Its own tested surface must still match. Late binding,
same-attempt refresh and worker PASS never manufacture input identity or host proof.

After prior ownership resolves, an explicit successor can retain the accepted node:
bind new `runId`/`attempt` with the exact old `replacesRunId`/`replacesAttempt`.
Active, cancel-pending, recovery-required, stale, still-kept or multiply-bound prior
ownership is refused. Exit-required handles need confirmed exit. Already-associated
successors and arbitrary rebinding are refused. An exact retry is idempotent; a
superseded run cannot admit another task. This never launches work or coordinates
workspace writes. For kept workers use the existing same-worker continuation; do not
interpret an idle pane as permission to replace unresolved ownership.

`node.history` exposes the latest eight historical captured reports with attributable
host-check locators; `historyCount` reports the full retained capture count. All
captures and check records remain in runtime storage. History is integrity-rechecked,
labelled historical/unknown, and never overwritten by refresh. `node.budget` reports
used/remaining terminal follow-ups and explicit successions (BLOCKED replies do not
consume a repair). Successor pre-binding follow-ups count too; history includes run IDs.
The plan's `maxRepairLoops` defaults to 2 (0–3); a bound run cannot admit more terminal
follow-ups than that budget, including when the caller omits evidence refresh.
Neither rebind nor restart resets it. A genuinely changed contract requires a new
accepted plan, not a workaround for exhausted repairs.

There are at most 24 nodes per graph, 12 dependencies per node and 128 graphs per
principal, and 4096 immutable input snapshots per principal. Snapshot tokens are
scoped to the authenticated principal and stored prompt bytes, not model attestations.
Missing/tampered snapshot inputs are rejected at admission. Graphless launches and
continuations use the same result store without graph budget gates.

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
retained even when later commits contain identical bytes. Limits: 10,000 paths,
16 MiB/file, 128 MiB total; unsupported file kinds (including symlinks) yield unknown.
Ignored dependencies, external services and environment are **not covered**. Such
uncertainty needs a fresh affected check, not a reused whole-environment claim.
Host checks are synchronous and bounded to 120 seconds by default (300 maximum);
do not use this host API for long builds while supervising active workers.

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
