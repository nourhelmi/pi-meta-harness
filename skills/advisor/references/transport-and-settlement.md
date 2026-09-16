# Transport and settlement

## Harness modes

The persisted session mode (Pi or native) is the default transport for `builder` and
`checker`; `advisor` is always Pi-hosted so child graphs stay visible. Native mode routes
`openai-codex/*` and `openai/*` to Codex CLI and `claude-bridge/*` and `anthropic/*` to
Claude Code. A Cursor-only recommendation has no native route: pick a compatible model or
report the mismatch. Every packet names the role skill path and the worker loads it
itself. Native workers receive a reserved, initially empty `result.md`.

## Delegation

- A command: `bg_run`. It never launches an LLM.
- External waits (CI, deploys, migrations): one `bg_await` with a probe and a terminal
  pattern. Never sleep-and-check through `bg_run`.
- Servers and watchers: `bg_watch`, one per worktree, with a done pattern for CI or
  deploy watchers.
- One task: `bg_agent` with a self-contained prompt, label, model, thinking, worktree and
  a done-when line. Several independent tasks: several `bg_agent` calls in one turn.
- Follow-up: the exact run id and the supported message or continuation operation. Never
  type into permission dialogs.
- Recurring automation never runs as a routine in an interactive advisor session; use a
  separate headless process that writes immutable events.

## Recovery

A definite pre-launch rejection: fix the cause, new call. An admitted worker with unclear
state: `bg_list` once, then the handoff and the recorded transcript. Never clear locks,
adopt a pane or resend an ambiguous effect; use the runtime's identity-checked
reconciliation. A missing or blank summary does not mean the run failed or must be
repeated. A completed turn, an available report, verification and live descendants are
separate facts. If transport is down, do cohesive work directly when you own the
surface, and keep any explicitly required review visible as unsatisfied.

## Context

The doctrine and guide are in your system prompt; never read them with a tool. Read a
reference or a role skill only when a concrete decision needs it. Read the hot section
(returned at start and after compaction), the log by offset only when a decision needs
it, and a worker result only when a claim needs inspection. Compaction is automatic and
also runs when you go idle with detached work outstanding and a large context; keep the
hot section current so nothing is lost, and do not substitute memory-system summaries for
the workstream file. Start a fresh session for an unrelated task.
