# Durable advisor runtime component (Node 24)

This component is the single command authority for **new** runtime-owned runs.
It does not launch a model by itself. Native adapters, Pi opt-in integration,
BB and packaging are separate components; no concrete native host is certified
by these deterministic tests. Existing pure PAR-1A files/oracles are unchanged.

This is additive infrastructure, not a replacement for Pi/Herdr. Without
`ADVISOR_RUNTIME_DESCRIPTOR`, the Pi runtime extension registers no tools or hooks;
normal Pi/Herdr operation remains unchanged. The managed [native integration](advisor-native.md)
is experimental: its current Codex code-mode-host setting prevents the observed
model turn from loading skills/tools, and actual native delegation is unproven.

## Entry points and bootstrap

- `scripts/advisor-runtime/runtime.mjs`: `AdvisorRuntime` trusted host library.
- `service.mjs`: `startService(runtime)`, `callSocket(credential, command, audience)`.
- `cli.mjs`: `node …/cli.mjs call PRIVATE_CREDENTIAL.json` (one JSON command on
  stdin); `mcp PRIVATE_CREDENTIAL.json` (newline-framed MCP stdio); or
  `serve PRIVATE_BOOTSTRAP.json` (foreground, no native adapters by default).
- `cli.mjs` also exports `host(config, adapters)` for trusted native integration.
  Clients never choose a module, executable, arbitrary shell command, adapter
  implementation, authentication principal, or SQL/event writer.

### Optional Pi model transport

Pi can act as an optional model client of an already running shared service by
setting `ADVISOR_RUNTIME_DESCRIPTOR` to the trusted advisor principal's private
mode-0600 credential descriptor before the extension loads. The extension
registers one `advisor_runtime` tool, re-reads and validates the descriptor for
every call, always uses audience `model`, and bounds model-visible responses to
50 KiB. It returns only typed runtime responses or a generic availability error;
the credential, descriptor path, socket path and raw local errors are never
returned.

Opt-in is fail-closed: `bg_agent` and `bg_stop` are blocked in Pi's public
pre-effect `tool_call` hook even if the descriptor is later missing, malformed,
revoked or unavailable. With the environment variable absent, the extension
registers no tool or hook and existing Pi/Herdr worker tools operate unchanged.
This is a model transport only: it does not create a runtime, select a provider,
take over a Pi session/root, launch a native worker itself, or change pi-detach.

Construct `new AdvisorRuntime({stateRoot, allowedRoots, adapters})`. State root
must be realpath-canonical, owned by the current OS user, mode 0700 (a new root
is created with that mode). Use Node 24 LTS; tests pin 24.18.0. No Pi/Herdr import
or hardcoded machine/home path is needed. Unix socket paths must fit 100 bytes;
use a short private state directory. No TCP listener exists.

A **trusted local operator**, not an MCP command, calls:

```js
const token = runtime.registerPrincipal({
  id: 'native-root-1', kind: 'advisor',
  scopes: [
    {workstream: 'work', run: 'run-1', node: 'root'},
    {workstream: 'work', run: 'run-1', node: 'maker'}
  ],
  operations: ['workstream.create', 'workstream.open', 'packet.admit',
    'graph.admit', 'wave.launch', 'progress', 'node.reply', 'node.cancel',
    'wait', 'delivery.ack', 'artifact.read', 'log.read']
});
```

Persist the returned token **once**, using `writeCredential(path,
{socketPath, token}, runtime)` to an exclusive mode-0600 file in a private directory.
The owning runtime is required: it reserves the credential path durably and rejects
state/control/descriptor/bootstrap overlap with any declared worker workspace,
including symlink aliases and unsafe missing parents. Registration and commands
revalidate storage boundaries. State and worker workspace must be disjoint.
The database stores only its hash. Do not put the token into prompts,
transcripts, logs, frontend state, model arguments, events, or realtime messages.
The MCP host reads the credential file; it never returns its content.
`revokePrincipal(id)` is durable and checked before every read/replay, including
wait completion. IDs cannot be re-registered; issue a new principal after revocation.

Scopes and operations are exact lists, with no wildcard. Root scope alone does
**not** grant child identities: packet/direct/graph/wave targets and dependencies
require every referenced node grant. Root fleet snapshots/history/wait require
grants for every included packet/node; delivery acknowledgment checks its target.
Worker artifact access and worker reply/cancel also require that exact scope. A `worker` principal
cannot have root scope or any mutation except delivery ack; it cannot launch
nested workers. MCP always uses audience `model`, which rejects operator
credentials; an advisor's operational list is explicitly registered, not
inherited operator authority. Credential file access is a trusted local process
boundary, not a sandbox against another malicious process running as the same UID.

Foreground bootstrap JSON has `stateRoot`, `allowedRoots`, `principals` and optional trusted `providerHomes` (exact `codex` / `claude-code` paths). Native `init` emits explicit homes under state/providers; these are auth/control state, never model file grants. Each initial principal entry is `{principal: registration, credentialPath}`. Native startup inventories the homes with `controlDirectories`; SQLite persists them and a read-only startup check rejects widened workspace grants or changed directories before writes. Provider-to-home mapping is bound to exact bootstrap identity. See advisor-native.md for named Codex profiles, Claude all-invocation hooks and the separate installed entry project with exact task read roots.
On clean restart pass the **same complete legitimate bootstrap** and keep its
existing private credential files. Transactional bootstrap identity must match;
changed registrations/paths, foreign or missing credentials, and revoked
principals fail closed. There is no silent rotation, adoption or resurrection.
A partial first bootstrap (SQL committed but credential file missing) requires
operator investigation; retry never replaces a missing token. Empty principals
are not a restart shortcut. Unproven effects still require recovery, never relaunch.
Use `host(config, adapters)` rather than a client-selectable adapter import.
Registration occurs before listening. Keep bootstrap files private.

A typed `credential` (or adapter-normalized `secret`) BLOCKED request cannot be
answered by node.reply/root.reply: `CREDENTIAL_REPLY_FORBIDDEN` rejects before
receipt, effect, event or history persistence. Use supported first-party login
out of band; never paste credentials into replies. Cancel the blocked turn and
start a separately authorized fresh attempt if stored resume is unsupported.
This is type-based rejection, not a claim to detect arbitrary secrets in prose.

## Versioned operational contract

Read requests: `{v:1, op, scope, payload}`. Mutation requests additionally require
`commandId` and `expectedRevision`. Scope is always
`{workstream, run, node, ownerEpoch}`. Names use PAR-1A ASCII IDs (1–128 bytes,
letters/digits first, then letters/digits/underscore/hyphen). Unknown fields,
operations, versions, non-JSON values, unsafe integers and oversized text reject.

New run epoch is 1. Epoch is a durable **run ownership** identity; an ordinary
service restart does not change it. A separate per-service SQL nonce fences all
transactions. A future ownership migration must deliberately advance the run
epoch; no migration/adoption command is provided here. Authorization and epoch
checks precede receipt or artifact disclosure. Same global command ID and exact
semantic body returns the original receipt even after revisions advance; a changed
body/scope or principal rejects. New commands compare-and-commit revision under
`BEGIN IMMEDIATE`, atomically persisting state, receipt, canonical rows and outbox.

`{ok:true,receipt,replayed}` is admission, **not** native completion. Rejections are
`{ok:false,error:CODE}` and carry neither receipts nor arbitrary exception text.
Read responses are `{ok:true,value}`. Root mutations use the run revision from
`progress`/`workstream.open`; node mutations use the node revision. A worker-scoped
ack uses its node revision; a root-scoped ack uses the run revision. Reads intentionally
have no revision precondition so reconnect can discover the current revision;
mutation CAS and read authorization/epoch remain mandatory. Prior exact replay
ignores revision but never revoked authority or changed epoch.

| Operation | Scope | Exact payload |
| --- | --- | --- |
| `workstream.create` | root, expectedRevision 0 | `{cwd,host}`; host `codex`, `claude-code`, or `pi` |
| `workstream.open`, `progress` | root or node | `{}`; root returns run/fleet and export cursor status |
| `packet.admit` | root | `{node,packet}`; packet below |
| `graph.admit` | root | `{graph,waves,dependencies,topology,maxParallel,maxRepairLoops}` |
| `wave.launch` | root | `{wave}` |
| `root.create` | root | `{adapter,model,thinking,text}` |
| `root.message` | root | `{text}`; root must be idle |
| `root.reply` | root | `{requestId,text}`; exact pending root request |
| `root.cancel` | root | `{reason}`; running/blocked root only |
| `node.reply` | exact node | `{attempt,requestId,text}`; existing PAR-1A oracle |
| `node.cancel` | exact node | `{attempt,reason}`; PAR-1A coalescing/terminal semantics |
| `root.resume`, `node.resume` | corresponding scope | `{}`; typed `RESUME_UNSUPPORTED` |
| `wait` | root or node | `{timeoutMs,limit}`; 0–10000 ms, 1–128 items |
| `delivery.ack` | root or exact node | `{deliveryId}`; idempotent per principal |
| `artifact.read`, `log.read` | exact artifact-owning node | `{path,offset,maxBytes}` |

Packet: `{role,task,acceptance,riskTier,cwd,adapter,model,thinking}`. Acceptance is
1–12 nonblank strings; risk is low/standard/high. Cwd is realpath-contained under
a trusted allowed root and rechecked at dispatch. Packet admission freezes before
graph admission. Graph topology is only `flat-root`, max 24 nodes, 6 parallel,
0–3 recorded repair loops (no autonomous repair scheduler). Every packet occurs
exactly once in ordered nonempty waves. Dependencies must point to an earlier
wave; unknown, cyclic, duplicated, or same-wave edges reject. At most one
builder/foreman per wave. Packet role names and adapter IDs cannot configure a
shell command. Native adapters must enforce the corresponding role/delegation
policy, not merely echo it.

A wave launches only explicitly, contiguously, after the preceding wave completes.
Every declared dependency must be done with trusted `verified:true` readiness.
A nonblank artifact alone is **not** verification of upstream acceptance; the
injected adapter must report readiness only after the host's deterministic
verification policy. No other agent/scheduler chooses topology or launches dependents.

Artifacts/logs are relative to `<stateRoot>/runs/<run>/<node>/`, with no absolute,
traversal, symlink (including the node directory), hardlink, or cross-run reads.
Reads are regular-file-only, capped to 64 KiB at offsets up to 1 MiB; return
`{text,bytes,nextOffset,eof}`. File descriptor identity and current canonical path
are checked before reading. Expected result is that node directory's `result.md`.

## Injected native adapter contract

```js
const adapters = {
  roots: { codex: rootConversationAdapter },
  workers: { codex: workerExecutionAdapter }
};
// Root and worker implementations may share a provider transport, not a scheduler.
const workerExecutionAdapter = {
  capabilities: {'node.launch': true, 'node.reply': true, 'node.cancel': true},
  async execute({effect, handle, context, recordHandle, emit}) {
    // Called ONLY for a committed, atomically claimed outbox row.
    // Resolve host/version/permission/visibility prerequisites before native effects.
    // Create native owned session, then synchronously record it before first turn:
    recordHandle({id: 'stable-owned-session-id', session: 'optional-session-id',
                  pid: 123}); // pid only for a process this adapter actually owns
    // Start the bounded native turn; return promptly on transport acceptance.
    return {accepted: true};
  }
};
```

Root capabilities are `root.create`, `root.message`, `root.reply`, `root.cancel`.
Only explicitly true capabilities are accepted. `execute` has a 10-second
transport-acceptance deadline; it must not await the entire model task. Timeout,
throw, malformed acceptance or missing creation handle makes the effect
`recovery-required`; late handle/event writes are fenced, never retried as a launch.
Provider lifecycle observation continues through the returned `emit` closure.

`effect` contains `{id,commandId,scope,op,payload,attempt}`. Worker reply also
includes the PAR-1A `intentId`, `blockedSequence`, and `nextAttempt`; cancellation
has its PAR-1A intent ID. Launch payload includes `{packet,resultPath}`.
Root create payload includes its requested fields plus canonical cwd.
`handle` is the previously persisted stable native execution/session handle or
null. Handles are strict `{id,session?,pid?}` and must never contain credentials.
Changing session/handle identity in-place is rejected; no arbitrary takeover or
process replacement is supported by this component. Native resume/replacement
requires a later explicitly supported adapter/runtime capability.

`context` is `{cwd,artifactDirectory,resultPath,nestedDelegation:false,scope,attempt}`.
The adapter must actually disable unapproved native nested agents using supported
host configuration and preserve permission/approval routing; it must not enable
unsafe bypasses. There is no model token in this context. Register scoped model
MCP authority separately through the trusted host, never from a worker command.
Requested model/thinking are recorded at launch; they are not evidence of observed
provider identity. Concrete adapters must preserve requested/observed identity in
their own bounded artifact/log and report unknown honestly.

`recordHandle(handle)` is synchronous and commits correlation before returning.
On create/launch call it immediately after acquiring the native session and **before
starting a turn or sending input**, wherever the provider permits. For providers
that cannot expose a pre-turn handle, the unrecorded launch window is explicitly
ambiguous on crash. There is no retry-safety claim across that window.

`emit({id,kind,attempt,data})` is trusted adapter-only semantic ingestion, **not** an
operational tool. Event IDs are globally unique; exact replay deduplicates and
changed body/effect binding rejects. The event attempt must match both the effect's
attempt and current node/root attempt, preventing stale-turn delivery. Node reply
advances its attempt through PAR-1A; a new root message advances the root attempt.
Use the corresponding current effect's emitter for that turn. Unknown event kinds
and fields fail closed. Adapter callbacks must catch rejection and stop unsafe
continuation rather than swallowing a fence failure.

Worker events:

- `progress`: `{note}` (nonblank, <=16 KiB).
- `blocked`: `{requestId,kind,text}`; kind question/decision/permission/credential/
  external-action. Write a nonblank durable result first. Runtime records canonical
  blocked request, validates the actual artifact, settles blocked, and enqueues
  delivery. Missing/blank/unreadable result stalls instead of pretending BLOCKED.
- `settled`: `{status,reason,verified}`; status done/failed/stalled/cancelled.
  Runtime reads/validates the actual reserved result using shared result-v2.
  A BLOCKED artifact is classified as blocked; nonblank missing headings remain
  advisory. Missing, blank and unreadable artifacts stall with distinct reasons.
  Cancellation must have been admitted before cancelled finalization; it is not
  inferred from a tool call, Escape, or process exit.
- `process-exited`: `{code}` (0–255), separately observed; no fabricated settlement.

Root events are separate conversation deliveries, not fake canonical worker rows:

- `progress`: `{text}`; `blocked`: `{requestId,kind,text}`.
- `completed`: `{text}` returns the root turn to idle, including explicit native
  cancellation finalization. `process-exited`: `{code}` is separately observed.

## Crash recovery, delivery and ownership

SQLite WAL with synchronous FULL is the durable authority. Pending intents are
safe to claim after restart. Claimed effects and previously accepted but still
active executions are marked `recovery-required`, with whether a handle was
recorded, and are **never automatically re-executed**. This first component does
not offer provider reconciliation or forced ambiguity clearance. Completed,
terminal effects replay normally. Recovery requires a subsequent reviewed native
reconciliation capability or trusted external investigation, not a resume button
that launches again. Dead owner recovery uses OS PID liveness, never wall-clock
expiry; PID reuse conservatively refuses. A crash inside the tiny acquisition
gate or corrupt lock metadata requires trusted local investigation/removal after
proving no owner remains. Do not silently steal it. An idle root with an
unexited/unknown native session also requires recovery on service restart;
client reconnect to the same live service is unaffected.

Every SQL transaction checks the service nonce in addition to the process lock.
`security.mjs` exports `withRunOwnership(root,run,'runtime'|'legacy',owner,action)`
and the bounded `withLegacyRunOwnership(root,run,action)` adapter helper. Both use
the shared `ownership/<run>.lock` namespace and retain the lock until an async
callback settles. The ownership marker is permanent. The Pi `AdvisorTraceStore`
and native-hook `appendTrace` appender claim the same `legacy/legacy` namespace
before reading drafts or appending, retrying only transient `OWNER_BUSY`; marker
mismatches always fail. Runtime never adopts an existing unclaimed JSONL trace
and never changes a legacy ownership marker.

Canonical v1 rows are SQL-ordered and exported atomically (split temp write,
fsync, rename, directory fsync), with a durable export cursor. Export retries on
mutations, handles, ingestion and service startup; failure cannot undo admitted
commands or turn an accepted effect into a duplicate. `progress.export.pending`
exposes lag. Explicit `exportTrace(runId)` is a trusted host method and validates
schema/order before publishing. A partial old final line is rebuilt from SQL;
old legacy traces are never repair/adoption inputs. Export does not fabricate
`parent.awakened` or a model turn. Delivery acknowledgements live in their own
ledger, not canonical events.

`wait` provides bounded long-poll notification and durable at-least-once delivery.
Disconnect/timeouts end the wait, never cancel a run. Unacked rows redeliver on
reconnect/restart; ack is per principal and idempotent. Notification is only a hint;
wait reauthenticates and rereads durable state. It does not claim unsolicited model
wake. A root-scoped reader sees all run deliveries; node readers only theirs.

`runtime.close()`/`service.close()` refuses active, pending, recovery-required or
undelivered work with typed `SHUTDOWN_*` errors, exporting before releasing the
lock. If an adapter recorded an owned PID, observed process exit is also required;
settlement is not process exit. No shutdown command is exposed to model tools.
SIGINT/SIGTERM on the foreground host requests this same safe close and prints
only a typed refusal. OS crashes/SIGKILL are handled on restart, not presented as
clean shutdown.

Bounds: 32 simultaneous socket connections, one request per connection, 32 KiB
command envelope, <=12-second socket request lifetime, <=1 MiB response, 128 MCP
requests per stdio connection, 10-second bounded waits/adapter acceptance,
24 graph nodes, 10,000 canonical rows and 16 MiB canonical/delivery data per run,
100,000 admitted command receipts per store. No eviction/reuse of command IDs;
capacity exhaustion requires a new explicitly scoped store, not silent deletion.

## Deterministic verification

```sh
node --test tests/advisor-runtime*.test.mjs tests/advisor-command-*.test.mjs
node --test tests/advisor-trace.test.mjs tests/claude-advisor-trace.test.mjs tests/codex-advisor-trace.test.mjs
```

The runtime suite runs actual Node/SQLite restart, crash-injection, competing
service-owner and competing CLI-client processes. All lifecycle adapters are
hermetic fixtures; no live model or host certification is implied. Parent-owned
High-risk independent review remains mandatory before real canaries.
