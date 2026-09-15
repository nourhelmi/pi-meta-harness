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
A recorded session transcript is a separate retrieval source: it can show the
original messages and tool results behind a summary. A pane's terminal tail is
not that transcript. Use the run-bound transcript source when searching history,
and disclose when a provider's recorded history is unavailable.

The persisted worker mode is authoritative over per-launch requests; an explicit
role-profile transport constraint takes precedence. A missing or blank report is
not evidence of task success, but it also does not negate an observed completed
turn. Nonstandard headings are advisory. A Cursor-only recommendation has no
native route; choose a compatible recommendation or report the mismatch rather
than silently switching session mode.

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
- **Needs supervision or dialogue:** `bg_agent`; use the exact run ID and the
  supported identity-checked message/follow-up operation. Never type into dialogs.
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
same exact run ID and supported identity-checked message or continuation operation;
a visible pane alone is not permission to send input or answer a dialog.

Treat uncertain delivery as uncertain: never clear locks, attach arbitrary panes,
or resend an old task because a file exists. Use the runtime's supported
identity-checked reconciliation when available. A completed turn, available report,
verification state, reusable session and outstanding descendants are separate
facts. None is a workspace write lock; the advisor coordinates actual ownership.

A missing report can be investigated through the recorded transcript, source and
other artifacts. Do not recreate execution merely to make a summary appear. Keep
reported, inspected and independently verified evidence distinct.

For a definite pre-effect rejection, correct its cause and use a new call ID.
Do not repeat identical failed requests or relaunch an uncertain effect. If transport
remains unavailable, perform cohesive work directly only when ownership and authority
are clear;
required independent review remains unsatisfied until actually obtained. Any
explicit acceptance requirement for a particular transport or worker stays
unsatisfied if bypassed by direct work. Another root/workstream must be
explicitly scoped through its supported bootstrap, not
used to evade a refusal or adopt an uncertain worker. Keep unfinished criteria
visible rather than reporting transport recovery as product success.

## Settlement ground truth

Read the current handoff for execution state and available evidence. A concise
summary is useful when it answers the question; it is neither the only memory nor
a required reading stage. Search recorded run history and inspect source, commands,
tool results and artifacts as useful. Page large content; don't blindly import
whole conversations. An unavailable provider transcript is not an empty session.

Historical deliveries and captures retain their original attempts. A recorded
successful command is evidence of that invocation, not a current checkout proof.
Rerun checks when a relevant change invalidates them, not merely because unrelated
files changed or a summary is missing. Never relabel worker assertions as independent
verification.

Before follow-up, use current identity-checked transport state. `keepAlive` expresses
whether automatic cleanup is desirable, not whether a report is valid. A stopped
turn may leave descendants active; report them separately and protect their work
from teardown. A completed turn does not itself satisfy the accepted outcome.

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
- Read/search the recorded transcript directly when it helps answer a question.
  Delegate log reduction only when independent work or specialization earns the
  handoff; a screenshot or image the user shares is read directly.
- Compaction is automatic. Keep the workstream hot section current so nothing
  is lost when it happens; do not write session summaries to a memory system
  as a substitute for the workstream file.
- Start a fresh Pi session and invoke `/advisor` after a completed workstream.
  Do not reuse one long advisor conversation for unrelated tasks.
