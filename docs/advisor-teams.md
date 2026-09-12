# CoS teams and portable checkpoints

CoS is an opt-in advisor style, not another scheduler or a fixed organization chart.
Direct implementation, temporary roles, parallel scouts before a team, and full-stack
outcome teammates remain choices at any point. The selected intelligence profile guides
judgment; it is not a staffing quota. Explicit user limits and actual runtime limits remain
binding. A title never changes a worker's role, model, permissions or write ownership.

## Entry and recovery

In a **root Pi session in Herdr**, with the paired managed pi-detach bridge installed:

```text
/cos accepted-workstream native -- Own the accepted outcome
/advisor-team
```

`/advisor-team` is the same command handler as `/cos`. Syntax is
`[workstream] [pi|native] [-- task]`; omitted arguments restore the current session.
`advisor_session_init {workstream, workerHarness, mode:"cos"}` is the tool equivalent.
It uses the normal advisor initializer and records mode on the same owned workstream.
Ordinary `/advisor` remains ordinary unless that session already opted into CoS.
A CoS session cannot switch workstream or specialist preference; start a fresh session.
An existing ordinary advisor may opt in after temporary scouts without retroactively
granting those scouts membership or resetting accounting.

Managed `advisor` workers are **Pi-hosted**, even when specialist preference is `native`.
Under a native-specialist parent, omitted `harness`, explicit `native` (inherited preference),
and explicit `pi` (advisor hosting) resolve to a Pi child with native specialist preference.
A specialist cannot override the session preference, and `native` under a Pi-specialist
parent is still a forbidden override. The execution port uses the trusted family scope,
not ambient parent environment, for that decision.

Native Codex: invoke `$cos` or `$advisor-team`; Claude Code: `/cos` or `/advisor-team`.
The installed thin skills load the native advisor and shared team reference, initialize
canonical state with `--mode cos`, and use **only the host's actual native tools**. These
are not managed team tool registrations. No native durable messaging/queue/dedupe,
role/model controls or independent checking is claimed when the host lacks it. Report
missing capabilities rather than silently switching lanes. See [native skills](native-advisor-skills.md).

## Managed operations

1. Launch an outcome owner with existing `bg_agent`, `role:"advisor"`, `keepAlive:true`,
   explicit fitting model/effort, self-contained scope and acceptance criteria.
2. `team_manage {action:"enlist",runId,name}` enlists that already-owned candidate.
   Candidates must have been launched with team binding and child scope. Leaves and old
   sessions cannot be imported. The teammate can implement directly and launch scoped helpers.
3. `team_status {}` shows roster, current assignments, retained proof/history, context,
   transport readiness and cumulative accounting. It does not independently check results.
4. `team_message {to:"name-or-id",text:"plain advice"}` queues advice to a **busy** member;
   members may address `root` and authorized peers. Advice grants no scope. For settled
   members use an eligible same-outcome continuation or a new accepted assignment, not
   a fabricated busy delivery. `accepted` is durable admission; `queued` is transport
   acceptance. Neither means read or acted on; read/done remain unknown. Ambiguous effects
   require recovery, never blind resend. An exact retry of the same tool call is deduped;
   another tool-call ID is a new message, even with identical text. The Pi root receiver
   also dedupes repeated deliveries and re-acks a persisted same-session message after
   reconnect. Its in-memory busy queue and runtime acknowledgement are not a cross-process
   atomic commit: a host crash before queue processing does not establish read/done.
   The runtime's retained message history remains available through `team_status`.
5. `team_manage {action:"context",text}` replaces the workstream context snapshot with
   a revision. Members see it via `team_status`; accepted assignments carry the snapshot.
   Send a message when a busy member needs an update. Context never rewrites a session's model, role or host.
   `action:"rename",to,name` changes only the roster label.
6. `team_manage {action:"assign",to,assignmentId,task,acceptance,riskTier}` grants a
   **genuinely distinct accepted outcome** after prior ownership settles. It retains the
   session and all prior contracts/results/input lineage. Existing `bg_agent {name,prompt}`
   remains same-outcome repair, retaining the original graph repair history. A new label
   is not permission to evade exhausted repair or user limits. New outcomes still consume
   cumulative explicit family accounting. Each accepted assignment binds at most one
   graph outcome; use a distinct outcome node for new work. Prior graph bindings keep
   their frozen contracts, proof locators and repair windows, never borrow current proof.
   The existing graph API binds new evidence, not a second team proof store.
7. `team_manage {action:"retire",to}` revokes membership and seals child admissions first.
   It stays `retiring` while relevant descendants are active or unknown. After actual
   settlements retry retirement; an exact retry can complete closure. Existing `bg_stop`
   is the supported cancellation mechanism. Retirement is not proof of process exit.
   Shutdown refuses an active/unsettled roster; history is never deleted or imported into
   another workstream.

Root-only management is runtime-enforced, not merely hidden from member tool menus.
Targets carry workstream, assignment, handle/session, generation and ownership fences
beneath the conversational API. All effects traverse the existing authenticated runtime,
command/effect ledger, adapter, execution port and Herdr driver; no raw legacy fallback.

The canonical root file includes a bounded `Team projection` refreshed on relevant tool
results and checkpoint reads. It is an attributable runtime snapshot, not live liveness or
another scheduler. It shows session/run/assignment, role/write surface, requested/observed
identity, evidence locator, status and next action. Only the first 32 members are projected;
`team_status` retains the full roster. The durable roster and messages share a 16 MiB team-state
envelope; each command envelope is limited to 32 KiB, each response to 1 MiB, and message text to
16 KiB. Status returns the latest 128 messages with a 1 KiB UTF-8 preview. These projection limits
are not staffing or conversation quotas. Retired history is preserved; exhausting a byte envelope
fails explicitly rather than evicting it.

## Canonical state in every host

Both Pi and native **ordinary advisor too** use
`~/.advisor/<repo-key>/workstreams/<slug>.md`. The key is derived from the real Git common
directory, so checkout aliases and linked worktrees share one namespace. Non-Git folders
have a real-directory identity. Git-resolution failure in a repository is an error, not
an alternate namespace. `ADVISOR_STATE_DIR` is an explicit trusted local/test override.

Pi roots use `advisor_checkpoint {}` to read content/digest and
`advisor_checkpoint {content,expectedDigest}` for compare-and-swap replacement.
Native installed helper (Node stdlib and Git only; no Pi/Herdr/MCP dependency):

```sh
node <installed-advisor-skill>/scripts/advisor-state-cli.mjs init --workstream accepted-slug
node <installed-advisor-skill>/scripts/advisor-state-cli.mjs read
node <installed-advisor-skill>/scripts/advisor-state-cli.mjs write --expected-digest DIGEST < checkpoint.md
```

Add `--mode cos` on init for native team mode; `--cwd PATH` selects the repository.
Codex identity comes from `CODEX_THREAD_ID`. Claude's skill expands `${CLAUDE_SESSION_ID}`
into the helper invocation; a missing or literal substitution is unsupported, never a
made-up identity. Pi extension uses SessionManager; Pi shell use also validates its session
file header. Workstream names and display IDs are not ownership tokens. There is no CLI
`--owner`/`--session` takeover option.

The identity boundary is **cooperating local host context**, not an OS sandbox: the same
OS user can forge environment variables or edit their files. State checks reject path
escape, symlinks inside the namespace or at the root/`.advisor`, hardlink/special-file
clobber, foreign ownership, stale digest, malformed metadata and files over 64KiB.
Writes are same-directory atomic replacements with a small exclusive lock. A crashed
lock requires explicit local inspection; it is never automatically stolen. This is local
filesystem coordination, not distributed multi-machine replication.

A session belongs to one workstream for its lifetime. Missing/corrupt checkpoints remain
unknown; a session pointer or host summary is not a substitute. Legacy Pi owner headers
and session diaries can be read/migrated into identity pointers; old in-repo `.advisor`
directories remain read-only history. A foreign checkpoint transfer requires an explicit
Pi confirmation and expected previous owner, archives the old file in an event, and
**does not adopt** foreign runtime workers, native conversations or teammate context.
Native CLI stops at a foreign owner; resolve a deliberate handoff through the trusted
host API, not by supplying someone else's ID.

The root alone updates its hot section with decisions, scope, active ownership, evidence,
requested versus observed model/effort, and next action at material boundaries. Scoped
helpers write only their assigned result/evidence artifacts and send attributed updates.
Requested model/effort are not observed facts: current Herdr transport reports observed
model and effort as unknown. Profile refresh affects future judgment, not existing session
configuration. There is no automatic cross-workstream conversation import or global pool.

## Installation, update and proof

Install the **paired source revisions** of meta and pi-detach together. The current
first-party package setting tracks pi-detach's Git source without a commit pin, so
unpublished local changes need a deliberate local-source selection or the normal
publishing workflow. Do not load both local and Git copies of the same extension.
Rerun gates invalidated by any integration or package-selection changes. The native
installer copies the shared helper and
team reference into the native advisor bundle along with the twelve skills and preserves
its conflict/rollback behavior. Pi portable install copies both entry skills and shared
state modules. Neither installer is concurrent/crash-atomic unless already documented.

Do not reload into active workers. Settle/cancel through supported controls, acknowledge
required deliveries, retire members, then use `/bg_runtime_close` on an inactive runtime.
Update and start a fresh session; a stale runtime revision is a visible refusal/recovery
boundary, not permission to adopt a handle or replay a launch. Source installation alone
does not mutate already-running sessions. Native skills should be reloaded in a fresh
host conversation after installation. No migration grants new scope to historical workers.

Runnable proof (use an isolated HOME/PI_CODING_AGENT_DIR and the CI-pinned Codex CLI):

```sh
PI_DETACH_TEST_PACKAGE=/path/to/pi-detach npm test
npm run typecheck
PI_DETACH_TEST_PACKAGE=/path/to/pi-detach node --import tsx tests/bridge/pi-detach-product.ts
node --test tests/advisor-portable-state.test.mjs tests/native-skills.test.mjs
# In pi-detach:
npm test && npm run typecheck
```

`tests/advisor-binding.test.ts` exercises real command handlers, alias/recovery, profile,
checkpoint projection, child helper launch and harness resolution through the actual
bridge/port/driver. `tests/advisor-runtime-family.test.mjs`, `tests/bridge/pi-detach-product.ts`
and `tests/bridge/pi-detach-recursive.ts` cover assignment/replay/lifetime/adversarial fences
and recursive settlement with deterministic Herdr observations. Portable-state tests run
separate native helper processes and installed bundles. These are real transport-code
checks, not live model/Herdr UI pilots; they do not certify native host reasoning or
unavailable model/effort telemetry. Required independent integrated checking remains separate.
