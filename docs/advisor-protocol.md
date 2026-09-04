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

## Pi host binding

Pi plus pi-detach is the first v1 host binding. The top-level
`advisor-pi-host` extension registers no tools: in an initialized advisor
session it observes Pi's `tool_call` and `tool_result` events for `bg_agent`,
then observes promoted settlement through `message_end` when the message role
is `custom` and its type is `detach_agent_settled`. It does not poll, watch
files, or ask pi-detach to understand advisor semantics.

Each successful `bg_agent` launch becomes its own canonical run. The run id is
the pi-detach `details.runId` (or the settled `RunRecord.id`), its worker node
is `<role-or-freeform>-<runId>`, and its parent is the `advisor` root. Native
runtime names map as `pi` → `pi`, `codex` → `codex`, and `claude` →
`claude-code`. The adapter parses `risk tier` followed by `low`, `standard`, or
`high` from the launch prompt, case-insensitively; an absent or unrecognized
tier defaults to `high`.

Advisor Core reads and validates the durable result itself. The host emits
`node.result.written` only for a nonempty artifact and emits
`node.result.validated` from Core's verdict before settlement. A pi-detach
`done` or `idle` therefore becomes canonical `done` only when the artifact has
nonempty Status, Claims, Evidence, Files, Decisions, and Remaining Risk
sections; subsection-organized content counts, while a heading with no prose
does not. Invalid or missing results stall rather than borrowing pi-detach's
settlement truth.

Name-based `bg_agent` follow-up is intentionally limited in v1: even when it
reuses a live native agent name, it creates a new run and worker node rather
than resuming the prior canonical run.

## Claude Code host binding

Claude Code is a second v1 execution host for exactly one maker per canonical
run. It uses the native `Agent` tool and a custom subagent whose frontmatter
name is `advisor-maker`. The standalone plain-Node binding is
[`../scripts/claude-advisor-trace.mjs`](../scripts/claude-advisor-trace.mjs).
It never blocks a hook, changes tool input, grants permission, or treats the
worker's final chat message as a durable result.

The shipped hook snippet defines exactly these command hooks:

| Hook | Matcher | Canonical action |
| --- | --- | --- |
| `PreToolUse` | `Agent` | Record the pending `tool_use_id`, launch prompt, description, subagent type, requested model, session, and cwd. Emit no trace yet. |
| `SubagentStart` | `advisor-maker` | Allocate the session launch ordinal, reserve the result path, lazily append `run.created` and `node.launched`, and return the path through `hookSpecificOutput.additionalContext`. |
| `SubagentStop` | `advisor-maker` | Inspect the reserved artifact, append `node.blocked` for a valid BLOCKED result, append result-written and validation events for a nonempty artifact, and settle from Core validation. |
| `PostToolUse` | `Agent` | For a foreground `status: "completed"` result, compare `tool_response.agentId` with the start `agent_id`, record any mismatch outside the trace, and append the parent wake after settlement. |
| `PostToolUseFailure` | `Agent` | Settle an unsettled launched child as failed and wake its parent. |

`run.created` is deliberately lazy: an ordinary Claude Code session, and even
an ordinary `Agent` call, has no canonical run until an `advisor-maker`
`SubagentStart` arrives. The run id is
`cc-<first 16 hex of sha256(session_id)>-<launch ordinal>`. The worker id is
`advisor-maker-<first 16 hex of sha256(agent_id)>`; its logical parent is the
`advisor` root and `root.session` is the original `session_id`. Every event has
host `claude-code`, and the launch has harness `claude-code`. Pending launch,
ordinal, agent, and tool-use correlation files live under
`<stateRoot>/hosts/claude-code/<session_id>/`. Per-session and per-trace lock
files serialize updates, and replayed payloads append no duplicate event.

Launch packet fields come from the `Agent` prompt and documented hook fields:

- `riskTier` parses `RISK TIER` followed by low, standard, or high,
  case-insensitively, and defaults to `high`;
- `acceptance` is the `- ` bullets or numbered lines under an
  `ACCEPTANCE CRITERIA` block, or
  `result.md validates with the six required headings` when absent;
- `model` is `tool_input.model` when present. When it is absent at launch the
  append-only launch event records `unknown`; a later foreground wake may
  expose `tool_response.resolvedModel`, but cannot rewrite the launch event;
- `thinking` is `unspecified`, `label` is `tool_input.description`, `cwd` is
  the launch hook cwd, and `workstream` is `ADVISOR_WORKSTREAM` or
  `claude-code`.

The binding reserves
`<stateRoot>/runs/claude-code/<runId>/result.md` empty before launch context is
returned. A nonempty artifact must pass the same six-heading and Status-line
rules as the Pi binding. Missing, empty, or invalid output settles `stalled`;
a valid BLOCKED artifact emits the blocked request before result-written and
settles `blocked`; another valid terminal artifact settles `done`.

### Install the Claude Code binding

1. Merge
   [`../config/advisor-core/hosts/claude-code/hooks.json`](../config/advisor-core/hosts/claude-code/hooks.json)
   into the `hooks` object in a project `.claude/settings.local.json` or user
   `~/.claude/settings.json`. The relative Node command assumes Claude Code is
   running from this repository; use an absolute script path for other cwd
   layouts.
2. Copy
   [`../config/advisor-core/hosts/claude-code/agents/advisor-maker.md`](../config/advisor-core/hosts/claude-code/agents/advisor-maker.md)
   to project `.claude/agents/advisor-maker.md` or
   `~/.claude/agents/advisor-maker.md`.
3. Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for sessions using this v1
   binding. Background launch is unsupported because it has no equivalent
   foreground parent-delivery hook. The agent definition also sets
   `background: false` and removes `Agent` from the maker's tools. As a
   session-wide alternative, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` disables
   nested delegation.

Claude Code's native RuntimeCapabilities are: `backgroundWorkers: true`;
`visibleWorkers: partial` (task panel/transcript, not an independent advisor
surface); `independentControl: partial`; `interactiveBlockedState: partial`;
`durableResults: partial`; `restartRecovery: partial`; and
`nestedDelegation: true`, disabled for `advisor-maker`. This v1 adapter uses
foreground workers only, emits no `node.progress`, and does not implement
BLOCKED replies, cancellation, resume, or graphs.

## 🗺️ Migration status

| Step | State |
| --- | --- |
| 1. Canonical one-worker trace schema, fixtures, validator | done (this page) |
| 2. BB renders the fixture trace from files | pending, separate surface workstream |
| 3. Pi plus pi-detach as the first conforming host | done |
| 4. Claude Code host adapter, one maker only | done |
| 5. Codex host adapter with the same conformance tests | pending |
| 6. Graphs, BLOCKED replies, cancellation, resume | pending |

The schema is owned here and consumed by hosts; pi-detach remains pinned by
commit and unaware of advisor semantics. The skill relayout into
`advisor-core/`, `hosts/*`, and `surfaces/*` follows the first conforming host
rather than preceding it.
