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

After initialization the advisor doctrine core and the live intelligence guide
are in your system prompt; do not read `../advisor/doctrine.md` or
`advisor-intelligence.json` with a tool. The persisted native worker mode is
authoritative: keep semantic role names unchanged, and every `bg_agent` launch
must include an explicit `model` and `thinking` level selected with the guide
in your system prompt. OpenAI models route to Codex CLI and Anthropic/Claude
models route to Claude Code.
