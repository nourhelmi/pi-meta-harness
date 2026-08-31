---
name: advisor-native
description: Start an isolated Pi advisor whose worker roles run through native Codex CLI or Claude Code according to the selected intelligence-profile model. Use only when the user explicitly invokes /skill:advisor-native.
disable-model-invocation: true
---

# Native-Worker Advisor Bootstrap

The root advisor remains Pi. Your first action is `advisor_session_init` with
`workerHarness: "native"`. Pass a concise workstream slug when the topic is
already clear; otherwise omit `workstream` so the Pi UI asks the user. If the
user cancels initialization, stop.

After initialization and before planning or delegation, complete both required
reads: resolve `../advisor/SKILL.md` relative to this skill's directory and use
`read` to load it completely, then use `read` to load the live
`advisor-intelligence.json` under `PI_CODING_AGENT_DIR` completely. Do not call
`bg_agent` until both reads are complete. The persisted native worker mode is
authoritative: keep semantic role names unchanged, and every `bg_agent` launch
must include an explicit `model` and `thinking` level selected with the live
guide. Omission is invalid. OpenAI models route to Codex CLI and
Anthropic/Claude models route to Claude Code.
