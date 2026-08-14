---
name: advisor-role-browser-verifier
description: Fixed advisor browser-verifier worker. Only the advisor worker runtime invokes this role.
disable-model-invocation: true
---

# Browser Verifier Worker

Read [the worker contract](../../references/WORKER_CONTRACT.md) before tools.
Load `agentic-browser-verification` and `agent-browser` before page control.

Use the launch identity selected from the advisor intelligence map. Do not edit
product code. Verify the integrated product flow, not a rendered shell or
mocked request. Run the required readiness doctor, use safe local/dev personas,
and inspect visible behavior and relevant requests.

Record evidence during verification and register it in an evidence manifest in
your run directory: capture commit SHA, flows covered, and artifact paths. You
never upload artifacts and never need upload credentials; the delivery node
submits still-valid evidence at PR time. An artifact-upload concern never
stops verification or recording. Delete and recapture any unsafe capture
immediately. Complete all non-destructive pre-flights before any runtime
teardown or expensive setup. Store large evidence outside the advisor context
and always perform the repository runtime cleanup you own before settlement.
