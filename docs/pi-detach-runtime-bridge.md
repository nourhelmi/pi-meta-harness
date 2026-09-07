# Managed Pi / Herdr runtime

Managed Meta installs select the shared runtime for pi-detach automatically. Start
ordinary `pi` inside Herdr: no root wrapper, manual descriptor environment,
per-task packet file or separate service command. Pi owns bg_agent; the existing
non-LLM service owns admission, SQLite, results, traces and delivery; Herdr owns
visible execution.

## Install and diagnostics

Install matching Meta and pi-detach revisions through the ordinary package and
bootstrap workflow. Meta materializes the complete runtime, core helpers,
canonical schema and `pi-detach-runtime.json` in the Pi agent directory. Runtime
configuration participates in backup/restore. Intelligence selection, runtime
model/thinking preferences and unrelated packages are preserved.

Pi-facing imports support Node22.19+. The service requires Node24.18+ with SQLite
and the shipped pi-detach production TypeScript loader. A suitable installer Node is recorded by absolute
path. An installer running under Node22 can select a trusted executable:

```sh
node scripts/meta-harness.mjs install --target /private/test/pi-agent \
  --runtime-node /absolute/path/to/node
node scripts/meta-harness.mjs doctor --target /private/test/pi-agent
```

Use the existing --live workflow only when authorized. Installation never reloads
Pi. Startup never downloads a runtime. Missing runtime files or incompatible Node
produce visible typed failures before acquisition, with no legacy fallback.
Doctor reports copied configuration and Node owner readiness separately.
`/bg_backend` checks the current backend and connection without launching a worker.

## Session ownership and reload

Background startup occurs in the supported session_start hook, never the extension
factory. Identity binds the actual SessionManager ID, canonical cwd, installed
host/detach paths and Herdr context. State defaults to private
`~/.pi-runtime/<identity-hash>`, outside authorized task/artifact directories.
The existing 100-byte Unix socket path bound applies; trusted configuration can
select a shorter private stateBase.

Concurrent initialization uses one exclusive startup marker. Reload closes client
resources and reconnects to the same live service, descriptor and pending delivery
IDs without prompting again. Enqueue/ack does not prove a later model turn; lost
ack can redeliver the same identity.

Identity/path/control overlap, changed workspace registry and dead or ambiguous
service state fail closed. Startup never deletes an owner lock or adopts old
workers. Recovery-required and cancel-pending remain durable. Upgrade from legacy
agent history in a new root; do not change backends around active workers. Legacy
histories reporting running agents are conservatively refused even if an external
operation may subsequently have finished them.

`/bg_runtime_close` closes only inactive, acknowledged work. Refusal leaves the
service intact. Close never sends Escape or invents cancellation/process death.
The closed descriptor remains evidence; use a new Pi session for subsequent work.
Standalone pi-detach without Meta remains supported. An explicit legacy escape
for a new root is PI_DETACH_BACKEND=legacy. Manual host/client embedding remains
available for trusted tests/operators.

## Supported work and limits

- Named roles, freeform Pi and native configured packets use the existing resolver.
  Role skills, acceptance, harness, requested model/thinking, instructional turn
  caps and result contracts survive admission. The `default` identity marker means
  no resolver override, not an observed provider identity. Auth stores are not read
  to fill omitted metadata.
- Receipt/outbox claim precede acquisition; qualified pane/name/session/generation
  handle commit precedes prompt. Herdr's supported 5000ms post-submission gate
  remains inside the 6000ms CLI and 10000ms core budgets. Ambiguous effects do not retry.
- Issued pib IDs are stable, opaque authority bindings, never parsed pane names.
  Reply to artifact BLOCKED with bg_agent({name:id,prompt:"answer"}). A completed
  PASS/FAIL worker originally kept alive accepts a new bounded task with the same
  name. Internal current revision/attempt/handle/generation bind that task. Fresh
  source capture is reserved before its prompt; old PASS cannot settle a new attempt.
  Omit settings on follow-up; implicit model/harness/keepAlive changes are rejected.
- Authorized cwd is the owning canonical cwd/repository or a registered Git worktree
  captured at startup. Unrelated workspaces, escaping aliases and invented nodes
  reject. Changes to the registry require a new root, not wider live grants.
- Exact scopes enroll on demand with unique durable IDs. The finite lifetime limit
  is 256 launches per service (trusted tests can lower it), alongside existing
  binding/receipt/event/delivery/transport bounds. Identities are never recycled.
  Exhaustion rejects before acquisition; finish safely and start a new root.
- Profiles granting depth-1 visible subagents receive a separate reserved child
  control directory, never the parent descriptor. Child Pi bootstraps a distinct
  session/service/scopes. Live or uncertain child work keeps the same parent
  supervisor active. Child completion still requires a fresh parent turn before
  capturing the integrated result. Descendants receive no further child grant.
- Runtime owns canonical events/results/delivery; legacy Pi-host writes, artifact
  BLOCKED UI signals, reaping and agent notifications are fenced. Non-agent
  bg_run/watch/await retain their existing behavior. bg_list includes both backends;
  bg_output uses qualified live capture while running and durable output afterwards.

Unsupported: busy steering; foreign/closed/not-kept/stale targets; terminal
credential or approval dialogs; stalled terminal repair; explicit agent commands;
custom result paths; crash adoption and cancellation-finalization proof. Artifact
BLOCKED is distinct from terminal UI blocking. Never send raw keys around dialogs.
This ownership boundary does not claim OS confinement or cover same-UID compromise
and simultaneous manual pane control.

## Verification

```sh
PI_DETACH_TEST_PACKAGE=/matching/detach node tests/bridge/pi-detach-product.ts
PI_BRIDGE_META_PACKAGE=/packed/meta PI_DETACH_TEST_PACKAGE=/packed/detach \
  node tests/bridge/pi-detach-default.mjs
npm run check
npm run typecheck
# matching pi-detach:
npm test
npm run typecheck
```

The default probe uses real processes and actual extension/session hooks, service,
SQLite and execution port with a fake Herdr executable. It is not live Pi/model
proof. Clean package probes must use production dependencies, not checkout imports.

Parent-owned live recipe: install reviewed paired revisions, run doctor, start a
fresh ordinary Pi in Herdr with both old bridge variables absent, check /bg_backend,
launch one bounded kept worker that writes BLOCKED, /reload, reply with its issued
ID, observe PASS delivery, then send one bounded repair using that same ID. Verify
fresh artifacts, one prompt per admitted task/reply and root delivery/ack. Actual
model turns, visible panes and user-confirmed reload remain distinct evidence.
