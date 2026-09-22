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

After initialization the advisor doctrine core is in your system prompt; do not read `../advisor/doctrine.md` or
`advisor-intelligence.json` with a tool. The persisted Pi worker mode is
authoritative: keep semantic role names unchanged. When the external agent router
is enabled, it owns model/thinking selection: omit both from `bg_agent` unless the
user explicitly pins a model (and optionally effort), and never bypass router
failure. Otherwise the live intelligence guide is injected and every `bg_agent` launch
must include explicit `model` and `thinking` selected from it.
