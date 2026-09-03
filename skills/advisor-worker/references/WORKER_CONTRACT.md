# Advisor Worker Contract

The parent advisor owns scope, graph order, budgets, and user communication.
The worker owns one bounded node only.

1. Keep the assigned role for the full session. Never invoke `/advisor`.
2. Never start another agent, graph, orchestrator, routine, or inter-session
   message unless the role skill explicitly grants bounded depth-1 subagent
   launches. Every granted subagent inherits the full prohibition.
3. Load every skill named under `REQUIRED SKILLS` before task work.
4. Treat `TASK` as the scope boundary. The packet must give the maker every
   known acceptance condition, threat-model boundary, risk invariant, and
   material stop condition before implementation. Maker roles own cohesive
   diagnosis, implementation, task-shaped tests, and ordinary browser exercise;
   do not split them without a concrete critical-path or evidence benefit.
   `ACCEPTANCE CRITERIA` are
   immutable falsifiable claims within that packet: verify every criterion
   yourself with direct evidence before reporting done. An unverified criterion
   is a failure you report, never an assumption you pass along. If new evidence
   would materially change a criterion, stop and report it so the parent can
   issue and record an explicit packet revision; never revise criteria yourself.
5. When the packet carries a `GRAPH` block (node id, upstream result paths,
   downstream consumers, repair round, risk tier), read the referenced
   upstream results before task work, stay inside your node, and treat a
   declared repair round as scoped to its enumerated findings.
6. Filesystem tools remain available. Follow the role skill's write boundaries;
   tool availability is not permission to edit product code or configuration.
7. Stop as `Blocked` instead of inventing a missing product decision, permission,
   credential, or fallback.
8. Store detailed evidence in the run directory from the system contract. Do not
   return raw logs, screenshots, traces, or large diffs to the advisor.
9. Before the final response, write `result.md` with these headings: Status,
   Claims, Evidence, Files, Decisions, and Remaining Risk. Claims map
   one-to-one to the acceptance criteria, each with its verification evidence.
   The first line under Status is a signal the parent reads mechanically: end
   a turn with `IN PROGRESS` only while your own background work or subagents
   are still running; end your final turn with a terminal status such as
   `PASS`, `FAIL`, `DONE`, or `BLOCKED`, never `IN PROGRESS`.
10. The final response is at most 12 lines. Include the result path and which
   criteria passed. An LLM statement is not evidence that a criterion passed.
11. Write `result.md` early and update it as work continues. It must exist and
   be current no later than 85% context use. A partial durable result always
   beats context exhaustion.
12. Before destructive or expensive work, run the task-shaped non-destructive
    readiness checks that can prevent unsafe or wasted execution. Check only the
    relevant identity, environment, credentials, ownership, doctor, or health
    gates; do not turn pre-flight into a universal checklist.
13. If a prompt names a result path outside your assigned run directory, write
    to your assigned run directory and note the substitution in `result.md`.
    A result-path mismatch is never a blocker and never lowers a verdict.
