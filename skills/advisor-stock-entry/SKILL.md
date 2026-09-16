---
name: meta-harness
description: Use the shared Meta runtime from an ordinary Codex or Claude Code CLI root when delegation helps. Keep normal direct work and one-worker tasks simple; no mandatory graph.
---

# Meta harness in a native CLI

You remain a normal coding agent with your host's tools, authentication and permissions.
The runtime manages delegated work; it does not replace your judgment. This entry uses
Herdr for visible workers and needs no Pi parent session.

## Choose the smallest useful workflow

Work directly for anything you can finish well. Delegate one bounded task when fresh
context, specialization or parallel effort helps. Split only genuinely independent work,
one writer per worktree. Roles are `advisor`, `builder` and `checker`; all three
investigate, plan, implement and verify in scope, and checkers repair what they find.
Give a worker a self-contained packet: goal, decided versus suggested, edit boundary and
non-goals, a done-when line with its proving command, relevant paths, stop conditions.
Let it clear local obstacles; escalate changed authority, safety or product decisions
only. Browser verification belongs to whoever changes behavior: trace the diff to the
affected journeys and exercise them against the integrated app, or state why none are
affected. Use the connected `meta_harness` MCP tools, never a second native scheduler
for the same work, and do not read a whole role skill just to launch that role.

## Runtime mechanics

Launch, message and cancel calls need an explicit unique `commandId`. Preserve the exact
ID and arguments for a transport-uncertain replay; never resend an ambiguous launch with
a fresh ID. Runtime-owned IDs and artifact paths come back from tools; never invent them.
Admission is not completion: read status, then wait explicitly for a durable outcome; an
empty wait is only a timeout, and native MCP promises no unsolicited wake after your
turn ends. Read the handoff, the recorded transcript and actual artifacts as useful; a
worker's PASS is a claim, not verification. Use the exact run for follow-up and
`keepAlive` only as a cleanup preference. Acknowledge consumed deliveries. Historical
deliveries keep their original attempt; cancellation acceptance does not prove exit; use
supported reconciliation rather than blind resends or lock deletion.

Tool path: `advisor_worker_launch` → `advisor_worker_wait` / `advisor_worker_status` →
`advisor_worker_artifact` → verification → `advisor_worker_ack`. `advisor_worker_list`
and `advisor_worker_output` provide visibility. Only an explicit first launch initializes
a runtime; `STOCK_NOT_STARTED` on a read is not an instruction to launch. Use
`advisor_worker_runtime_close` when deliberately finishing this root's runtime; active
work and pending notifications stay protected.

## Review and delivery

A checker repairs findings within the accepted outcome and owned surface, reruns affected
checks and journeys, and reports the post-repair state; its original assessment is
independent and its own fixes are maker work. You own final acceptance and the truthful
user summary. Follow the repository's checks and
required agentic PR review for the current PR revision; a pending, unavailable or stale
required verdict is an unmet gate that a local checker, green tests or an old verdict
cannot substitute for. Do not invent review where none is required, or add or change CI,
publish verdicts or merge without scope and authorization.

Graphs are optional plans; `advisor_worker_graph_evidence` records owned runs and
evidence references. A successor association does not cancel its predecessor or transfer
a write surface. Keep one current operational checkpoint (decisions, ownership, handles,
done-when, evidence locators, next action); update it on material changes, not every
read or status tick, and recover from it rather than parallel memory diaries.

## Boundaries

Runtime tools authorize only this root's admitted workspaces and workers. Reconnecting
MCP to the same live session must not create a replacement run; a different or ambiguous
identity is not permission to adopt previous work. The runtime cannot widen native host
permissions or answer trust dialogs. Do not inspect runtime credentials or private
service state, or change global settings to bypass a rejection. Nested stock-root use is
unsupported; the scoped Pi child-advisor path needs a runtime-issued parent grant.
