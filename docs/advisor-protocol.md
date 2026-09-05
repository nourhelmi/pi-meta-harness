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

## 🧾 Canonical event trace (protocol revision 1.1, `v: 1`)

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
| `type` | one of the fourteen types below |
| `data` | type-specific payload |

### Event types

| Type | When a host emits it | Required data |
| --- | --- | --- |
| `run.created` | the advisor opens a run | `workstream`, `root.node`, `root.session` |
| `graph.planned` | a manifest-backed graph is correlated to the run | `graph`, `waves`, `maxParallel`, `maxRepairLoops` |
| `wave.started` | a contiguous graph wave opens | `wave`, `nodes` |
| `wave.completed` | every listed node in a started wave has settled | `wave`, `nodes` |
| `node.launched` | a worker starts | `role`, `label`, `harness`, `model`, `thinking`, `cwd`, `riskTier`, `acceptance` |
| `node.progress` | a bounded non-terminal note | `note` |
| `node.blocked` | the worker needs a decision, permission, credential, or external action | `request.kind`, `request.text` |
| `node.reply.sent` | the advisor or user answers a blocked node | `text`, `source`; optional `replyTo` |
| `node.cancel.requested` | the host accepted a cancellation request | `reason` |
| `node.resumed` | a blocked, stalled, or restartable node begins another attempt | `reason` |
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
2. A node's first event is `node.launched`, and a node launches once. `parent`
   is stable across a node's events and resolves to the run root or to a
   launched, unsettled node.
3. `node.result.validated` follows `node.result.written` for the same path. A
   valid result carries its `status`; an invalid one lists `problems`.
4. A `done` or `blocked` settlement requires a prior `node.result.validated`
   with `valid: true`. `failed`, `stalled`, and `cancelled` do not. A
   `blocked` settlement requires a prior `node.blocked` carrying the request.
5. `graph.planned` appears at most once and before any `node.launched`.
6. `wave.started` and `wave.completed` require `graph.planned`; waves are
   contiguous from 1, wave N starts only after N-1 completes, and completion
   requires every listed node to be settled.
7. A settled node accepts no further node events except a legal resume, or a
   cancellation request on a blocked node. `node.resumed` follows a blocked or
   stalled settlement; reason `restart` may also resume a node before any
   settlement. Resume returns the node to running for another attempt.
8. `node.reply.sent` is legal only after a blocked settlement. Its next event
   for that node is `node.resumed` with reason `reply`; when present, `replyTo`
   identifies the answered `node.blocked` sequence.
9. `node.cancel.requested` is legal while running or blocked. A later
   `cancelled` settlement is expected but not required because the host may not
   observe it.
10. `parent.awakened` follows a settlement since that child's previous wake,
   targets the recorded parent, repeats that settlement status, and carries a
   `wakeGeneration` that increases by one per parent. A resumed node may settle
   and wake its parent again.

Rule 4 plus rule 5 encode the durable decision from the BB proof of concept:
**wake the logical parent only after canonical result validation**, while
failures still wake the parent with a reason.

### `GRAPH` launch block

Hosts share one fixed parser for an optional launch block. `GRAPH:` is followed
by indented `key: value` lines and ends at the next blank line. `graph`, `node`,
and `wave` are required; `repair`, `upstream`, and `downstream` are optional.
The list fields are comma-separated.

```text
GRAPH:
  graph: packet-9
  node: protocol-builder
  wave: 2
  repair: 0
  upstream: /state/runs/planner/result.md
  downstream: protocol-checker, browser-proof

```

The manifest is `<root>/graphs/<graph>.json`. A graph run is
`graph-<graph>` and uses the block's node id.

## 🔍 Validate and project

```bash
node scripts/advisor-trace.mjs validate config/advisor-core/fixtures/one-worker-done.jsonl
node scripts/advisor-trace.mjs project  config/advisor-core/fixtures/one-worker-blocked.jsonl
```

`validate` exits 0 on a conforming trace and prints `CODE seq N: message` lines
otherwise. `project` prints the reference projection a surface renders: the run
with optional `graph` and wave records (`wave`, `nodes`, `startedAt`,
`completedAt`),
each node with a derived state (`running`, `blocked`, `result-written`,
`result-validated`, `result-invalid`, `settled`), its settlement `attempts`,
`replies`, and `cancelRequested`, and the wakes delivered. `node.resumed`
returns derived state to `running` while retaining the last settlement fields.
The validator has no dependencies and implements the JSON Schema subset the
schema file uses, so hosts in other languages can validate with any 2020-12
implementation and get the same shape verdicts.

## ✅ Conformance

A host conforms when the same logical run executed through it produces a
trace that validates and projects equivalently to the reference host, and a
surface conforms when it renders a fixture trace from files alone, with no
host transcript or provider bridge.

## Result validation

Advisor Core result validation v2 stalls only for a missing, unreadable, or
blank artifact. It extracts the first Status label whether formatted as a
Markdown heading, plain label, or bold label; without a Status label it scans
the first ten nonempty lines for a known status token. Only that status line
can classify the result as `blocked` or `in-progress`; any other or unknown
status is terminal.

Status, Claims, Evidence, Files, Decisions, and Remaining Risk remain the
expected template. Missing or empty sections produce advisory notes, carried
with `valid: true` in `node.result.validated.data.problems`; they never stall
settlement. This is the shared `result-artifact-v2` rule implemented identically
by the script and TypeScript Advisor Core validators.

## Pi host binding

Pi plus pi-detach is the reference protocol 1.1 host binding. The top-level
`advisor-pi-host` extension registers no tools: in an initialized advisor
session it observes Pi's `tool_call` and `tool_result` events for `bg_agent`
and `bg_stop`,
then observes promoted settlement through `message_end` when the message role
is `custom` and its type is `detach_agent_settled`. It does not poll, watch
files, or ask pi-detach to understand advisor semantics.

Without a `GRAPH` block, each successful `bg_agent` launch becomes its own
canonical run. The run id is
the pi-detach `details.runId` (or the settled `RunRecord.id`), its worker node
is `<role-or-freeform>-<runId>`, and its parent is the `advisor` root. Native
runtime names map as `pi` → `pi`, `codex` → `codex`, and `claude` →
`claude-code`. The adapter parses `risk tier` followed by `low`, `standard`, or
`high` from the launch prompt, case-insensitively; an absent or unrecognized
tier defaults to `high`.

With a valid `GRAPH` block and manifest, Pi uses run `graph-<graph>` and the
block's node id. The first launch appends `run.created`, `graph.planned`, and
`wave.started` before `node.launched`; later waves start only once. The
settlement batch appends `wave.completed` when every node listed in that wave
has settled. A missing or unusable manifest falls back to the ordinary
single-launch run and records `runs/pi/<detachRunId>/graph-manifest-missing.json`
without breaking the `bg_agent` result pipeline.

Advisor Core reads and validates the durable result itself. The host emits
`node.result.written` only for a nonempty artifact and emits
`node.result.validated` from Core's verdict before settlement. A pi-detach
`done` or `idle` becomes canonical `done` for any nonblank artifact. Missing
or empty expected sections are validation notes; only a missing, unreadable, or
blank result stalls rather than borrowing pi-detach's settlement truth. When
pi-detach supplies a typed `settlementNote`, the adapter prefers it to parsed
tail text for the canonical settlement reason.

A name-based `bg_agent` follow-up whose native runtime is `existing` resumes the
same canonical node only when its latest settlement is `blocked`. Pi appends
`node.reply.sent` with the prompt and blocked sequence, then `node.resumed`;
the next settlement wakes the parent at the next generation. Follow-up to any
other state retains the single-launch behavior. A successful `bg_stop` result
for a tracked detach run appends `node.cancel.requested`; the later killed
pi-detach settlement becomes canonical `cancelled` and wakes the parent.

## Claude Code host binding

Claude Code is a second v1 execution host for exactly one maker per canonical
run. It uses the native `Agent` tool and a custom subagent whose frontmatter
name is `advisor-maker`. The definition's `background: false` flag does not
force foreground execution; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` is
required for the foreground parent wake. The standalone plain-Node binding is
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
returned. Missing, unreadable, or blank output settles `stalled`; a nonblank
BLOCKED artifact emits the blocked request before result-written and settles
`blocked`; another nonblank terminal artifact settles `done`. Section notes
are carried in the validation event and do not change settlement.

### Install the Claude Code binding

After installing the harness, install the binding at user or project scope:

```bash
node scripts/meta-harness.mjs install-host-bindings --host claude-code --scope user
node scripts/meta-harness.mjs install-host-bindings --host claude-code --scope project --cwd /path/to/project
```

The command non-destructively appends the materialized hook groups to
`~/.claude/settings.json` or `<cwd>/.claude/settings.local.json`, preserves
existing hooks and environment values, and copies the `advisor-maker` agent
definition. It uses the absolute binding path under the installed Pi agent
directory and creates a scoped backup before changing existing files. Use
`--dry-run` to inspect the planned changes without writing.

Manual fallback:

1. Merge the hook groups from the installed
   `~/.pi/agent/advisor-hosts/claude-code/settings-snippet.json` into the target
   settings file without replacing existing hook groups.
2. Copy the installed
   `~/.pi/agent/advisor-hosts/claude-code/agents/advisor-maker.md` to project
   `.claude/agents/advisor-maker.md` or user
   `~/.claude/agents/advisor-maker.md`.
3. Set `env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` only when that key is
   absent. This environment setting is required: the agent definition's
   `background: false` flag alone does not force foreground execution.
   Background launch is unsupported because it has no equivalent foreground
   parent-delivery hook. The definition removes `Agent` from the maker's
   tools; `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` is an optional session-wide
   nested-delegation guard.

Claude Code's native RuntimeCapabilities are: `backgroundWorkers: true`;
`visibleWorkers: partial` (task panel/transcript, not an independent advisor
surface); `independentControl: partial`; `interactiveBlockedState: partial`;
`durableResults: partial`; `restartRecovery: partial`; and
`nestedDelegation: true`, disabled for `advisor-maker`. This adapter uses
foreground workers only and emits no `node.progress`. It parses the shared
`GRAPH` block and, when the manifest exists, correlates the native maker to run
`graph-<graph>` and the declared node with `graph.planned` and `wave.started`.
It does not coordinate completion beyond its single maker, reply to BLOCKED,
cancel, or resume nodes.

## Codex host binding

Codex CLI is a third v1 execution host for exactly one maker per canonical
run. The standalone plain-Node binding is
[`../scripts/codex-advisor-trace.mjs`](../scripts/codex-advisor-trace.mjs). It
uses lifecycle hooks only: it does not use `notify`, app-server, an MCP
observer, or a live `codex` subprocess. No hook blocks, returns a permission
decision, rewrites tool input, or substitutes `last_assistant_message` for the
durable artifact.

The shipped hook snippet has exactly four hook groups. The spawn matcher is
`^(spawn_agent|Agent|multi_agent_v1\.spawn_agent)$`, both subagent groups match
`advisor-maker`, and there is no wait matcher.

| Hook | Matcher | Canonical action |
| --- | --- | --- |
| `PreToolUse` | `^(spawn_agent\|Agent\|multi_agent_v1\.spawn_agent)$` | Record the qualifying `advisor-maker` launch's `tool_use_id`, prompt (`message` or text `items`), task name, requested model and reasoning effort, session, and cwd. Emit no trace. |
| `SubagentStart` | `advisor-maker` | Reserve the result path, lazily append `run.created` and `node.launched`, and return the exact path through `hookSpecificOutput.additionalContext`. |
| `PostToolUse` | `^(spawn_agent\|Agent\|multi_agent_v1\.spawn_agent)$` | Parse an object response or a JSON string response. Record V1 `agent_id` and `nickname`, or V2 canonical `task_name` and `nickname`. Emit no canonical event. |
| `SubagentStop` | `advisor-maker` | Inspect the reserved artifact and append one ordered batch: `node.blocked` when Status is BLOCKED, result-written and validation events for a nonempty artifact, `node.settled`, then `parent.awakened` with the next wake generation. |

`run.created` is lazy: a normal Codex session, a non-maker spawn, and the
maker's spawn `PreToolUse` do not create a canonical run. The first matching
`advisor-maker` `SubagentStart` allocates the run. Its id is
`cx-<first 16 hex of sha256(session_id)>-<launch ordinal>`. The worker is
`advisor-maker-<first 16 hex of sha256(agent_id)>`, its parent is the
`advisor` root, and `root.session` is the hook `session_id`. Every event has
host `codex` and every launch has harness `codex`. Pending launch, ordinal,
agent, and tool-use correlation state lives under
`<stateRoot>/hosts/codex/<session_id>/`; trace appends and state transitions
are serialized, and replayed payloads append nothing.

Launch fields are fixed from the spawn input and packet:

- `riskTier` parses `RISK TIER` followed by low, standard, or high and defaults
  to `high`;
- `acceptance` parses bullets or numbered entries under `ACCEPTANCE CRITERIA`
  and defaults to `result.md validates with the six required headings`;
- `model` is `tool_input.model` or `unknown`, and `thinking` is
  `tool_input.reasoning_effort` or `unspecified`;
- `label` is `tool_input.task_name` or `advisor-maker`, `cwd` is the hook cwd,
  and `workstream` is `ADVISOR_WORKSTREAM` or `codex`.

Before `node.launched`, the binding reserves
`<stateRoot>/runs/codex/<runId>/result.md`. `SubagentStop` uses the shared Core
result validator. A nonblank BLOCKED result settles `blocked`; another nonblank
result settles `done`; missing, unreadable, or blank output settles `stalled`.
Section notes are carried in `node.result.validated.data.problems` with
`valid: true`.

Codex delivers child completion to the parent natively and automatically, so
`SubagentStop` records the canonical `parent.awakened` immediately after
`node.settled`. No hook fires for `wait_agent`; a wait payload that somehow
reaches the binding is ignored. In v1, a child that dies without
`SubagentStop` remains unsettled because no wait-status fallback exists. Codex
hooks expose no bounded canonical progress note, so the adapter emits no
`node.progress`.

### Install the Codex binding

After installing the harness, install the binding at user or project scope:

```bash
node scripts/meta-harness.mjs install-host-bindings --host codex --scope user
node scripts/meta-harness.mjs install-host-bindings --host codex --scope project --cwd /path/to/project
```

The command non-destructively appends the materialized event groups to
`~/.codex/hooks.json` or `<cwd>/.codex/hooks.json`, preserves existing groups,
and copies the `advisor-maker` agent definition. It never reads or writes
`config.toml`. A scoped backup precedes any write; `--dry-run` only prints the
plan. Open `/hooks`, review the exact non-managed definitions, and trust them
unless Codex was launched with `--dangerously-bypass-hook-trust` (pi-detach
passes it). Changed definitions are skipped until trusted again, and project
hooks and agents additionally require project trust.

Manual fallback:

1. Merge the event groups from installed
   `~/.pi/agent/advisor-hosts/codex/hooks.json` into user
   `~/.codex/hooks.json` or a trusted project `.codex/hooks.json` without
   removing or reordering existing groups. Do not replace or reuse the user's
   `notify` command in `config.toml`.
2. Copy installed
   `~/.pi/agent/advisor-hosts/codex/agents/advisor-maker.toml` to user
   `~/.codex/agents/advisor-maker.toml` or a trusted project
   `.codex/agents/advisor-maker.toml`. The definition keeps
   `[agents] enabled = false` as a second guard against nested delegation.
3. Open `/hooks` and trust the definitions unless the bypass flag is active.

Codex's native RuntimeCapabilities are: `backgroundWorkers: true`;
`visibleWorkers: partial` (native activity and thread views, not a canonical
advisor surface); `independentControl: partial` (native control exists but V2
children retain parent authority); `interactiveBlockedState: partial` (no
canonical durable request contract); `durableResults: partial` (Codex does not
reserve or validate advisor artifacts); `restartRecovery: partial` (thread
recovery does not recover adapter correlation and wake state); and
`nestedDelegation: true`, disabled for `advisor-maker`. It parses the shared
`GRAPH` block and, when the manifest exists, correlates the native maker to run
`graph-<graph>` and the declared node with `graph.planned` and `wave.started`.
It does not coordinate completion beyond its single maker, reply to BLOCKED,
cancel, or resume nodes.

## Step 6 host support

| Host | Graph correlation | Wave completion | BLOCKED reply | Cancel request | Node resume |
| --- | --- | --- | --- | --- | --- |
| Pi + pi-detach | yes | yes | yes | yes | yes |
| Claude Code | yes | single-maker correlation only | no | no | no |
| Codex | yes | single-maker correlation only | no | no | no |

## 🗺️ Migration status

| Step | State |
| --- | --- |
| 1. Canonical one-worker trace schema, fixtures, validator | done (this page) |
| 2. BB renders the fixture trace from files | pending, separate surface workstream |
| 3. Pi plus pi-detach as the first conforming host | done |
| 4. Claude Code host adapter, one maker only | done |
| 5. Codex host adapter with the same conformance tests | done |
| 6. Graphs, BLOCKED replies, cancellation, resume | done (Pi reference; native hosts graph correlation only) |

The schema is owned here and consumed by hosts; pi-detach remains pinned by
commit and unaware of advisor semantics. The skill relayout into
`advisor-core/`, `hosts/*`, and `surfaces/*` follows the first conforming host
rather than preceding it.
