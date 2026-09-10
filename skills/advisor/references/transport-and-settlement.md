# Transport, settlement, and session hygiene

Read this when a launch fails or settles strangely, when native routing
matters, when waiting on external state, or when managing session context.

## Harness modes and native routing

The persisted session mode is the default for every semantic role. A role
profile may impose a stricter transport when its contract depends on a runtime
capability: child advisors are Pi-hosted because visible delegation and child
graphs use Pi's tools. In Pi mode, selected models run through Pi. In native mode,
`openai-codex/*` and `openai/*` route through Codex CLI and `claude-bridge/*`
and `anthropic/*` route through Claude Code. Keep semantic role names
unchanged; do not invent harness-specific aliases. Every role packet includes
the installed role-skill path and the worker loads it before starting.

Pi and native workers receive their writable run directory and `result.md` from
the launcher; an empty reserved file is expected. In managed mode, consume the
runtime handoff's captured attempt-specific result, not mutable `source/result.md`
or the compatibility alias as historical proof. Legacy transports without captured
locators use the assigned report, with its weaker provenance stated explicitly.
Never invent a path or treat a pane transcript as the durable report.

The persisted worker mode is authoritative over per-launch requests; an explicit
role-profile transport constraint takes precedence. A missing or blank report
cannot prove completion; nonstandard report headings are advisory, not a reason
to repeat work. A Cursor-only recommendation has no native route; choose a
compatible recommendation or report the mismatch rather than silently switching
session mode.

## Delegation decision tree

- **Trivial reading or a normal command:** do the reading yourself or use one
  bounded `bg_run`. `bg_run` is for tests, builds, and shell commands only; it
  must never launch an LLM or a script that launches LLMs.
- **Implementation:** an empowered maker chosen by context, decision load,
  specialization, useful parallelism, and total cost.
- **Waiting on external state** (CI, deployments, migrations, slow services):
  one `bg_await` with the probe, terminal patterns, and interval. Never run
  sleep-and-check loops through `bg_run`.
- **One delegated task:** `bg_agent` with a self-contained prompt, a label, a
  model and reasoning from the guide, the correct worktree, and criteria.
- **Needs supervision or dialogue:** `bg_agent`; answer the current blocked
  request only when its returned continuation is `reply`, with the exact run ID.
- **Wide independent work:** fan out several `bg_agent` calls in one turn.
- **Dependent work:** execute directly or delegate serially according to who
  holds the useful context.
- **Recurring:** never inject a Pi routine into an interactive advisor
  session; use a non-LLM external monitor or a user-approved control process.

Dev servers and watchers are `bg_watch`, one per worktree. Never poll a
detached run or agent. Give CI and deploy watchers a `donePattern` so the
terminal line wakes the session. If `bg_agent` cannot create a Herdr surface,
stop and report the visibility failure; never fall back to an invisible agent.

## Worker transport recovery

A failure before useful evidence does not by itself show the task route was wrong.
Read the bounded error and current handoff first; inspect `bg_list` once if state
is unclear. Distinguish a definite pre-launch rejection from an ambiguous effect.
Correct a rejected request within existing authority. For admitted work, use the
same exact run ID only when current continuation is `reply` or `task`; a live or
idle pane alone is not permission to send another prompt.

`recovery-required`, cancellation and uncertain delivery retain their supported
recovery boundary for that effect. Never clear locks, adopt a pane, or replay it
because an artifact exists or output looks quiet. These states are not workspace
write locks: parent and child advisors coordinate subsequent work using actual
execution evidence. A missing capture stays missing even if mutable source
output looks successful. Inspect output or source only to resolve that discrepancy,
not as a routine handoff step.

If a definite pre-effect rejection has a permitted correction, make at most one
changed retry, not an identical new launch. If transport remains unavailable,
perform the cohesive work directly only when ownership and authority are clear;
required independent review remains unsatisfied until actually obtained. Any
explicit acceptance requirement for a particular transport or worker stays
unsatisfied if bypassed by direct work. Another root/workstream must be
explicitly scoped through its supported bootstrap, not
used to evade a refusal or adopt an uncertain worker. Keep unfinished criteria
visible rather than reporting transport recovery as product success.

## Settlement ground truth

The current handoff separates admission, worker status, captured report, attempt,
proof and continuation. Read its bounded claims/risks first and the relevant
captured proof needed for your next decision. A reported PASS is not independent
verification; an unknown proof field does not mean the worker must repeat every
check if its attributed underlying evidence can be inspected.

Historical deliveries refer to their original attempts. Requery current state
before a follow-up or graph dependency consumption. Reply with only the changed
decision or repair goal; do not require re-reading/re-hashing an unchanged packet.
Do not use worktree commits, report mtimes or branch movement to override the
runtime's ownership, capture or settlement state. They are troubleshooting inputs
only. A `paused` worker remains supervised while its own helpers run; wait for
its next meaningful settlement.

## Status updates

On long work, mention elapsed path, launch breadth, or major spend only when it
helps the user understand trajectory, risk, or a change of plan. Coalesce a
routine settlement and its already-decided next launch into one update; do not
narrate state-file edits, waiting, or every successful handoff. Do not emit a
bureaucratic report on a fixed interval.

## Routines

Interactive advisor sessions must not own pulse, cron, or lifecycle routines.
`pi-routines` stores one global routine file, but each open Pi process
schedules its own timers, which causes duplicate turns and state-write races.
If recurring automation is required, run it in a separate headless control
process that writes a new immutable event file and never a shared mutable
state file.

## Context budget

- The doctrine core and the active guide are in your system prompt; never read
  them with a tool. Read a reference only when its situation arises.
- Workers load their own role skill and worker contract. Do not preload those
  or repository skills merely to launch a worker. Read the relevant skill or
  contract section when a concrete planning, review, investigation,
  implementation, or recovery decision needs it; you need not be editing code.
  Required task and safety instructions still apply. Reuse material already
  in context and keep additional reads bounded.
- Read the workstream hot section, which is returned to you at session start
  and after every compaction; read the log by offset only when a decision
  needs it. Read a worker result only when a claim needs inspection; the
  settlement notice carries its status and path.
- Keep tool reads bounded. Delegate log reduction and bulk artifact review; a
  screenshot or image the user shares is read directly.
- Compaction is automatic. Keep the workstream hot section current so nothing
  is lost when it happens; do not write session summaries to a memory system
  as a substitute for the workstream file.
- Start a fresh Pi session and invoke `/advisor` after a completed workstream.
  Do not reuse one long advisor conversation for unrelated tasks.
