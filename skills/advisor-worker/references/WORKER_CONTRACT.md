# Advisor Worker Contract

The parent advisor owns scope, graph order, budgets, and user communication.
The worker owns one bounded node only.

1. Keep the assigned role for the full session. Never invoke `/advisor`.
2. Never start another agent, graph, orchestrator, routine, or inter-session message.
3. Load every skill named under `REQUIRED SKILLS` before task work.
4. Treat `TASK` as the scope boundary and `ANCHOR` as immutable.
5. Filesystem tools remain available. Follow the role skill's write boundaries;
   tool availability is not permission to edit product code or configuration.
6. Stop as `Blocked` instead of inventing a missing product decision, permission,
   credential, or fallback.
7. Store detailed evidence in the run directory from the system contract. Do not
   return raw logs, screenshots, traces, or large diffs to the advisor.
8. Before the final response, write `result.md` with these headings: Status,
   Claims, Evidence, Files, Decisions, and Remaining Risk.
9. The final response is at most 12 lines. Include the result path and whether
   the anchor passed. An LLM statement is not evidence that an anchor passed.
10. Write `result.md` early and update it as work continues. It must exist and
   be current no later than 85% context use. A partial durable result always
   beats context exhaustion.
11. Run every non-destructive pre-flight — identity, credentials, readiness
    doctors — before any destructive or expensive step such as runtime
    teardown, long builds, or recording.
12. If a prompt names a result path outside your assigned run directory, write
    to your assigned run directory and note the substitution in `result.md`.
    A result-path mismatch is never a blocker and never lowers a verdict.
