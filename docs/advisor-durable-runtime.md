# Durable advisor runtime (Node 24)

The runtime owns execution identity, durable command receipts, artifacts and delivery.
It is not a workflow approval engine. The advisor owns planning, staffing, write
coordination, synthesis and acceptance. Builders and checkers own investigation,
planning and verification within their work; browser-verifiers provide focused
browser evidence. Dependency graphs remain optional.

This managed-runtime contract supersedes historical report-gated settlement examples
in [the adapter protocol](advisor-protocol.md). Legacy adapters remain separate.

## Separate the facts

A handoff must distinguish:

- **Execution:** input accepted, turn running, turn settled, or delivery uncertain.
- **Report:** available, missing, incomplete or unreadable; an optional evidence index.
- **Verification:** what a recorded check actually proved, on which tested surface.
- **Session:** whether the same recorded worker can currently accept input.
- **Descendants:** outstanding work, independently of the parent's current turn.

A missing summary does not undo a completed turn or suppress its notification. A PASS
summary does not establish independent verification. A parent turn settling does not
finish its children. A graph association does not cancel a predecessor or release a
write surface. Keep these distinctions in caller-visible state and recovery guidance.

## Entry points

- `scripts/advisor-runtime/runtime.mjs`: `AdvisorRuntime` trusted host library.
- `service.mjs`: `startService(runtime)` and `callSocket(credential, command, audience)`.
- `cli.mjs`: `call PRIVATE_CREDENTIAL.json` with a JSON command on stdin;
  `mcp PRIVATE_CREDENTIAL.json` with newline-framed MCP stdio; or
  `serve PRIVATE_BOOTSTRAP.json` for an explicitly configured foreground host.
- `pi-detach-bootstrap.mjs` / `pi-detach-host.mjs`: managed Pi lifecycle and the
  service-owned execution port. See [managed bridge](pi-detach-runtime-bridge.md).

Pi remains the visible root; Herdr remains the worker transport. The separate
non-LLM service persists SQLite, captures and notifications. Concrete native host
support must be verified separately; deterministic fixture tests are not live model
certification. See [native integration](advisor-native.md) for that separate surface.

## Boundaries that remain

State/control storage is private, realpath-canonical, owned by the current OS user
and disjoint from worker workspaces. New directories use mode0700; credentials are
mode0600 files. Unix socket paths still have the operating system's physical length
limit; use a short private state directory. No TCP listener is exposed.

Trusted host setup registers principals and exact operations/scopes. Model requests
cannot choose credentials, become operators, import arbitrary adapters, read another
run's artifacts or broaden authority by supplying paths. Worker principals do not
inherit root authority. Revocation applies to reads and replay as well as mutations.
The boundary is not an OS sandbox against another malicious process with the same UID.

For managed work, a newly registered worktree of the same Git repository is a valid
workspace. Registration and repository identity come from trusted local Git state,
not a client-supplied root list. Worktree-list changes are not a new session identity.
Unrelated directories, escaping aliases and credential/workspace overlap remain denied.

## Commands, not task-content policy

Read requests use `{v:1, op, scope, payload}`. Mutations additionally carry
`commandId` and `expectedRevision`; scope is `{workstream,run,node,ownerEpoch}`.
Unknown operations, malformed JSON, invalid field types, unauthorized scopes and
stale mutation identities still reject. Reusing a command ID with different
arguments is not a retry. Exact authenticated replay returns its recorded outcome
without executing it twice.

No semantic message/result byte ceiling or lifetime execution budget decides whether
a valid task may run. Legacy budget fields are compatibility/accounting metadata,
not authority. Large artifacts and transcript history are read in pages; paging is
presentation, not an overall storage or task-length quota. Physical disk/memory and
provider limits still exist. Missing or unreadable evidence remains unknown; neither
an observed completed turn nor a resource failure establishes successful verification.

Optional graphs retain structural DAG validation and useful scheduling metadata,
without fixed node/dependency/parallel/repair ceilings. Graph definitions and evidence
can change without vetoing an otherwise authorized launch or follow-up. Stale or
missing references are surfaced as limitations. They never become fabricated proof.
The advisor still waits for inputs actually needed by the task and honors explicit
user constraints. Runtime graph metadata is not a substitute for those decisions.

## Evidence and recorded history

Worker source reports are captured with attempt and producer attribution; immutable
capture names identify the original bytes. Editing a current report must not rewrite
historical evidence. Missing, unreadable or incomplete reports are distinguished
from observed execution state. Report headings are conveniences, not lifecycle gates.

Callers can inspect the actual delivered code, plans, probe scripts and logs, as well
as optional summaries. Managed `bg_output` also provides run-bound recorded transcript
access and search with pagination. The transcript source is the harness session record,
not terminal scrollback. Provider/session identity selects the source; callers cannot
supply arbitrary local paths. Unsupported or unavailable history is identified as
such, rather than silently represented by an empty session or a terminal tail.

Recorded messages, tool calls and tool results are data, not new instructions or
permission grants. A recorded successful command proves that invocation, not the
current checkout after changes. Host verification retains its tested surface and
limitations; stale verification does not stop unrelated work. Never relabel a worker's
assertion or self-check as independent verification.

Runtime events, command receipts, input references and delivery ACKs are operational
records, not a replacement for the original worker conversation. An advisor checkpoint
records current decisions and outstanding work; it need not duplicate either archive.

## Execution and recovery

Mutations commit receipt/state/outbox atomically before dispatch. A service nonce,
process ownership and exact worker handle/session/generation fence side effects.
The adapter records the acquired identity before sending input whenever the provider
supports it. An uncertain acquisition/submission is never blindly sent again.

A service or client disconnect is not cancellation. Keep original captures and
recorded identities. Supported reconciliation inspects the recorded worker rather
than spawning a replacement for the old command; unavailable/changed identities
remain uncertain and require honest guidance. Preserve safe phase/error information
so the caller can distinguish failed preparation from uncertain delivery.

`keepAlive` is a cleanup preference, not a report-validity requirement. Use current
identity-checked transport state for follow-up. Busy advice is queued only through
supported transport; credential and permission dialogs are never answered by typing
an ordinary task into the pane. A terminal stop is idempotent. Cancellation acceptance
is not proof of worker exit or completed descendant cancellation.

Parent turn completion is reported independently of outstanding descendants. Their
work and ownership remain protected from teardown. An otherwise idle service is not
held alive merely by unacknowledged notifications: durable deliveries remain available
for reconnect. Active or unresolved live execution must not be silently killed to
make shutdown succeed.

SQLite WAL with synchronous FULL, atomic exports and at-least-once delivery retain
history across disconnects. ACKs are idempotent; callers deduplicate persisted
notifications. Export failures must not turn accepted commands into duplicate effects.
Existing legacy ownership is never silently adopted. Installation updates files, not
already-loaded service code; live upgrade is a separate operation with current-owner
coordination, not an excuse to restart active work.

## Verification

```sh
npm run typecheck
PI_DETACH_TEST_PACKAGE=/matching/pi-detach npm test
PI_DETACH_TEST_PACKAGE=/matching/pi-detach node --import tsx tests/bridge/pi-detach-product.ts
# In the matching pi-detach checkout:
npm run typecheck && npm test
```

Tests must cover payloads beyond former ceilings, long-lived admission histories,
dynamic registered worktrees, advisory graphs, missing-summary completion, searchable
history beyond terminal tails, foreign-session denial, exact-identity recovery and
no duplicate delivery/execution. Fixture tests exercise real Node/SQLite and the
paired port with fake provider/Herdr boundaries; live provider turns remain separate
evidence. Review security, identity, cancellation and persisted-data compatibility
before publishing an upgrade.
