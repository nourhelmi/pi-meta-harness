# 🔌 Host-neutral advisor protocol

**Advisor is a protocol and state machine. Pi, Claude Code, and Codex are
execution hosts. Herdr and BB are projections of advisor state.**

This document defines the contracts that make that statement true. Doctrine
stays in [`../skills/advisor/SKILL.md`](../skills/advisor/SKILL.md); this page
defines the data every host must emit and every surface may read. Status of
the migration is at the end.

## 🧱 Layers

```text
Advisor Core            host-neutral doctrine, contracts, and state machine
  |-- Harness adapter   Pi | Claude Code | Codex   (spawn, send, cancel, observe, capabilities)
  '-- Surface adapter   Herdr | BB | CLI | API     (render, navigate, controls, logs, artifacts)
Canonical trace and artifacts             the only truth a surface may read
```

| Layer | Owns | Never owns |
| --- | --- | --- |
| Advisor Core | workstreams, runs, graphs and waves, roles, acceptance criteria, risk tier, logical parent links, state transitions, result validation, settlement and wake rules, BLOCKED request semantics, repair caps, evidence manifests | native transcripts, pane layout |
| Harness adapter | worker creation, native messaging, stop and resume, log collection, capability reporting, translation of native lifecycle into canonical events | scheduling policy, role policy, settlement truth |
| Surface adapter | display, navigation, controls, log and artifact presentation; sends commands to the owning host | mutating run state directly |

No `if Pi / if Claude / if Codex` branch lives in doctrine. A host binding
translates "launch one visible builder with these criteria" into native calls.

## 🧰 Capability contract

A host reports what it can do. It supports a requested topology, applies a
recorded safe alternative, or rejects it. It never fakes support: an embedded
native subagent is not automatically a visible, independently controllable
worker.

```ts
type RuntimeCapabilities = {
  backgroundWorkers: boolean
  visibleWorkers: boolean
  independentControl: boolean
  interactiveBlockedState: boolean
  durableResults: boolean
  restartRecovery: boolean
  nestedDelegation: boolean
}
```

## 🧾 Canonical event trace (v1)

A run is one logical advisor execution: a single worker launch or one graph
execution. Its trace is an append-only JSONL file, one event per line, at

```text
<root>/traces/<runId>.jsonl
```

under the advisor state root (`~/.advisor/<repo-key>/`). Hosts append; surfaces
read or tail. The JSON Schema is
[`../config/advisor-core/canonical-events.schema.json`](../config/advisor-core/canonical-events.schema.json)
and is the single source of field requirements. Fixtures live beside it under
`config/advisor-core/fixtures/`.

### Envelope

Every event carries the same nine fields:

| Field | Meaning |
| --- | --- |
| `v` | protocol version, `1` |
| `seq` | monotonic per run, contiguous from 1 |
| `at` | ISO-8601 timestamp, non-decreasing within the run |
| `run` | logical run id |
| `node` | node the event is about; `null` only for run-level events; the parent node for `parent.awakened` |
| `parent` | logical parent of `node` (the advisor root or a foreman); `null` for the root and run-level events |
| `host` | emitting host: `pi`, `claude-code`, or `codex` |
| `type` | one of the eight types below |
| `data` | type-specific payload |

### Event types

| Type | When a host emits it | Required data |
| --- | --- | --- |
| `run.created` | the advisor opens a run | `workstream`, `root.node`, `root.session` |
| `node.launched` | a worker starts | `role`, `label`, `harness`, `model`, `thinking`, `cwd`, `riskTier`, `acceptance` |
| `node.progress` | a bounded non-terminal note | `note` |
| `node.blocked` | the worker needs a decision, permission, credential, or external action | `request.kind`, `request.text` |
| `node.result.written` | the durable `result.md` exists | `path` |
| `node.result.validated` | the host checked the result headings and Status line | `path`, `valid`, `problems` |
| `node.settled` | the worker reached a terminal state | `status`, `reason` |
| `parent.awakened` | the logical parent was delivered the settlement | `child`, `childStatus`, `wakeGeneration` |

Settlement statuses are `done`, `blocked`, `failed`, `stalled`, and
`cancelled`. Host-native identifiers (pi-detach run id, Herdr pane, agent name,
native task id) travel in `node.launched.data.launchRef` and are opaque to
surfaces.

### Ordering rules

The schema fixes shapes. These rules fix order, and
[`../scripts/advisor-trace.mjs`](../scripts/advisor-trace.mjs) enforces them:

1. The first event is `run.created`, exactly once. `seq` is contiguous from 1,
   all events share one `run`, and `at` never decreases.
2. A node's first event is `node.launched`; a node launches once; a settled
   node accepts no further node events. `parent` is stable across a node's
   events and resolves to the run root or to a launched, unsettled node.
3. `node.result.validated` follows `node.result.written` for the same path. A
   valid result carries its `status`; an invalid one lists `problems`.
4. A `done` or `blocked` settlement requires a prior `node.result.validated`
   with `valid: true`. `failed`, `stalled`, and `cancelled` do not. A
   `blocked` settlement requires a prior `node.blocked` carrying the request.
5. `parent.awakened` follows the child's `node.settled`, targets the child's
   recorded parent, happens once per child, repeats the settlement status, and
   carries a `wakeGeneration` that increases by one per parent.

Rule 4 plus rule 5 encode the durable decision from the BB proof of concept:
**wake the logical parent only after canonical result validation**, while
failures still wake the parent with a reason.

### Reserved for later steps

Replies to BLOCKED, cancellation, resume, and graph or wave events are not in
v1. They arrive after the one-worker lifecycle is stable on every host. Do not
emit unlisted types; the schema rejects them.

## 🔍 Validate and project

```bash
node scripts/advisor-trace.mjs validate config/advisor-core/fixtures/one-worker-done.jsonl
node scripts/advisor-trace.mjs project  config/advisor-core/fixtures/one-worker-blocked.jsonl
```

`validate` exits 0 on a conforming trace and prints `CODE seq N: message` lines
otherwise. `project` prints the reference projection a surface renders: the run,
each node with a derived state (`running`, `blocked`, `result-written`,
`result-validated`, `result-invalid`, `settled`), and the wakes delivered.
The validator has no dependencies and implements the JSON Schema subset the
schema file uses, so hosts in other languages can validate with any 2020-12
implementation and get the same shape verdicts.

## ✅ Conformance

A host conforms when the same logical run executed through it produces a
trace that validates and projects equivalently to the reference host, and a
surface conforms when it renders a fixture trace from files alone, with no
host transcript or provider bridge.

## 🗺️ Migration status

| Step | State |
| --- | --- |
| 1. Canonical one-worker trace schema, fixtures, validator | done (this page) |
| 2. BB renders the fixture trace from files | pending, separate surface workstream |
| 3. Pi plus pi-detach as the first conforming host | pending |
| 4. Claude Code host adapter, one maker only | pending |
| 5. Codex host adapter with the same conformance tests | pending |
| 6. Graphs, BLOCKED replies, cancellation, resume | pending |

The schema is owned here and consumed by hosts; pi-detach remains pinned by
commit and unaware of advisor semantics. The skill relayout into
`advisor-core/`, `hosts/*`, and `surfaces/*` follows the first conforming host
rather than preceding it.
