# Isolated advisor runtime

The advisor coordinates parallel Pi sessions through per-repository state under `~/.advisor/<repo-key>/`, resolved from the git common directory so all worktrees of one repository share one root and no repository carries personal runtime files. `advisor_session_init` reports the resolved root; `ADVISOR_STATE_DIR` overrides it for tests.

## Runtime rules

1. Launch every separate advisor with `advisor_launch`; it creates a new Herdr tab with `--no-focus`, never a pane split. A manually opened advisor may still invoke `/advisor` in its own fresh tab.
2. `advisor_session_init` creates or claims one isolated workstream.
3. Each live advisor must use a different workstream.
4. An advisor writes only its own session record, its owned workstream record, new immutable events, and unique run output.
5. Treat legacy in-repo `.advisor/` directories as read-only history.
6. Transfer ownership with an immutable handoff event.
7. Use Intercom for short conclusions and paths, not transcripts or raw logs.
8. Launch delegated LLM work only through a configured `bg_agent` role. Workers remain panes in the owning advisor tab; use `bg_run` for shell commands.
9. Every role launch needs a concrete completion anchor and a bounded result file.
10. Validate graphs before three or more nodes or mixed parallel and dependent work.
11. Parallel builders require explicit approval and separate worktrees.
12. Pane labels use `advisor · <purpose>` for advisor roots and `role · <purpose>` for workers, without run-id suffixes. Successful worker panes close automatically; blocked or unknown panes stay visible.
13. Keep a builder alive only for a planned bounded repair. Every checker starts fresh and may repair small qualifying findings inline under its role mandate.
14. Keep global advisor routines paused because open Pi processes share routine state.

## Intelligence map

Named profiles in [`../config/intelligence-profiles/`](../config/intelligence-profiles/)
are the source of truth. Install copies them to `~/.pi/agent/intelligence-profiles/`
and materializes the active one as `bg-agent-profiles.json`. Switch mid-session
with `node ~/.pi/agent/bin/intelligence-profile.mjs <name>`. The default is
`codex-max`. [`../config/bg-agent-profiles.json`](../config/bg-agent-profiles.json)
is a checked copy of `codex-max` for readers.

Cursor may only appear as `cursor/grok-4.6`. Role `allowedModels` and character
notes live in the active profile file. The advisor selects one allowed model
based on those characters. Role skill text must not hard-code a different model.
Quota is not polled — you pick the map.

Deep dive (topology, spend, pick tree, per-role allowlists, `/advisor` vs
switcher): [`intelligence-profiles.md`](intelligence-profiles.md).

## Start

From any Pi session running inside Herdr, call `advisor_launch` with the target `cwd` and, when known, a concise `workstream` and `purpose`. The tool creates an unfocused Herdr tab, labels its root pane `advisor · <purpose>`, starts Pi there, and sends the `/skill:advisor` bootstrap. The new advisor still calls `advisor_session_init` as its first action.

For a tab opened manually, invoke `/advisor` or `/skill:advisor` and enter a short workstream name if Pi asks. Do not use a pane split for a separate advisor. No advisor shell launcher is required.
