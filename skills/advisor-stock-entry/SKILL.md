---
name: meta-harness
description: Use the shared Meta runtime from an ordinary Codex or Claude Code CLI root when delegation helps. Keep normal direct work and one-worker tasks simple; no mandatory graph.
---

# Meta harness in a native CLI

You remain a normal coding agent with your host's tools, authentication and permissions. The runtime manages delegated work; it does not replace your judgment or sandbox your own work. This entry uses Herdr for visible workers and needs no Pi parent session.

## Choose the smallest useful workflow

- Work directly for a quick fix or cohesive task you can finish well yourself.
- Delegate one bounded task when a maker's fresh context, specialization or parallel effort helps. Small and medium tasks do not need a graph.
- Split genuinely independent work only. Give each writer an isolated worktree; do not edit its files concurrently.
- Follow the user's scope, safety and permission choices. Prefer existing code, standard libraries and simple implementations over new abstractions. Never trade away acceptance, security, accessibility or required checks for brevity.

## Delegate and finish

Use the connected `meta_harness` MCP tools, not a second native Agent/Task scheduler for the same work. Load only the skill needed for your current decision; workers load their own role skills. Do not read an entire checker or builder skill just to launch that role.

Give a worker a self-contained task, edit boundary and falsifiable acceptance checks. Include relevant context and paths, not your whole transcript. Allow reasonable local obstacle resolution within that boundary, with a short report of material deviations. Escalate decisions that change the accepted outcome, authorization or risk—not every recoverable toolchain problem.

Launch, message and cancel calls need an explicit unique `commandId`. Preserve the exact ID and arguments for transport-uncertain replay; never resend an ambiguous launch with a fresh ID. A definite rejection allows corrected arguments under a new ID. Acknowledgements use actual issued run and delivery IDs. Runtime-owned IDs and artifact paths are returned by tools: never invent them or supply a custom result path.

Admission means accepted work, not completion. Read status, then explicitly wait for a durable outcome; an empty wait is only a timeout. Native MCP does not promise an unsolicited wake after you end your turn. Continue bounded waiting while work is outstanding, or tell the user honestly that it remains active.

On BLOCKED, read `request.json`/`result.md` through `advisor_worker_artifact` before using `advisor_worker_message` for that exact run. Solve permitted local obstacles or provide an authorized decision; never send credentials as a reply. On completion, read the captured result, inspect changes and run relevant checks. A worker's PASS is a claim, not independent verification. Call `advisor_worker_ack` only after consuming that delivery.

Use a kept worker for a planned follow-up only when its state permits it. Cancel requests do not prove cancellation, process exit or pane closure. Recovery-required means inspect the reported worker; never blindly relaunch, adopt it, delete locks or kill unrelated processes.

Tool path: `advisor_worker_launch` → `advisor_worker_wait` / `advisor_worker_status` → `advisor_worker_artifact` → verification → `advisor_worker_ack`. `advisor_worker_list` and `advisor_worker_output` provide scoped visibility. Only an explicit first launch initializes a runtime; `STOCK_NOT_STARTED` on a read is not an instruction to start a worker just to get status.

Use `advisor_worker_runtime_close` when deliberately finishing this root's runtime, after all work and acknowledgements. It refuses active or uncertain work and never kills workers. A closed runtime is not silently replaced: use a new native conversation for later delegation.

## Review without ceremony

Review findings may be repaired inline when the reviewer has a bounded write grant. Keep findings and repairs attributable; repaired output is author verification, not independent review. Use independent verification for materially risky changes, and recheck the changed boundary rather than repeating a whole review. You own the final accept/revert decision and truthful user summary.

## Boundaries

Runtime tools authorize only this root's admitted workspaces and workers. Reconnecting MCP to the same live native session must not create a replacement run. A different session or ambiguous identity is not permission to adopt previous work. The runtime cannot widen your native host permissions or answer its trust dialogs. Missing tools, authentication and explicit approval requirements must be reported accurately.

Do not inspect runtime credentials, provider auth files or private service state. Do not change global settings to bypass a rejection. Worker processes receive no parent runtime authority. Nested stock-root use is unsupported; the existing explicit Pi foreman depth-one path remains separate.
