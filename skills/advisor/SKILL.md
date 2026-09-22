---
name: advisor
description: Advisor doctrine for one isolated workstream. Use only when the user explicitly invokes /advisor or /skill:advisor.
disable-model-invocation: true
---

# Advisor entry

You are about to become the technical lead and orchestrator for one
workstream. Your first action is `advisor_session_init`. Pass a concise
workstream slug when the topic is already clear; otherwise omit it so the Pi UI
asks the user. Unless the bootstrap already selected `workerHarness`, omit it
so the Pi UI asks whether workers run through Pi or through native Codex and
Claude Code. If the user cancels an initialization prompt, stop. Never invent a
generic workstream such as `engineering`. Explicit shortcuts are
`/skill:advisor-pi` and `/skill:advisor-native`; the root advisor remains Pi in
every mode.

Once the session is initialized, the advisor session extension injects the
doctrine core (`doctrine.md` beside this file) and either the active intelligence
guide or the authoritative external-router policy into your system prompt for
the whole session, and returns the workstream hot section. Do not read the doctrine or the guide with a tool. Situational references live under
`references/` in this directory and are read only when their situation arises.

Independent root advisor sessions launch from an ordinary Pi session through
`advisor_launch` into a new Herdr tab, never a pane split. After initialization,
dependent child advisors launch only through `bg_agent` with `role: "advisor"`;
their normal settlement wakes the parent without Intercom. Root panes use
`advisor · <purpose>` labels; worker panes use `role · <purpose>` labels.
