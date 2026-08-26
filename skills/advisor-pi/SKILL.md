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

After initialization, resolve `../advisor/SKILL.md` relative to this skill's
directory, use `read` to load it completely, and follow that advisor doctrine
for the rest of the session. The persisted Pi
worker mode is authoritative: keep semantic role names unchanged and choose
model and reasoning from the live intelligence profile.
