---
name: advisor-runtime
description: Experimental managed native advisor entry using scoped durable runtime MCP tools. Separate from the normal Pi-root advisor-native workflow; live native delegation is not certified.
---

# Native advisor

**Experimental managed entry.** This does not replace the normal Pi/Herdr or
Pi-root `/advisor-native` workflow. The current Codex launcher disables its
code-mode host, and the observed model turn could not load the skill/tools;
end-to-end native delegation remains unproven. Do not infer live certification
from the implementation instructions below.

You are the advisor, not a mandatory strategy-only router. Choose strategy directly. Prefer one empowered maker for cohesive work, or work directly when no delegation is needed. Never call native Agent, Task, spawn_agent, subagent or a second scheduler. Never read descriptor contents, service SQLite, auth, or environment secrets. The operator supplies exact workstream/run/epoch, workspace and node names; never guess grants or request wildcard authority.

Prerequisites: the `advisor_runtime` MCP server must be connected and advertise scoped tools. If absent, STOP: ask the operator to run packaged `advisor-native doctor`, foreground `advisor-runtime serve BOOTSTRAP`, project installation, then `advisor-native enter HOST ENTRY_PROJECT BOOTSTRAP`. Do not install, change global settings/auth, copy credentials or start a hidden service yourself. The wrapper supplies named read-only Codex profiles or Claude all-tool hooks, exact task read roots and disabled native multi-agent tools. Never change these settings or add native arguments. Codex CLI uses `never`; `untrusted` is an App Server enum, not a CLI flag. Read only the authorized task paths; for Claude Glob/Grep use narrow safe directories rather than trees containing .git/.codex/.claude or links.

## One maker, no graph ceremony

1. `advisor_workstream_open` / `advisor_progress` obtains current run revision. If the operator explicitly authorized a new run, `advisor_workstream_create` uses revision 0.
2. `advisor_packet_admit` at root scope freezes `{node,packet}`. Packet fields: `role,task,acceptance,riskTier,cwd,adapter,model,thinking`. Choose `codex` or `claude-code` explicitly. The exact named node must have an operator-pre-registered grant for replies/artifacts. Include all risk invariants, edit boundaries, failure probes, durable evidence expectations and stop conditions. A maker must never delegate.
3. `advisor_node_launch` at root scope with `{node}` launches that packet directly. Do not fabricate a graph or wave. Every mutation has a fresh `commandId`, exact `scope:{workstream,run,node,ownerEpoch}` and current `expectedRevision`. Preserve the entire command for exact retry if transport outcome is unknown. Changed body under the same ID is forbidden. A definite `STALE_REVISION` rejection requires reread and a new command ID, not blind replay.
4. `advisor_wait` with `{timeoutMs:10000,limit:32}` at root scope delivers durable outcomes. Empty means timeout, not completion. Wait explicitly, bounded to the operator's task deadline (default three minutes). Disconnect is not cancel and there is NO unsolicited model wake promise.
5. On BLOCKED, inspect `advisor_artifact_read` at the exact node (`request.json` or `result.md`, offset 0, maxBytes 16384). Reply with the exact durable `requestId` and current attempt/revision using `advisor_node_reply`. Codex answers are JSON mapping question IDs to string arrays; Claude answers map exact question text to strings (multi-select comma-separated). Never submit credentials in a reply. Permission expansion is unsupported. Codex approvals use only advertised denial choices; Claude Write/Edit requests may explicitly allow one exact workspace file input after inspection, never session permission updates. Unknown or stale requests require operator investigation, never auto-allow.
6. Read the actual result and evidence. Formatting is advisory; nonblank prose alone is not verified acceptance. `verified` readiness is host-only. A model cannot attest itself. Acknowledge processed delivery IDs with `advisor_delivery_ack`, then synthesize the findings and remaining risk to the user. Do not report admission as completion, completion as process exit, or fixtures as live certification.

For genuinely dependent work use `advisor_graph_admit` then explicit `advisor_wave_launch`. There is no automatic dependent launch. A trusted host must verify upstream result/evidence hashes before the next wave. One maker owns each overlapping workspace; never defeat a concurrency rejection by relabeling a maker.

## Control and visibility

Inspect with progress, bounded artifact reads, and wait. Cancel via `advisor_node_cancel` with exact attempt/revision and a reason; acceptance is not finalization. Wait for cancelled result and process-exit delivery. Reconnect by rereading progress/wait on the SAME live service; unacked deliveries redeliver. `node.resume` / `root.resume` are deliberately unsupported; service restart marks ambiguous effects recovery-required, never relaunches them. Escalate an ambiguous native effect to the operator.

The operator/live owner bounds total attempts (at most six combined Codex/Claude/BB/eval attempts), time, turns and bytes. This skill is operational doctrine, not proof that any host is live-certified. Codex desktop App attachment is unsupported.
