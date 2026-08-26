# Isolated advisor runtime

The advisor coordinates parallel Pi sessions through per-repository state under `~/.advisor/<repo-key>/`, resolved from the git common directory so all worktrees of one repository share one root and no repository carries personal runtime files. `advisor_session_init` reports the resolved root; `ADVISOR_STATE_DIR` overrides it for tests.

## Runtime rules

1. Launch every separate advisor with `advisor_launch`; it creates a new Herdr tab with `--no-focus`, never a pane split. A manually opened advisor may still invoke `/advisor` in its own fresh tab.
2. `advisor_session_init` creates or claims one isolated workstream and persists one worker mode: `pi` or `native`. The root advisor remains Pi in both modes.
3. Each live advisor must use a different workstream.
4. An advisor writes only its own session record, its owned workstream record, new immutable events, and unique run output.
5. Treat legacy in-repo `.advisor/` directories as read-only history.
6. Transfer ownership with an immutable handoff event.
7. Use Intercom for short conclusions and paths, not transcripts or raw logs.
8. Launch delegated LLM work only through a configured semantic `bg_agent` role. Workers remain panes in the owning advisor tab; use `bg_run` for shell commands. Pi mode runs selected identities through Pi. Native mode maps OpenAI identities to Codex CLI and Anthropic identities to Claude Code.
9. Every role launch needs a concrete completion anchor and a bounded result file.
10. Use the graph planner as a structural validator/linter and coordination aid before three or more nodes or mixed parallel and dependent work.
11. Parallel builders require explicit approval and separate worktrees.
12. Pane labels use `advisor · <purpose>` for advisor roots and `role · <purpose>` for workers, without run-id suffixes. Successful worker panes close automatically; blocked or unknown panes stay visible.
13. Keep a builder alive only for a planned bounded repair. Every checker starts fresh and may repair small qualifying findings inline under its role mandate.
14. Keep global advisor routines paused because open Pi processes share routine state.

The planner rejects malformed structure, cycles, invalid concurrency, and unsafe
parallel-builder checkout conflicts. Checker or browser nodes without builder
ancestors and reducers with low fan-in produce non-blocking warnings instead:
baseline browser investigation, checker audits, and small reduction shapes can
be intentional. Warnings are stored in the immutable graph manifest and tool
details so the advisor can confirm intent without manufacturing dependencies or
relabeling work. Execution waves remain deterministic DAG output; deciding
whether each node has enough information value remains the advisor's job.

## Roles and intelligence

[`../config/bg-agent-profiles.json`](../config/bg-agent-profiles.json) is fixed
semantic role configuration. It defines the instructed role skill and portable
skill path, anchor requirement, and instructional cycle cap. It contains no model
or reasoning policy and is never changed by intelligence switching.

The persisted worker mode is authoritative for every configured role launch; a
conflicting per-launch `harness` override is rejected. It changes transport, not
roles or intelligence policy:

- `pi`: `bg_agent` starts Pi and forwards the selected provider/model/reasoning.
- `native`: `openai-codex` and `openai` route to Codex CLI;
  `claude-bridge` and `anthropic` route to Claude Code. Native workers receive an
  automatically generated durable result path under the advisor state root.
  The path is reserved before launch. A successful settlement requires a
  nonempty artifact with the role-result headings; otherwise the run becomes
  `stalled` and its pane remains visible.

Every shipped intelligence profile remains usable in either mode, but a specific
recommendation is native-routable only when its provider maps to Codex or Claude.
Cursor/Grok has no provider-native route in this two-harness mode. The advisor
chooses a task-fit OpenAI/Anthropic recommendation from the same active guide or
reports the mismatch rather than silently changing the session mode.

Named guides in
[`../config/intelligence-profiles/`](../config/intelligence-profiles/) are the
advisor's source of model character and ordered role recommendations. Install
copies them to `~/.pi/agent/intelligence-profiles/` and materializes the active
guide as `~/.pi/agent/advisor-intelligence.json`. Switch mid-session with
`node ~/.pi/agent/bin/intelligence-profile.mjs <name>`. The default is
`codex-max`.

Recommendations are advisory, not exhaustive or enforceable. The advisor chooses
the best model and reasoning for the task from or outside the guide, using fit,
capability, cost, quota, and availability as judgment inputs. An outside-guide
choice needs only a concise rationale when material and never permission merely
for being unlisted. Worker launch and task execution do not reject an
outside-guide or changed identity; manifests retain launch and current identity
for audit. Quota is not polled — you pick the guide.

Deep dive (topology, spend, pick tree, recommendations, `/advisor` vs switcher):
[`intelligence-profiles.md`](intelligence-profiles.md).

## Start

From any Pi session running inside Herdr, call `advisor_launch` with the target
`cwd` and, when known, a concise `workstream`, `purpose`, and `workerHarness`.
The tool creates an unfocused Herdr tab, labels its root pane
`advisor · <purpose>`, starts Pi there, and sends `/skill:advisor-pi` or
`/skill:advisor-native` when the mode is explicit. If it is omitted, the new Pi
advisor uses `/skill:advisor` and asks in the UI. The new advisor still calls
`advisor_session_init` as its first action.

For a tab opened manually, invoke `/advisor` or `/skill:advisor` to choose the
mode interactively, or invoke `/skill:advisor-pi` / `/skill:advisor-native` to
choose directly. Enter a short workstream name if Pi asks. Do not use a pane
split for a separate advisor. No advisor shell launcher is required.
