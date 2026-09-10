# Graphs, waves, and repair loops

Read this when work has real independent ownership or dependency boundaries,
when a launch belongs to a graph or a repair loop, or when a foreman needs the
delegation detail. The single-maker route never needs it.

## Information-value graphing

Use a graph only when work has real independent ownership or dependency
boundaries. Prefer the smallest graph sufficient to resolve those boundaries,
without treating node count as an objective. Every node needs a reason to
exist: its task should state the uncertainty, decision, confidence,
critical-path reduction, or durable artifact it unlocks. A dependency means the
downstream node actually consumes upstream output; never add one merely to
express conventional role order. Independent ticket triage, source analysis,
and baseline runtime observation belong in the same launch wave when each can
change the route. Add a reducer only when evidence conflicts or synthesis is
substantial; otherwise read the bounded artifacts directly.

Use `advisor_graph_plan` as a structural validator and coordination aid before
any graph with three or more nodes or mixed parallel and dependent work. Its
immutable manifest hard-checks IDs, configured or freeform roles, acceptance
criteria, dependencies, cycles, concurrency, and builder worktree isolation.
Role-order and reducer-shape findings are advisory warnings: confirm the shape
is intentional, then proceed without contorting valid baseline or audit work.
The advisor still owns whether the graph is useful. Follow an accepted graph's
dependency order; when new evidence invalidates its shape, settle or stop
affected work and record a revised graph rather than blindly executing
obsolete nodes. For the current manifest, execute the returned deterministic
waves:

1. Launch every independent node in the current wave as parallel `bg_agent`
   calls in one turn.
2. Wait for completion notifications; never poll.
3. Read the returned handoff and relevant captured proof, not pane transcripts.
4. Start a dependent node when the inputs its task actually needs are available.
   A repair or review can consume an evidenced FAIL; do not pretend the upstream
   implementation passed. Delivery still requires satisfied acceptance and review.
5. Preserve maker/checker independence for implementation review. Baseline
   browser investigation may precede any builder, and a checker may perform a
   bounded audit without one. Post-change browser verification is equally
   valid. Never relabel browser work as scouting to silence a graph warning.
6. Run the task-shaped deterministic criteria still needed for authoritative
   proof, proportionate to cost, risk, and oracle strength. An LLM approval is
   never a criterion's proof.
7. A checker repairs what it can inside the reviewed surface and reports the
   post-repair state. Feed the remaining findings back to the kept-alive
   maker only when another attempt has a concrete new strategy or information
   source. Verify the repair with affected criterion reruns and a targeted
   diff read; carry forward unaffected valid evidence; resume the same checker
   for the delta review of a maker's repair. A checker-authored patch follows
   the evidence reference's risk-based delta review, not self-certified
   independence. Never exceed the manifest repair-loop cap (default two).
   At the cap, stop and reassess under the core's Convergence rule: deliver
   only with all criteria, required checks, and safety obligations satisfied,
   and disclose only non-blocking residuals. Otherwise report incomplete work
   and a bounded next step or user decision. Never silently reset a cap by
   renaming the slice or launching another planner.
8. Parallel builders or foremen require explicit user approval and distinct
   worktrees.

## Carry evidence with the outcome

A graph node represents an accepted outcome, not a single model turn or repair
attempt. `advisor_graph_plan` records the plan; the managed runtime's
`advisor_graph_evidence` associates a node with an owned worker run/attempt and
projects its current evidence. These are different responsibilities, not two
execution engines.

- After launching, bind `{graphId, node, runId}` with `advisor_graph_evidence`.
- Before downstream work, query `{graphId, node: downstreamId}` and use its
  returned task/evidence prompt with the ordinary launch tool. Supply the same
  accepted criteria, ownership and safety boundaries; the prompt is not a grant.
  Keep the returned block and its input token intact when adding task context.
  Launch/reply admission records what was supplied, so binding later cannot replace
  consumed inputs with a newer upstream attempt. No token means unknown lineage,
  not a reason to create a graph for ordinary work.
- For a repair on the same kept worker, retain the graph/node/run and explicitly
  refresh its association to the current attempt. Keep old attempt captures
  attributable, invalidate stale current proof, and preserve repair budgets.
  A checker may consume an evidenced failure and supersede its source checks with
  valid current output. Historical inputs must remain intact and attributable,
  not currently green. Changed input identities still invalidate stale claims.
- If the original worker cannot continue and its ownership is resolved, explicitly
  succeed it on the same outcome: bind the new `runId`/`attempt` with
  `replacesRunId`/`replacesAttempt`. This uses one repair slot, retains history and
  refuses active, cancel-pending, uncertain or multiply-bound prior ownership.
  It never launches a replacement. Changed acceptance still needs a revised contract.
- Query again after repair, reload or a relevant source/environment change.
  Copied checkpoint summaries are evidence locators, not a source of current truth.
  `reported` evidence can be inspected and reused with its producer and limits;
  `unknown` or stale proof never becomes verified merely because a worker says PASS.
  Trusted host checks attest only the invocation/surface they actually covered.
- One maker without a real dependency graph uses the normal handoff directly.
  Do not create a graph just to record a result or justify a repair.

No driver script may spawn LLMs. The advisor directly owns every visible graph
node and its cost.

## The `GRAPH:` block

For a real graph, retain a `GRAPH:` block when the host's existing trace
correlation requires it: indented `graph`, `node`, `wave`, optional `repair`,
comma-separated `upstream` and `downstream`, ending at a blank line. This is a
trace label, not the evidence association or a second result report. The managed
graph-evidence call supplies the dependency context; do not reconstruct it by
copying raw worker transcripts. A graphless repair does not require this block.
Keep the risk tier, assigned findings and write ownership in the packet. Focus a
repair review on the changed delta, while fixing any qualifying in-scope defect
it reveals rather than starting a fresh full audit.

## Foreman detail

The foreman remains an empowered maker: it may plan, implement, integrate,
verify, and delegate useful subproblems. Direct and delegated work are both
legitimate; it owns every acceptance criterion, not just a set of worker
handoffs. Its subagents never delegate. Suitable delegates are scouts,
conditional browser verifiers, and freeform helpers; `bg_run` covers test and
build commands. It keeps one writer per checkout, including itself: it never
edits alongside a writing helper and reclaims ownership after that helper
settles. Read-only helpers may work alongside it when they do not need a
frozen diff. Its helpers follow the same obstacle rule and the same
repair-first review rule as any worker. Parallel foremen follow the same
approval and distinct-worktree rules as parallel builders.
