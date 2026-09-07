# Transport, settlement, and session hygiene

Read this when a launch fails or settles strangely, when native routing
matters, when waiting on external state, or when managing session context.

## Harness modes and native routing

The persisted session mode is the default for every semantic role. A role
profile may impose a stricter transport when its contract depends on a runtime
capability: foremen are Pi-hosted because visible depth-1 delegation uses Pi's
`bg_agent`. In Pi mode, selected models run through Pi. In native mode,
`openai-codex/*` and `openai/*` route through Codex CLI and `claude-bridge/*`
and `anthropic/*` route through Claude Code. Keep semantic role names
unchanged; do not invent harness-specific aliases. Every role packet includes
the installed role-skill path and the worker loads it before starting.

Pi workers receive the external advisor run directory from the worker
extension. Native Codex and Claude role launches receive an automatically
generated `result.md` path from `bg_agent`, reserved before launch as an
empty file with the launcher's default modes; read that artifact after
settlement and do not use the pane transcript as the durable result. The
session's persisted worker mode is authoritative over per-launch requests; an
explicit role-profile transport constraint takes precedence. Never pass a
conflicting per-launch harness. Native settlement stalls only for a missing or
blank result artifact; missing, empty, or differently formatted sections are
advisory notes and do not prevent settlement. A Cursor-only recommendation has
no native route; choose a task-appropriate OpenAI or Anthropic model from the
same guide instead, or stop and report the transport mismatch rather than
silently switching the session to Pi.

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
- **Needs supervision or dialogue:** `bg_agent`; answer blocked agents with the
  same agent name.
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

A worker that fails before producing evidence is a transport or runtime
failure, not evidence that the task route was wrong. Before retrying, read the
bounded tool error, check `bg_list` once, and inspect the expected result path
or worktree ground truth. Resume the same live worker when it exists;
otherwise make at most one fresh changed retry for that role with a compatible
model from the live guide. The retry must change a plausible failure variable
(model or provider availability, malformed packet, stale agent identity)
rather than repeat the same launch.

If the changed retry also fails before work starts, do not abandon an
otherwise safe workstream or pretend delegation succeeded. When repository
evidence settles the boundary and ownership is clear, perform bounded
discovery or implementation yourself under the same maker and review duties;
record the fallback and its lower independence. If independent role evidence
is an explicit acceptance requirement, report that requirement as unsatisfied
even when the functional repair proceeds. Stop instead when the missing worker
guards a material decision the available evidence cannot settle, or when every
compatible route is unavailable. Never launch a recovery maker until settlement
ground truth has ruled out a late worker success.

## Settlement ground truth

Launch and settlement notifications are hints, not verdicts. Before treating a
worker as failed, unstarted, or empty-handed, check ground truth in its
worktree: new commits since launch, `result.md` existence and mtime, and
branch movement. A maker whose commit landed after detach is a late success,
not a failure. Settlement notices carry the worker's result Status line; a
`paused` notice means the worker ended a turn while waiting on its own
sub-workers and remains supervised, so no action is needed until its next
settlement. A blocked settlement carries the worker's request; answer it with
`bg_agent` and the same `name`, stating only what changed, without asking the
worker to re-read or re-hash its packet.

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
- Never read role skills or the worker contract; workers load their own. Read
  a repository skill only when you edit repository code yourself.
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
