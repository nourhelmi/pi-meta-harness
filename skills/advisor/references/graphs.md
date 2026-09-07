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
3. Read bounded `result.md` artifacts, not pane transcripts or raw evidence.
4. Do not launch a dependent wave until all required upstream nodes passed.
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
   for the delta review. Never exceed the manifest repair-loop cap (default
   two); the convergence judgment may stop earlier, and the cap ends in a
   disclosed residual or a user question, never in another planner.
8. Parallel builders or foremen require explicit user approval and distinct
   worktrees.

No driver script may spawn LLMs. The advisor directly owns every visible graph
node and its cost.

## The `GRAPH:` block

When a launch belongs to a graph or a repair loop, include the fixed block
`GRAPH:` followed by indented `graph`, `node`, `wave`, and optional `repair`,
comma-separated `upstream`, and comma-separated `downstream` key-value lines,
ending at a blank line. Keep the risk tier in the packet so workers act on
their position instead of rediscovering it. Workers parse the block, read the
upstream claim summaries relevant to their node, and treat a declared repair
round as scoped to its enumerated findings.

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
