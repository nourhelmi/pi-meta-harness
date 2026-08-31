---
name: advisor-pi
description: Start an isolated Pi advisor whose worker roles also run through the Pi harness while models and reasoning follow the active intelligence profile. Use only when the user explicitly invokes /skill:advisor-pi.
disable-model-invocation: true
---

# Pi-Worker Advisor Bootstrap

The root advisor and every worker use Pi. Your first action is
`advisor_session_init` with `workerHarness: "pi"`. Pass a concise workstream
slug when the topic is already clear; otherwise omit `workstream` so the Pi UI
asks the user. If the user cancels initialization, stop.

After initialization and before planning or delegation, complete both required
reads: resolve `../advisor/SKILL.md` relative to this skill's directory and use
`read` to load it completely, then use `read` to load the live
`advisor-intelligence.json` under `PI_CODING_AGENT_DIR` completely. Do not call
`bg_agent` until both reads are complete. The persisted Pi worker mode is
authoritative: keep semantic role names unchanged, and every `bg_agent` launch
must include an explicit `model` and `thinking` level selected with the live
guide. Omission is invalid.
