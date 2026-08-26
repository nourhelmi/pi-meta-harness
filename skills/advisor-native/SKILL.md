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

After initialization, resolve `../advisor/SKILL.md` relative to this skill's
directory, use `read` to load it completely, and follow that advisor doctrine
for the rest of the session. The persisted native
worker mode is authoritative: keep semantic role names unchanged, choose model
and reasoning from the live intelligence profile, and let `bg_agent` route
OpenAI models to Codex CLI and Anthropic/Claude models to Claude Code.
