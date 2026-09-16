# Graphs and evidence links

Use `advisor_graph_plan` when independent ownership or real data dependencies make a plan
clearer. A node earns its place through parallelism, specialization or a substantial
deliverable; an edge means the downstream task needs upstream output, not conventional
role order. The tool validates structure and computes waves. It is a plan and a
visibility aid, not a permit to launch, repair or finish an agent, and it imposes no
repair quota.

Keep one writer per checkout, including yourself; parallel writers get distinct
registered Git worktrees. Launch independent nodes together. Start dependent work when
its inputs exist, including a failed upstream that a repair node consumes. Explicit user
limits remain binding; do not stop because a graph counter ran out.

`advisor_graph_evidence` associates an owned run/attempt with a plan node and returns
evidence references. Keep them when useful. A missing, changed or stale reference is a
limitation to report, not a launch veto. Replacing a node does not stop its worker or
release its write surface. A historical PASS stays historical; a PASS summary never
establishes verification by itself. The legacy `GRAPH:` block in a packet is
correlation metadata only.

Child advisors get an outcome, not a graph recipe; their graphs live in their own
namespace. A settled parent turn with live descendants is not a finished outcome: gather
the actual evidence needed before delivery or teardown.
