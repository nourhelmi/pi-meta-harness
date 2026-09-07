# Portable native advisor — implementation contract and bounded live runbook

**Experimental, opt-in managed integration — not a migration requirement.** The
standalone `advisor-native` binary is separate from the existing Pi-root
`/advisor-native` skill, which keeps Pi and Herdr as the normal advisor setup.

**Known live failure:** with Codex CLI 0.153.4, the current launcher disables
`code_mode_host`; the tested model turn could not load the advisor skill or use
the runtime tools. A real root → maker → result → synthesis workflow is **not
proven**. Prefer the existing Pi/Herdr setup; stock-host MCP-plus-skills
simplification and live native proof are deferred. The procedures below document
the experimental implementation, not a working production recommendation.

Native read boundaries have bounded deterministic/no-model evidence using pinned
Codex profiles and Claude all-tool hooks. Independent implementation review passed,
but it does not certify model usability. This package owns new runtime runs only,
does not attach to arbitrary chats or certify Codex App, and has no mandatory
Pi/Herdr/BB dependency.

## Supported surface and exact evidence

| Component | Implemented interface | Limitations / source pin |
| --- | --- | --- |
| Codex CLI | App Server stdio initialize/initialized, thread/start, turn/start, turn/interrupt; owned thread and item correlation; streamed output, user questions and explicit permission denial | Exact `codex-cli 0.153.4`; experimental v2 generated TS/JSON schema. Unknown methods/items/statuses fail recovery-required. No arbitrary executable, profile, App endpoint or thread resume input. |
| Claude Code | `@anthropic-ai/claude-agent-sdk` streaming `query`, `initializationResult().hooks_applied`, all-invocation `PreToolUse`, `canUseTool`, result + session idle, interrupt receipt and observed process exit | Exact SDK `0.3.263`, bundled CLI `2.1.263`. Ordinary `enter claude-code` requires standalone `2.1.263`; older `2.1.261` is rejected. No fallback to another host/binary. |
| Native root | Ordinary CLI root loads project skill + scoped service MCP; client-mode root is service-owned via root.create/message/reply/cancel/stop | These are alternative roots. Never launch both for the same task. MCP wait/ack is explicit; no unsolicited model-wake claim. |
| Recovery | Reconnect clients to the same live private Unix service, redeliver unacked outcomes | Stored-session resume / service-restart reconciliation deliberately return unsupported or recovery-required. No blind model/effect replay. |
| Permissions | Named Codex filesystem profiles on both thread and turn, no legacy sandbox fields; read-only root/reader, task-local write maker, minimal runtime reads, denied controls, network disabled. Claude all-invocation hooks + explicit tools/default permissions/strict MCP | Codex App Server uses supported `untrusted` enum; ordinary CLI uses supported `never`, so expansions cannot be approved. Claude one-shot Write/Edit approval binds the exact input and rechecks paths; no session grants. Bash/Agent/Task/Web and unknown tools are denied. |

The protocol scout generated 0.153.4 `ThreadStartParams`, `TurnStartParams`, `TurnCompletedNotification`, `ThreadItem`, approval/user-input unions and checked strict-config parsing of both `features.multi_agent=false` and `agents.enabled=false`. `multiAgentMode` is deprecated/ignored and not used. SDK declarations establish `Options`, `SDKMessage`, `CanUseTool`, `SpawnOptions`/`SpawnedProcess`, `sessionId`, `settingSources`, MCP config and interrupt_receipt_v1. Repository deterministic fixtures are synthetic, not captured live-model transcripts. Exact local source locators/hashes and executable probes belong in the builder/parent evidence bundle, not hardcoded machine paths in shipped assets.

Native identity is persisted in `runs/RUN/NODE/native.json`: requested model/thinking and observed host/version/model/thinking/session are distinct. Codex thread/start reasoningEffort is the initial thread observation; requested turn effort has no independent completion receipt. Claude init effort can be absent, hence null. Model aliases may resolve differently. Never infer a served model/effort or live reliability from requested settings. No token/cost claims when absent.

## Runtime integration

The foreground CLI installs the two real adapters in its fixed registry. A private bootstrap contains exact trusted principals; model/remote clients cannot select JS modules, processes, config, grant authority or event writers. For client-mode root.create the registry requires exactly one advisor principal with root scope, `node.launch` and `wait`. Its descriptor path goes only into the dedicated MCP subprocess configuration. Workers receive **no MCP descriptor** and no root launch/grant tools. Authenticated tools/list advertises only actual principal operations; every call is reauthorized independently.

The optional Pi compatibility extension is a separate model client transport. A trusted operator may set `ADVISOR_RUNTIME_DESCRIPTOR` before Pi loads the extension; Pi then forwards scoped commands with audience `model` and pre-effect blocks legacy `bg_agent`/`bg_stop`. It neither hosts this package's runtime nor selects/launches these native adapters. Without that opt-in, the existing Pi/Herdr worker implementation remains unchanged. The native package is still Node 24+, named `@nourhelmi/advisor-native`, packed by `scripts/pack-advisor-native.mjs`, and contains no Pi/Herdr dependency or extension source.

New operation `node.launch` is **root-scoped** with `{node}` and the current run revision; it launches one previously admitted packet through the same transaction/outbox, without graph or wave events. Direct and graph modes cannot be mixed in a run. Writer admission checks overlapping workspaces across runs. PAR1A's pure reply/cancel oracle remains unchanged. Native node.reply rebinds asynchronous emitters to the new attempt/effect before delivering the answer.

Concrete adapters always emit `verified:false`. Only trusted host code may call `runtime.verifyNode({scope,expectedRevision,resultSha256,evidenceSha256})`, after inspecting deterministic evidence. It verifies the actual result hash before enabling dependent waves and rechecks the attested hash at dependent-wave admission; there is no remote/model verification operation. Formatting or PASS prose does not establish acceptance. Injected legacy test adapters remain trusted host integrations responsible for their own verified flag.

The host writes a bounded actual result.md from the final native answer, and writes a BLOCKED result before ingesting the durable request. Maker tools write only the product workspace, not the service artifact directory. Root stop is a new explicit `root.stop` operation with empty payload; it requires idle, stops the owned host process/query, and records observed process exit separately. Claude precommitted session handles carry host-only `requiresExit:true`, keeping shutdown/writer fences until observed exit even though the PID was unknown before query creation. Cancellation acceptance, terminal native turn, native OS exit and delivery ack are different facts. Unknown protocol / timeout / output exhaustion requests native shutdown and marks the already-owned effect recovery-required; this is not proof that an uncooperative child has exited.

Limits: six conversation submissions, 180 seconds per native session, 1 MiB cumulative native stdout/events, 64 KiB stderr (discarded), 32 durable requests, 8-second RPC timeout, 16 KiB final/progress text. Claude additionally uses SDK maxTurns=6 per query turn. Codex has no proven per-model-internal-step counter in this adapter; the six-turn bound is **conversation submissions**, not an invented provider loop limit. Time/bytes remain finite. The operator may select lower trusted adapter factory limits, never higher limits from model payloads.

### Security and capability limits

Use separate canonical private service and workspace paths. `init` explicitly inventories both provider homes under `STATE/providers/`; a trusted bootstrap may supply other canonical `providerHomes` outside every task/artifact grant. Startup checks declared and persisted controls before writes, rejects changed directory inventory, and binds the provider-to-home mapping to exact bootstrap identity. Authenticate those homes through supported explicit login; **never copy credentials**. Environment forwarding is allowlisted. No global HOME fallback is allowed at native launch.

The ordinary CLI entry project is separate from all task roots and service state, but its read-only profile/hook includes the bootstrap's exact authorized task roots so the root can verify work. Only the owned MCP fragment/skill is accepted. The wrapper derives all config, accepts no extra native arguments, and never grants home/service/auth trees as read roots. Both entry and service may use the same inventoried provider home; root MCP is supplied per process, not written into that home. Runtime Codex rejects a home config.toml and every workspace/ancestor .codex directory. Entry explicitly trusts only its inspected entry project through supported per-process `projects` config, then attests effective config; unrelated legacy permission overrides, extra profiles/features/MCP servers and drift reject before a model prompt.

Codex `permissions` profiles are the supported read boundary beyond legacy `SandboxPolicy`. Shell/unified-exec is covered by actual dummy-only macOS sandbox probes, including Node 24 task-file reads. Alongside `:minimal`, macOS grants read access to the exact root-owned `/System/Library/OpenSSL/openssl.cnf` runtime file required by Node; no parent directory or user configuration is granted. Toolchains needing additional out-of-workspace files remain restricted rather than widening automatically. Pinned public apply_patch verification and execution pass filesystem sandbox context; this separate non-shell path is source-verified, not a captured live model tool event. `view_image`, browser/computer, apps/plugins, code-mode/JS, memory and nested-agent features are explicitly disabled. Dynamic tools are not supplied; root MCP has only the scoped runtime server, whose resource methods are unsupported. MCP/service API traffic is not governed by shell network policy.

Claude `PreToolUse` covers every exposed tool, not merely permission prompts. SDK initialization must report `hooks_applied:true` before the first prompt. Read/Glob/Grep and exact Write/Edit inputs are canonicalized; unknown/compound fields, traversal, links, hardlinks and control directories reject. Glob/Grep pre-scan their target subtree (10,000-entry bound), including hidden paths: a broad scan containing .git/.codex/.claude or aliases is rejected; choose a narrower safe task directory. File reads remain useful. Hook checks are not a whole-process OS sandbox or a theorem about concurrent same-UID path replacement; provider authentication remains trusted host traffic. Actual no-model SDK registration and hook subprocess tests do not certify live model-tool event delivery.

Typed credential/secret-class BLOCKED replies return `CREDENTIAL_REPLY_FORBIDDEN` before receipt/event/history/effect persistence. Use supported explicit isolated browser/device login out of band, never credential text in node.reply/root.reply, token copies or internal-only external-token injection. Ordinary non-secret question/permission replies remain supported. Native secret user-input requests are rejected, not persisted; arbitrary secrets in untyped prose cannot be reliably classified by string scanning. Do not clear recovery-required by editing SQLite.

## Build, install and no-model doctor

Build from the repository using Node 24+:

```sh
node scripts/pack-advisor-native.mjs '/absolute/artifacts with spaces'
# Creates @nourhelmi/advisor-native from the same checked-in modules, no copied implementation.
```

Install the resulting tarball into an explicit isolated prefix (not globally):

```sh
export PREFIX='/absolute/native prefix with spaces'
npm install --prefix "$PREFIX" --ignore-scripts --omit=optional /absolute/artifacts/nourhelmi-advisor-native-0.1.0.tgz
export PATH="$PREFIX/node_modules/.bin:$PATH"
advisor-native doctor
```

`doctor` makes no model calls. It reports Node/platform, exact Codex version if present, optional SDK+bundled CLI if present, and actionable gaps. To enable Claude, the operator installs the exact optional SDK in this isolated prefix and explicitly authenticates its isolated configuration directory. Do not run query just to probe a version. Node >=24 is the native package minimum; the optional Pi package engine is unchanged.

`advisor-native install codex ENTRY_PROJECT DESCRIPTOR` owns only its marked `.codex/config.toml` MCP section, `.agents/skills/advisor-runtime/SKILL.md`, and its private manifest. For Claude use `claude-code`: it owns only `.mcp.json`'s `mcpServers.advisor_runtime` member and `.claude/skills/advisor-runtime/SKILL.md`. Unrelated configuration survives install/uninstall/restore. Uninstall and restore take HOST PROJECT, use stored owned fragments, and refuse edited/foreign owned sections or symlink paths rather than overwrite them. The manifest records only owned fragment backups; a crash leaves `pending` and fails closed for operator investigation. An existing foreign advisor_runtime entry/skill is not adopted. Descriptor contents are never copied into config/skills; only its path is installed, outside the entry project. Moving the package after project installation requires uninstall with the old install then reinstall from the new prefix; the tarball itself has no machine-specific paths.

## Parent-owned live Codex CLI gate (DO NOT RUN NOW)

Budget: **at most six combined later product attempts**, across Codex/Claude/BB/eval, not six per host. Each attempt: one explicit root, one maker, at most six root submissions, 180 seconds/session, 1 MiB native output; terminate at the deadline without relaunching. A lower user limit wins. Count retries and cancelled attempts. No live canary before independent readiness approval. Use a visible operator terminal for the foreground service and a visible Codex CLI root. Progress/requests/results are inspectable via the packaged CLI throughout.

Choose canonical paths; Unix socket state path must be <=100 bytes. The following variables are examples, not commands to run in this builder session:

```sh
export PREFIX='/absolute/native prefix with spaces'
export PATH="$PREFIX/node_modules/.bin:$PATH"
export STATE='/private/tmp/advisor-live-ONE'       # short, private, new for this attempt
export WORK='/absolute/isolated maker workspace'
export ENTRY='/absolute/isolated native entry'
umask 077
mkdir -p "$WORK" "$ENTRY"
advisor-native init "$STATE" "$WORK" codex
# Explicit supported login in the inventoried home if required; no credential copies.
# HOME="$STATE/providers/codex" CODEX_HOME="$STATE/providers/codex" codex login
advisor-native doctor
# Visible terminal A; save sanitized stdout/stderr to the attempt evidence, never credentials:
advisor-runtime serve "$STATE/bootstrap.json"
```

In visible terminal B:

```sh
advisor-runtime call "$STATE/operator.json" < "$STATE/create-run.json"
advisor-native install codex "$ENTRY" "$STATE/advisor.json"
advisor-native entry-plan codex "$ENTRY" "$STATE/bootstrap.json"
# Review the plan; it contains paths/config, never credential contents.
advisor-native enter codex "$ENTRY" "$STATE/bootstrap.json"
```

At the ordinary Codex CLI prompt invoke `$advisor-runtime`. Give exact `workstream=work, run=run, ownerEpoch=1, root=root, maker=maker` and WORK. Ask it to admit one maker packet (model explicitly chosen from the operator's available Codex catalog; effort `high`, never assume availability) that inspects a tiny non-secret fixture in WORK and returns an evidence-backed result. Include the initial question requirement only when the selected Codex mode exposes requestUserInput; otherwise record unsupported exposure, never fabricate a prompt. Root uses packet.admit → node.launch, wait → artifact.read → ack → synthesis; it may read the authorized task files itself. Do not create a second service-owned root for this ordinary CLI-root attempt. A separate client-mode/BB attempt uses root.create and counts against the same total budget. For Claude use the analogous `enter claude-code` after installing/authenticating pinned supported binaries; the wrapper supplies strict MCP, all-tool exec hook and exact task read directories. Shell-based acceptance remains unsupported for Claude, not silently claimed.

Use CLI inspection at any time (JSON is public command data, never a token):

```sh
printf '%s\n' '{"v":1,"op":"progress","scope":{"workstream":"work","run":"run","node":"root","ownerEpoch":1},"payload":{}}' | advisor-runtime call "$STATE/operator.json"
printf '%s\n' '{"v":1,"op":"wait","scope":{"workstream":"work","run":"run","node":"root","ownerEpoch":1},"payload":{"timeoutMs":10000,"limit":32}}' | advisor-runtime call "$STATE/operator.json"
```

Request/reply: read maker progress and request.json. Construct `node.reply` with a new commandId, **current node revision**, current attempt, exact durable requestId and the documented answer JSON encoded in `payload.text`. Only answer the advertised permission vocabulary (Codex decline/cancel/deny; Claude exact file allow/deny or deny-only). Never answer by screen text alone. Accepted reply increments worker attempt; inspect that new attempt before later cancel. Claude input.json records the precommitted user-message UUID; only the matching SDK result may complete that turn.

Cancel: construct `node.cancel` with a new commandId, exact maker scope/current revision/current attempt and `{attempt,reason:"parent bounded cancellation"}`. Observe accepted receipt, then cancelled/native terminal result, then process-exited delivery. A repeated identical command replays its receipt; a fresh cancellation can coalesce. Do not claim receipt proves process death. Root client-mode cancellation uses root.cancel `{reason}` and root stop uses root.stop `{}` only after idle. CLI-root exit is native operator control, not runtime root.stop.

The following operator command generator is executable against the live service **only after the parent approval**. Set `OP=node.reply` and `ANSWER` to the inspected request's exact answer, or `OP=node.cancel`, or `OP=delivery.ack` and `DELIVERY_ID` to an inspected delivery. It snapshots current scope/revision/attempt and writes one public command without retrying side effects:

```sh
export OP=node.cancel  # choose deliberately; this example cancels maker
node --input-type=module > "$STATE/operator-command.json" <<'JS'
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const { STATE, OP, ANSWER, DELIVERY_ID } = process.env;
if (!['node.reply', 'node.cancel', 'delivery.ack'].includes(OP)) throw Error('Choose supported OP');
const scope = { workstream: 'work', run: 'run', node: OP === 'delivery.ack' ? 'root' : 'maker', ownerEpoch: 1 };
const read = spawnSync('advisor-runtime', ['call', `${STATE}/operator.json`], { input: JSON.stringify({ v: 1, op: 'progress', scope, payload: {} }), encoding: 'utf8', timeout: 10000 });
if (read.status !== 0) throw Error('Inspection failed');
const state = JSON.parse(read.stdout); if (!state.ok) throw Error(state.error);
const value = state.value;
let payload;
if (OP === 'node.reply') {
  if (!value.snapshot.request || value.snapshot.request.answered || !ANSWER) throw Error('Inspect current request and set ANSWER');
  payload = { attempt: value.snapshot.attempt, requestId: value.snapshot.request.id, text: ANSWER };
} else if (OP === 'node.cancel') payload = { attempt: value.snapshot.attempt, reason: 'parent bounded cancellation' };
else { if (!/^[1-9][0-9]*$/.test(DELIVERY_ID ?? '')) throw Error('Set inspected DELIVERY_ID'); payload = { deliveryId: Number(DELIVERY_ID) }; }
console.log(JSON.stringify({ v: 1, op: OP, commandId: randomUUID(), expectedRevision: value.revision, scope, payload }));
JS
advisor-runtime call "$STATE/operator.json" < "$STATE/operator-command.json"
# Exact replay: repeat the preceding call with the SAME file, not a new commandId.
# STALE_REVISION: inspect fresh state before deliberately generating a new command.
```

Reconnect: close only the inspection client or reconnect MCP to the **same live service**, then repeat progress/wait. Unacked deliveries must redeliver unchanged. Ack by `delivery.ack` with current run revision and `{deliveryId}` after processing. Resume operations return `RESUME_UNSUPPORTED`; do not restart the service to simulate reconnect. If the service crashes, preserve SQLite/handles and recovery-required evidence rather than run a second maker.

Expected artifacts: state/runtime.sqlite; state/traces/run.jsonl with one node.launched and no fake wave; runs/run/maker/result.md, request.json (if requested), native.json; admitted receipts and durable deliveries in SQLite; operator CLI/MCP snapshots; visible CLI-root synthesis transcript. Record binary versions, requested/observed models/effort, commands, wall time/turn count/available usage, source/tarball/result/trace hashes, exact attempt number and unresolved limits. Never include descriptor contents, auth or raw credential-bearing host stderr.

After all deliveries are acknowledged and workers are terminal/exited, SIGINT in terminal A requests typed safe shutdown. Refusal means inspect outstanding work, not delete locks. Uninstall/restore only in ENTRY. Do not change global installations/settings or publish the package.

The original eval baseline remains read-only. Parent may choose a named tiny original-case subset under a new setup/attempt identity, using the original evaluator unchanged; every attempt counts against six. Preserve original input/output/evaluator hashes and scores. No retrospective regrade, unmeasured speedup, or equivalence claim from one fixture run.
