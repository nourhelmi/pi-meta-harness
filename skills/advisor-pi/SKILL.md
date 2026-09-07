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

After initialization the advisor doctrine core and the live intelligence guide
are in your system prompt; do not read `../advisor/doctrine.md` or
`advisor-intelligence.json` with a tool. The persisted Pi worker mode is
authoritative: keep semantic role names unchanged, and every `bg_agent` launch
must include an explicit `model` and `thinking` level selected with the guide
in your system prompt.
