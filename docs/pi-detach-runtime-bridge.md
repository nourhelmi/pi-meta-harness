# Managed Pi / Herdr runtime

A managed Meta installation uses the shared non-LLM runtime automatically when Pi
starts inside Herdr. Pi owns the public tools, the service owns durable execution
records and delivery, and Herdr hosts visible workers. No manual descriptor or
per-task packet file is needed. See [runtime contract](advisor-durable-runtime.md)
for storage, authorization and replay details.

## Install and diagnose

Install matching Meta and pi-detach revisions. Meta copies the runtime/core helpers,
extensions, skills and runtime configuration into the Pi agent directory. Pi-facing
imports support Node22.19+; the SQLite owner needs Node24.18+ and pi-detach's shipped
TypeScript loader.

```sh
node scripts/meta-harness.mjs install --target /private/test/pi-agent \
  --runtime-node /absolute/path/to/node
node scripts/meta-harness.mjs doctor --target /private/test/pi-agent
```

Use `--live` only for an authorized real installation. Installation changes files,
not already-loaded service code, and never reloads Pi. `/bg_backend` reports the
connection and installed-versus-loaded revision without launching a worker. A client
`/reload` reconnects; a service-code upgrade is a separate safely coordinated action.
Do not restart active work to make a revision warning disappear.

## Session and workspace identity

Startup binds the actual SessionManager ID, canonical cwd, host/package paths and
Herdr context. Private state defaults to `~/.pi-runtime/<identity-hash>`, outside
worker workspaces. Unix sockets have an operating-system path-length limit; choose
a shorter private state base when needed.

Registered worktrees of the same Git repository can be discovered after startup.
The trusted Git repository identity determines eligibility, not a caller-provided
list of directories. Adding/removing an unused worktree does not change the owning
conversation identity or require transferring it. Unrelated workspaces, escaping
aliases and control/workspace overlap remain rejected.

`advisor.bind` records workstream/harness metadata without replacing the transport
identity or creating a new family. Child advisors receive scoped grants, never the
parent credential. Runtime accounting preserves histories across descendants but
there is no cumulative launch/reply/task quota.

## Launch, converse and finish

- Use `bg_agent` with a task and appropriate context. A role selects useful
  instructions: advisor, builder, or checker. Advisors plan and synthesize; all
  authors investigate and verify their work, including affected browser journeys.
  No graph or separate investigation/planning/browser stage is required.
- Omit managed `agent` and `resultPath` compatibility overrides. The resolver and
  runtime own transport and artifact identity; use `role` and `harness`. Supply `model`
  (and optional `thinking`) only as an explicit pin when the external router is enabled;
  without it, legacy explicit/default model selection is unchanged.
- A receipt proves admission, not prompt delivery or task completion. Fresh launch
  transport timeouts replay the same tool-call ID for up to 60 seconds; concurrent
  replays wait for the original admission instead of preparing a second worker.
  If it remains unconfirmed, inspect `bg_list` before any new launch. Correct a
  definite pre-effect rejection under a new call; never retry uncertain delivery
  as a fresh launch.
- Use the returned opaque `pib-…` run ID for follow-up, output and stop. Current
  identity-checked transport determines whether input can be accepted. Busy advice
  is queued only through a supported messaging path; no typing through trust,
  permission or credential dialogs.
- `keepAlive` is a cleanup preference. Missing/blank/incomplete summaries do not
  suppress completed-turn notification or themselves prohibit ordinary follow-up.
  A closed/mismatched session must be reported honestly, not silently replaced.
- `bg_stop` requests explicit cancellation; a completed stop is idempotent. An
  accepted Escape is not proof of process exit. Relevant children remain separately
  visible and protected from workspace teardown.
- Parent turn completion and descendant activity are separate facts. A child advisor
  that parks at its composer without a terminal report while its descendants still run
  is held open: the parent sees a progress note and one settlement on the final turn.
  Integrated delivery still requires the actual accepted work to be complete.

### Cross-harness messages

Use `agent_message` for scoped questions, advice and replies between Pi, Codex CLI
and Claude Code workers and their advisor. The shared `list/send/reply/status/wait`
contract is exposed as a Pi tool, native MCP tool and CLI; no team enlistment or
separate message-board service. See [agent messaging](agent-messaging.md) for examples,
identity boundaries and honest delivery/retry semantics.

### Optional external agent router

In Pi, `/jev-router on|off` controls **this session's future launches**. Commands wait
for the current turn to finish, then change the authenticated host's durable gate and
show its acknowledgement. `/jev-router` (or `status`) reports actual host state.
`/jev-router config` uses a native dialog to save the default for **new sessions only**;
Escape cancels without writing. No JSON editing is needed for ordinary switching.
OFF restores ordinary model selection for new workers, without router quota/lease
admission. It is not merely disabling Jev scoring; existing routed leases keep their
normal renewal and release behavior.

The compact status occupies a native row below the input, in the footer area. This
stays visible even when a custom footer truncates other extension statuses; it never
replaces the existing footer. ON/OFF, configuration error, disconnected/unknown and
old-host restart-required are distinct. ON means routing is enabled, not that provider
quota is available or that Jev rather than deterministic fallback won a decision.

Future defaults live in private `~/.pi/agent/jev-router.json` (respecting
`PI_CODING_AGENT_DIR`). Initially the existing `~/.config/agent-router/config.pi.json`
is preferred, then `config.json`; the template's enabled flag supplies the initial
default. Explicit `AGENT_ROUTER_CONFIG` selects both source and initial mode instead.
A new host snapshots the complete template in its private owned control directory,
retaining the original shared quota/lease state and credential/benchmark **paths**—not
copying credential contents. The immutable snapshot stays enabled for lifecycle
operations; only the separate session gate changes. Original global router configs,
profiles and other sessions are untouched. The router must already be installed and
configured; missing setup cannot be enabled by pretending it is ready.

Resume/reload reuse the session gate and snapshot. New/forked top-level sessions use
future defaults; same-session tree navigation does not rewind this operational switch.
New approved descendants inherit their parent's mode/config at preparation, then own
independent controls. Changes never broadcast to existing children or other sessions.
A prepare captures the gate before its first await, so an already-preparing launch
finishes under that captured mode. Turning OFF does not cancel it, reroute workers,
clear leases, stop renewal, or change followup/release/recovery behavior.

`router.status` and generation-checked `router.set` reuse the authenticated `pi.detach`
channel. Public model tools cannot select control paths/modules. Lost acknowledgements
show unknown; they do not cause automatic retry or rollback. Root and child advisor
prompts and fresh-launch guards read the same host state. Old hosts without this
capability require a **new Pi session**; `/reload` changes only the client. No restart,
adoption of uncertain work, or migration over old leases is attempted.

Nonmanaged/native-root callers retain the original trusted config path behavior.
Enabled config must name an absolute module implementing `route`, `renew`, and
`release`; invalid config/module and no-feasible-route results reject the launch
rather than falling back.

Routing wraps the managed execution port's side-effect-free prepare boundary. The original
port first validates the public request and resolves role/harness policy, the router selects
model/thinking (respecting caller pins), then the original port prepares the exact selected
identity. The router never builds provider commands and no tool parameter can select its
module. The decision ID and selected identity are durable execution metadata. Existing
workers are never rerouted. Fresh launches, followups and queued messages await successful
renewal before submitting input; an expired/released lease fails closed. Renewal calls are
serialized, including across release. Blocked/in-progress and uncertain launches retain
capacity until definitive resolution.

V1 uses **conservative keepAlive lifetime accounting**: terminal idle turns keep the same
reservation and keep renewing it. Only non-keepAlive terminal turns release automatically.
Terminal turns do not release kept-worker reservations; there is no unreserved continuation
or reservation resurrection. A followup can set
`keepAlive: false` to release at its final terminal turn. `bg_stop` on an already-completed
kept worker does not send Escape and does not release capacity. To end that idle worker,
close its exact owned pane: the reservation monitor observes `BRIDGE_SESSION_UNAVAILABLE`
on the next renewal cycle (30 seconds by default), releases, and marks recovery for
observation-only reconciliation. Identity mismatch is not proof of closure.

Renewal loss fences further input, attempts an identity-checked safety interrupt using
`DriverHandle.interrupt` (including descendant cancellation), and reports
`BRIDGE_ROUTER_LEASE_LOST` through `recoveryRequired`. It never calls the forbidden raw
`stop()` or synthesizes an admitted cancellation, successful result, or process exit.
Recovery is marked after the Escape attempt because it fences the driver's ownership hooks;
a subsequently fenced stop observation is uncertain and does not release capacity. Failed
or ambiguous interruption requires explicit inspection/closure and reconciliation; a missing
recorded handle never authorizes a guessed pane or replay. External lease expiry cannot be
undone, so recovery cannot promise capacity remains reserved after lease loss.
Normal service shutdown refuses still-owned routed kept workers with
`SHUTDOWN_ROUTED_WORKER_ACTIVE`; close/reconcile them first rather than abandoning renewal.
Crashes or forced process termination still require recovery and cannot preserve an expired lease.

There are no semantic message/result byte ceilings or fixed graph node/repair
quotas. Large output is read in pages rather than rejected or silently replaced by
an empty report. Provider and machine capacity errors remain real errors.

## Handoffs and transcript retrieval

Completion notifications give execution state and useful report/evidence references.
The worker's summary is an optional index, not the only source of truth. Captured
reports retain attempt and producer attribution, and original captures are not
rewritten by later work.

Managed `bg_output` offers explicit recorded-transcript access as well as terminal
output. Search can find early messages/tool results beyond the pane tail and return
paged context with stable locators. The run's bound provider/session selects the
recorded history; arbitrary file paths or another run's conversation are not inputs.
Unsupported or unavailable history is reported explicitly. Transcript content is
recorded data, not new authority or an implicit instruction to execute its commands.

```js
// Search the entire recorded conversation, not just recent terminal lines.
bg_output({ runId: "pib-…", source: "transcript", grep: "migration decision", context: 2, limit: 20 })
// Read records in order; continue using the returned nextCursor.
bg_output({ runId: "pib-…", source: "transcript", cursor: 0, limit: 20 })
// A large record returns a projection plus an exact entryRef for byte paging.
bg_output({ runId: "pib-…", source: "transcript", entryRef: "<returned ref>", offset: 0, maxBytes: 16384 })
```

Transcript `grep` is literal, case-insensitive text; terminal `grep` remains a
regular expression. The stock-native equivalent is `advisor_worker_output` with
`source: "transcript"` and `query` instead of `grep`. Follow `nextCursor` for records
or `nextOffset` until `eof` for a large record. Byte pages include base64 for lossless
reassembly across UTF-8 boundaries. Paging/search does not discard recorded history
or make historical branches current instructions.

Use source files, patches, plans, probe scripts, captured tool results and host check
records where they answer the question. A PASS summary or historical successful
command does not certify the current checkout. Stale proof is visible but does not
veto unrelated tasks. Optional graph/evidence metadata records context and revisions,
not permission to launch.

## Reconnect, recovery and shutdown

The service owns worker observation; the Pi client owns notification consumption.
The client reconnects automatically after a transport failure. Durable deliveries
retain their IDs and ACKs are idempotent. Persisted Pi `custom_message` receipts
prevent lost ACKs or reload from duplicating an already delivered notification.

A lost connection is not cancellation. Recovery must inspect the recorded worker
identity before restoring observation or accepting new work. Never blindly resend an
ambiguous prompt, attach an arbitrary pane, delete owner locks or kill unrelated
processes. Safe underlying error codes distinguish preparation, submission and
observation failures; unknown ownership stays unknown.

Use `/bg_reconcile pib-…` to inspect the exact recorded worker and restore
observation when its identity is provable. Stock-native roots use
`advisor_worker_reconcile`. Reconciliation does not resend old input. A missing
identity/recorded session is a real limit: inspect before explicitly replacing the
work, rather than making an uncertain execution look successful.

`/bg_runtime_close` does not synthesize cancellation. Active or unresolved live work
and relevant children remain protected. Unacknowledged notifications are durable
records, not a reason to keep otherwise idle execution alive forever. Captures and
history survive shutdown/reconnect.

Standalone pi-detach and the explicit legacy backend remain supported separately.
Do not change backend around active work or silently import legacy ownership. The
managed source/history options and lifecycle behavior described here do not imply
that every legacy transport has the same capabilities.

## Verify paired changes

```sh
PI_DETACH_TEST_PACKAGE=/matching/pi-detach npm test
PI_DETACH_TEST_PACKAGE=/matching/pi-detach node --import tsx tests/bridge/pi-detach-product.ts
npm run typecheck
# matching pi-detach:
npm run typecheck && npm test
```

The paired product test uses real runtime/SQLite/port code with fake Herdr/provider
boundaries. It is not a live model certification. Before activation, review exact
identity, replay, cancellation, transcript scope and persisted-data compatibility.
Use isolated fixtures for fault injection; never mutate a working user's runtime
as a test fixture.
