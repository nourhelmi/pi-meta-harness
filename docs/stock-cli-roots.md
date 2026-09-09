# Stock CLI roots on the shared runtime

Ordinary Codex CLI and Claude Code sessions can use their normal tools, settings, authentication and permissions while the shared runtime manages visible delegated workers. A Pi parent is not required. Herdr and the pi-detach execution port remain required for this entry: root-host independence is not backend independence or dependency-free execution.

This is separate from the restrictive experimental [advisor-native entry](advisor-native.md). That entry's isolation promises and limitations are unchanged.

## Working model

Work directly when that is simpler. Delegate one cohesive task without constructing a graph. Split only useful independent work and isolate concurrent writers. The compact `meta-harness` skill covers task packets, local obstacle resolution, review boundaries and result consumption. Parents do not load whole worker skills before launching workers.

Only managed delegation uses the shared ledger. Direct root edits and native tool calls retain the native host's permissions; this is not a sandbox around the root or a defense against a hostile same-UID process. Do not run a second native delegation scheduler for the same task.

## Configuration

Install the portable harness and pi-detach first. Print a native MCP member using the same supported Node executable as the managed runtime:

```sh
/path/to/node ~/.pi/agent/scripts/advisor-runtime/stock-root.mjs config codex /absolute/path/to/pi-detach
/path/to/node ~/.pi/agent/scripts/advisor-runtime/stock-root.mjs config claude-code /absolute/path/to/pi-detach
```

The first prints a `[mcp_servers.meta_harness]` TOML member; the second prints a Claude `mcpServers.meta_harness` JSON member. These commands only print configuration. Merge that member through the client's supported configuration mechanism without replacing unrelated servers or settings. Use absolute paths. Do not add credentials, an alternate HOME, permission bypasses or captured pane IDs.

Codex's generated `env_vars` forwards only named Herdr context, optional harness configuration and negative worker-origin markers from each running session. Keep this list: Codex otherwise strips the context needed to bind the native root. It contains names, not install-time values. Claude inherits its normal environment. Stock MCP negotiates a mutually supported protocol version rather than claiming support for an unknown version.

Expose `skills/advisor-stock-entry/SKILL.md` through normal native skill discovery as `meta-harness` (for example `~/.agents/skills/meta-harness` for Codex and `~/.claude/skills/meta-harness` for Claude). The portable Pi installer copies the skill; it does not silently rewrite native global configuration. Start a fresh native conversation in Herdr after initial registration and confirm the MCP server and its ten tools are available.

## Connection, admission and completion are different

- **Connected:** MCP initialization and tool discovery succeeded. This does not prove native root binding or start a runtime.
- **Ready to start:** a read-only list before the first launch can return `STOCK_NOT_STARTED`. That is expected; it is not an instruction to launch a worker merely to inspect status. Identity errors remain real errors even when MCP is connected.
- **Admitted:** an explicit launch returns a run ID. This is accepted work, not success.
- **Completed:** explicitly wait, read the captured result and evidence, perform appropriate root verification, then acknowledge the actual delivery ID. There is no unsolicited model-wake guarantee.

Only the first explicit launch may initialize a runtime for this native root. A reconnect to the same live identity reuses its ownership; it must not create a replacement run. Missing, changed or ambiguous session/process/workspace identity cannot adopt another root's work. Native Claude's version-labelled process names are supported without dropping the executable, unique-process, ancestry or session checks.

Use explicit command IDs for launch/message/cancel. Replay transport-uncertain requests with exactly the same ID and arguments, not a fresh ID. A definite rejection can be corrected deliberately. Do not bypass a binding failure by switching backends, changing credentials or widening grants.

Worker report paths are runtime-owned. In managed workers, `ADVISOR_BRIDGE_WORKER_DIR` names the exact output directory: write `result.md` there rather than reconstructing a long path. An absent report is stalled, not PASS, even if project files pass their checks. A new running attempt cannot expose the prior attempt's report as its current result.

Cancellation admission, terminal cancellation, native process exit and pane closure are separate facts. Recovery-required is not automatically retried. Deliberately call `advisor_worker_runtime_close` after terminal work and acknowledgements; it refuses active or uncertain work and never kills workers. After close, use a new native conversation for new delegated work: the old root cannot silently replace its runtime.

## Verification and limits

On 2026-09-09, local authenticated proofs exercised both stock root hosts with no Pi parent:

| Root | Native worker | Observed outcome |
| --- | --- | --- |
| Codex CLI 0.153.4 | Codex, `gpt-5.6-sol` | Direct edit/check, one worker, captured PASS, root check, acknowledgement and explicit close |
| Claude Code 2.1.266 | Claude Code, `claude-sonnet-5` | Same end-to-end sequence; native MCP reconnect before the corrected first admission |

Evidence includes native transcripts, provider-session identities, canonical traces, one executed launch per successful proof, captured artifact hashes, acknowledgements, deterministic fixture checks and cleanup. Earlier failures remain failures: filtered Codex environment, a worker's invented report path, Claude protocol negotiation and Claude process-label binding were recorded rather than relabeled as success.

Deterministic tests additionally cover replay/reconnect, cross-root and worker-origin rejection, accepted-before-dispatch result freshness, malformed metadata, bounded framing/output, strict-entry compatibility and permanent ownership markers. Fake Herdr tests are not live model proofs. The live Claude reconnect occurred before successful admission; live reconnection with outstanding native-root work is not claimed here.

Normal native authentication, trust and approval requirements remain in force. Nested stock-root orchestration is unsupported; the explicit Pi foreman depth-one path remains separate. Existing Pi-root/native-worker evidence does not substitute for native-root evidence. Current coverage is local Herdr/macOS, not certification of every CLI version, OS or execution backend.
