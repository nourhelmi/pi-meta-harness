# Isolated advisor runtime

The advisor coordinates parallel Pi sessions through per-repository state under `~/.advisor/<repo-key>/`, resolved from the git common directory so all worktrees of one repository share one root and no repository carries personal runtime files. `advisor_session_init` reports the resolved root; `ADVISOR_STATE_DIR` overrides it for tests.

## Runtime rules

1. Start or focus a fresh Pi session in Herdr and invoke `/advisor`.
2. `advisor_session_init` creates or claims one isolated workstream.
3. Each live advisor must use a different workstream.
4. An advisor writes only its own session record, its owned workstream record, new immutable events, and unique run output.
5. Treat legacy in-repo `.advisor/` directories as read-only history.
6. Transfer ownership with an immutable handoff event.
7. Use Intercom for short conclusions and paths, not transcripts or raw logs.
8. Launch delegated LLM work only through a configured `bg_agent` role. Use `bg_run` for shell commands.
9. Every role launch needs a concrete completion anchor and a bounded result file.
10. Validate graphs before three or more nodes or mixed parallel and dependent work.
11. Parallel builders require explicit approval and separate worktrees.
12. Successful worker tabs close automatically. Blocked or unknown tabs stay visible.
13. Keep a builder alive only for a planned bounded repair. Every checker starts fresh and may repair small qualifying findings inline under its role mandate.
14. Keep global advisor routines paused because open Pi processes share routine state.

## Intelligence map

The source of truth is [`../config/bg-agent-profiles.json`](../config/bg-agent-profiles.json).

| Model | Default use | Reasoning |
| --- | --- | --- |
| Sol | planning and difficult backend, data, or service work | high; xhigh or max only for hard debugging |
| Luna | scouting, mechanical chores, procedural-tier checks, and browser verification | max |
| Opus | genuinely new or greenfield UX | medium |
| Terra | adversarial-tier checks, final whole-diff review, reduction, tests, and minor existing-UX changes | xhigh |
| Grok | research, bounded backend, mixed stack, substantial existing-UX work, and Opus fallback | high |

| Role | Allowed models | Cap |
| --- | --- | ---: |
| Scout | Luna, Terra, Grok | 3 |
| Planner | Sol | 3 |
| Reducer | Terra | 2 |
| Builder | Sol, Opus, Terra, Luna, Grok | 6 |
| Checker | Terra, Luna | 5 |
| Browser verifier | Luna, Terra | 5 |

The advisor selects one allowed model based on the task. Role skill text must not hard-code a different model.

## Start

1. Open or focus a fresh Pi session in Herdr.
2. Invoke `/advisor` or `/skill:advisor`.
3. Enter a short workstream name if Pi asks for one.

No advisor shell launcher is required.
