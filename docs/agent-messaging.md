# Cross-harness agent messages

Managed Pi, Codex CLI and Claude Code workers use **`agent_message`** with the same
JSON arguments. Pi exposes a tool; native workers receive a per-process MCP server
(hosts may namespace its tool name). The CLI is a fallback with the same contract.
No `/advisor`, team enlistment, global MCP configuration or separate broker is required.
Install matching Meta and pi-detach revisions; already-running workers are not adopted.

```js
agent_message({ action: "list" })
agent_message({ action: "send", to: "parent", text: "Does null mean not found?" })
agent_message({ action: "reply", replyTo: "<received messageId>", text: "Yes. Preserve it." })
agent_message({ action: "status", messageId: "<returned messageId>" })
agent_message({ action: "wait", messageId: "<returned messageId>", timeoutMs: 10000 })
```

`list` returns `self`, `parent` and authorized `peers`, including role, harness,
state and availability. Use an exact peer ID or an unambiguous listed name. Workers
see their parent and siblings. Pi child advisors additionally see their own children;
there is no global session or cousin discovery. `parent` (also `root`/`advisor`)
always means the launching advisor, not a selectable terminal pane.

`send` requires `to` and `text`. `reply` requires `replyTo` and `text`; its recipient
comes from the authorized inbound message, not caller-supplied sender metadata.
`send` may also supply `replyTo` when its target matches that inbound sender.
Unknown or inapplicable arguments are rejected. `wait` allows 0–10000ms, defaults
to 10000ms, and returns when a reply arrives or the timeout expires. Timeout is
not cancellation; it does not promise a later wake if the host disconnects. If an
answer is needed, wait before ending the task: a reply cannot resurrect an
auto-closed worker. A kept worker can receive a tracked same-session continuation.

## Relationship to pi-detach-runtime

This is native to Meta Harness, not another runtime. Meta owns the shared protocol,
authorization and durable message records in its existing runtime service.
`pi-detach` supplies the Pi tool/receiver and the Herdr execution adapter; its
`pi-detach-runtime.json` configuration connects Pi to that same service.

Existing `pi-detach-runtime` notifications report worker lifecycle/results, and
`bg_agent({name, prompt})` remains the advisor's task/follow-up interface.
`agent_message` adds scoped worker-to-advisor and sibling conversations, correlated
replies and message status on the same delivery infrastructure. Legacy team
messaging remains compatible; no second broker or parallel worker manager is added.

## Delivery and retries

Results carry `messageId`, attributed `from`/`to`, `text`, `replyTo`, `replies`,
and `status`: `accepted`, `queued`, `rejected` or `unknown`. **`read` and `done`
remain `null`.** Admission/queueing is not proof that an agent read, understood,
answered or finished anything. Inspect replies rather than inferring completion.

Send/reply accept an optional `messageId` idempotency key. Facades generate one if
omitted. Retrying the same ID and payload as the same authenticated sender returns
the existing record; changing its payload rejects `MESSAGE_ID_REUSE`.
A transport failure returns the attempted ID with `MESSAGE_TRANSPORT_UNCERTAIN`
and `outcomeKnown: false`. Check status or retry the *exact same ID and payload*;
never generate a fresh ID to retry uncertain input. An uncertain native injection
is not replayed automatically.

Messages to the managing Pi advisor use its attributed message API: steering while
busy, a new turn when idle. Worker delivery reuses the identity-checked Herdr input
path. The installed harness determines whether input steers immediately or queues
for its next turn.
An eligible idle kept worker continues in the same recorded session, with ordinary
attempt tracking. A missing, replaced, cancelled, blocked or recovery-required worker
is not relaunched to deliver a message. No input is typed through permission dialogs.

Messages are questions/advice/context, **not assignments, permission grants, write
ownership transfers or changes to acceptance**. The owning advisor remains responsible
for coordinating writers and deciding how advice affects the authorized task.

## CLI and security

Managed workers receive host-bound paths in their environment:

```sh
"$AGENT_MESSAGE_NODE" "$AGENT_MESSAGE_CLI" '{"action":"list"}'
"$AGENT_MESSAGE_NODE" "$AGENT_MESSAGE_CLI" '{"action":"send","to":"parent","text":"Question?"}'
# Read JSON from stdin instead:
printf '%s' '{"action":"list"}' | "$AGENT_MESSAGE_NODE" "$AGENT_MESSAGE_CLI" -
```

The package also supplies `agent-message <JSON|->` and `agent-message mcp`.
CLI and MCP return `{ok:true,value:...}` or `{ok:false,error:...}`. CLI errors have
nonzero exit status; MCP uses tool errors. MCP exposes only `agent_message`.

`AGENT_MESSAGE_DESCRIPTOR` names a private, protected credential outside artifact
and workspace roots. Workers receive messaging authority only—not the advisor's
management token, launch capability or artifact access. The runtime authenticates
sender identity and checks current worker eligibility on reads and retries as well
as sends. Models cannot submit sender, pane, socket, credential or scope arguments.
Credentials are cooperating same-UID capability boundaries, not an OS sandbox;
never read, print or copy their contents into prompts or artifacts.

See [managed runtime](pi-detach-runtime-bridge.md) for install/recovery and
[runtime contract](advisor-durable-runtime.md) for durable ownership and delivery.
Offline tests exercise the socket, CLI/MCP contract, runtime and fake execution
ports. They do not by themselves establish provider-version-specific live steering.
