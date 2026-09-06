# Advisor command admission — PAR-1A

This is an unconnected, pure ESM decision kernel for `node.reply` and
`node.cancel`. It imports only the deterministic Node crypto primitive and its
local contract module. It reads no environment, home directory, file, process,
network, host transcript or clock. It has no production store, command service,
adapter implementation or canonical event writer. PAR-1B must supply and prove
transactional persistence and effect dispatch separately.

## Command contract

`validateCommand(decodedJson)` returns `{ok:true, command, digest, intents:[]}`
or `{ok:false, reason, intents:[]}`. The validated command is an immutable copy.
All objects are strict: every listed field is required; additional fields at
any level are rejected, including identity and credential fields.

```js
{
  v: 1,
  commandId: "reply-42",
  scope: { workstream: "portable", run: "run-1", node: "builder", ownerEpoch: 2 },
  op: "node.reply",
  expectedRevision: 7,
  payload: { attempt: 1, requestId: "question-4", text: "Proceed with the packet." }
}
```

For `node.cancel`, payload is exactly `{attempt, reason}`. Launch, resume and
workstream creation are unsupported. All IDs use
`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. Epoch and attempt are safe integers >=1;
revision is a safe integer >=0. Text/reason must be nonblank, with limits of
16 KiB/1 KiB **UTF-8 bytes**. The complete semantic JSON envelope, including
escaped strings and field names, must fit 32 KiB. Transport must bound original
wire bytes before parsing too; this API takes decoded JSON, so it cannot measure
discarded wire whitespace or escape spellings.

`canonicalJson` sorts object keys lexically, retains array order, and uses JSON
primitive encoding (`-0` and `0` have the same JSON meaning). SHA-256 of that
UTF-8 encoding is the command digest. Text is never trimmed or Unicode-normalized
for digest/effect purposes. Whitespace-only text is rejected. Missing properties,
undefined, nonfinite numbers, bigint, symbols, functions, cycles, sparse/extended
arrays, class instances, non-enumerable properties and accessors are rejected;
getters and `toJSON` are not invoked. Inputs must be decoded data, never hostile
in-process proxies. JSON parse duplicate-key/wire parsing policy is the future
transport's responsibility. Arrays are tested for semantic canonicalization but
are not valid values in either operation's envelope.

Validation reasons: `NON_JSON`, `ENVELOPE_TOO_LARGE`, `INVALID_SHAPE`,
`EXTRA_FIELD`, `MISSING_FIELD`, `UNSUPPORTED_VERSION`, `UNSUPPORTED_OPERATION`,
`INVALID_ID`, `INVALID_INTEGER`, `INVALID_TEXT`, `TEXT_TOO_LARGE`.
Non-JSON and envelope checks precede field checks. Rejections never echo the
input or issue intents.

## Authority and read view

`admitCommand({command, principal, snapshot, receipts})` consumes explicit inputs.
The transport authenticates the caller and supplies a separate principal:

```js
{ id: "client-1", scopes: [{ workstream: "portable", run: "run-1", node: "builder" }] }
```

Principal IDs and scope IDs use the command ID alphabet. Grants are exact
workstream/run/node triples, without wildcards, inferred membership or client
identity authority. No credentials belong in this object either. The caller
must not let command data populate `principal` or authoritative state.

`snapshot` is one trusted node read view (JSDoc types live in the module):

```js
{
  scope: { workstream: "portable", run: "run-1", node: "builder", ownerEpoch: 2 },
  revision: 7, state: "blocked", attempt: 1, blockedSequence: 12,
  request: {
    id: "question-4", run: "run-1", node: "builder",
    attempt: 1, blockedSequence: 12, answered: false
  },
  cancel: null,
  capabilities: { "node.reply": true, "node.cancel": true }
}
```

States are `running`, `blocked`, `terminal`; `terminal` is an authoritative
classification supplied by the store, not inferred from trace formatting.
`request` and `blockedSequence` can be null. A consumed request remains recorded
with `answered:true`; a reply clears the current blocked sequence.
Pending cancellation is `{attempt, intentId}`. Only literal capability `true`
enables an operation. No capabilities default on.

`receipts` is a read-only map covering command IDs across the entire state root,
not just this node/run. Each entry is `{principalId, digest, scope, receipt}`.
The store supplies coherent, trustworthy snapshots and ledger records. Admission
never changes either input. It validates structural snapshot prerequisites and
the named request/transition bindings; it is not a general persisted-state repair
or historical integrity validator.

Admission precedence is deliberate:

1. Validate envelope, then principal and exact scope grant.
2. Look up command ID. A different principal gets `PRINCIPAL_MISMATCH`, without
   receipt details. Changed semantic input gets `COMMAND_ID_REUSE`. Exact replay
   returns the original receipt object, including intent identity, with no commit
   proposal and no new intent. This remains true after revision/epoch changes,
   capability removal and terminal observation, provided the principal retains
   authorization for the original scope.
3. For a fresh ID, validate snapshot, match scope/epoch/revision/attempt and
   explicit capability, then decide the transition.

Revoked or wrong-scope grants fail `SCOPE_FORBIDDEN` **before lookup**, including
on replay. Thus changed run/node/workstream reuse tests grant that changed scope
to expose `COMMAND_ID_REUSE`; an unauthorized target cannot be used as a receipt
existence oracle. Invalid principals fail `INVALID_PRINCIPAL` before lookup.

## Receipts and transitions

Every result contains `receipt`, `intents`, `commit`, `replayed`. A rejected
receipt is `{outcome:"rejected", reason}` with empty intents and null commit.
It reserves no command ID. A non-rejected receipt contains
`{commandId, outcome, intentId, revision}`. The outcomes are:

| Outcome | Proposal |
| --- | --- |
| `accepted` | One effect intent and a state transition; no settlement |
| `coalesced` | Zero new intents; references the pending cancellation's intent |
| `already-terminal` | Zero intents and null intent ID; no cancellation invented |

New proposals are provisional until store commit. Every fresh non-rejected
receipt increments revision once, including coalesced and terminal no-effect
receipts, so ledger changes participate in compare-and-commit. Replays preserve
the original receipt revision. Intent IDs are deterministic `intent:<commandId>`
within the state root; these internal IDs are not command-envelope IDs.

A reply requires blocked state, no pending cancellation on the current attempt,
and an unanswered request matching ID/run/node/attempt/current blocked sequence.
Its intent retains the original attempt, request ID, exact text, blocked sequence
and `nextAttempt`. The proposed state consumes the request, increments attempt,
clears current blocked sequence/cancel, and becomes `running`. This is admission
state for the resumed attempt; it does not attest that a host resumed execution.

A running/blocked cancel marks its current attempt pending and emits one intent.
A new ID at the current revision for that same pending attempt coalesces. A
terminal node produces a no-effect receipt after the fresh-command checks.
An old-revision command still rejects even if cancellation is pending/terminal.

Successful compare-and-commit establishes order, independent of invocation:

- Cancel commits first: an already-admitted reply loses CAS. A fresh reply at the
  new revision fails `CANCEL_PENDING`.
- Reply commits first: an old cancel loses CAS or fresh admission with
  `STALE_REVISION`. Updating revision alone still fails `ATTEMPT_MISMATCH`.
  A cancel addressed to the new current attempt and revision can be accepted.

Other admission reasons are `INVALID_SNAPSHOT`, `SCOPE_MISMATCH`,
`OWNER_EPOCH_MISMATCH`, `STALE_REVISION`, `ATTEMPT_MISMATCH`,
`UNSUPPORTED_CAPABILITY`, `NOT_BLOCKED`, `REQUEST_MISMATCH`, `REQUEST_ANSWERED`,
and `COUNTER_EXHAUSTED`. Counter increments never exceed safe integers.

## Store and adapter ports

The module declares `CommandStore`, `CommitProposal`, `WorkerCommandAdapter`,
snapshot, receipt and intent interfaces in JSDoc. No production implementation
or effect runner is included. A future store must atomically:

1. Fence the exact workstream/run/node, expected revision and owner epoch.
2. Enforce state-root-wide command ID uniqueness with principal/digest binding.
3. Persist the receipt, next state and all intents together, or write nothing.
4. Return dispatchable intents only for a successful new commit. A duplicate,
   conflict or stale proposal returns zero dispatchable intents.

Authorization/capability revocation must participate in revision invalidation or
be fenced in the transaction. Read views/proposals stay internal; a transport
cannot submit fabricated commit proposals. Ledger retention is part of the
future store's guarantee, not a cache optimization. Receipt lookup should be
consistent with state; the commit must still recheck races and deduplication.

Only committed and claimed outbox intents may reach adapter `reply(intent)` or
`cancel(intent)`. Adapter resolution is transport acceptance. Settlement,
cancellation finalization, host notification receipt and model turn start remain
separate observations. This kernel emits none of `node.settled`,
`parent.awakened`, or any other canonical event.

The private memory store demonstrates these port obligations with frozen inputs,
atomic synchronous writes, and deferred gates at the actual commit await. Its
dispatch set is only a single-instance spy aid. It does not prove persistence,
cross-process atomicity, crash handling, adapter retry safety or reconnect.
Discarding the ledger on a fake restart would discard replay protection; no
such restart is claimed safe. PAR-1B must define persisted outbox claims,
reconciliation and ambiguous-effect handling before real execution.

## Compatibility and verification

Canonical protocol remains revision 1.1 (`v:1`); result-artifact-v2 remains
lenient for every nonblank artifact and fails missing/unreadable/blank artifacts.
Existing schemas, fixtures, projectors and host writers are untouched. In
particular, the Pi observer still records transport effects after they occur;
this kernel does not fix a live host until a separately approved integration.

```sh
node --test tests/advisor-command-contract.test.mjs
node --test tests/advisor-command-admission.test.mjs
node scripts/advisor-trace.mjs validate config/advisor-core/fixtures/blocked-reply-resume.jsonl
node scripts/advisor-trace.mjs validate config/advisor-core/fixtures/cancel.jsonl
node scripts/advisor-trace.mjs validate config/advisor-core/fixtures/graph-two-waves.jsonl
node scripts/advisor-trace.mjs validate config/advisor-core/fixtures/one-worker-blocked.jsonl
node scripts/advisor-trace.mjs validate config/advisor-core/fixtures/one-worker-done.jsonl
node --test tests/result-artifact.test.mjs
node --import tsx --test tests/result-artifact-core.test.ts
npm run check
```

The admission tests isolate dedup from stale-revision rejection, deny unauthorized
lookup before any ledger read, reject all named request bindings, exercise both
commit orders and gate adapter spies across successful and failed commits. Maker
evidence includes isolated source mutations of scope validation, deduplication,
principal validation and commit-before-effect ordering. Passing memory tests is
interface conformance evidence only; independent High-risk checking remains a
separate review responsibility.
