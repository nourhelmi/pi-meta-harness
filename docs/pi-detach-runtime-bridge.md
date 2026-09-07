# Opt-in Pi / pi-detach runtime bridge

Normal Pi remains the root conversation. The existing pi-detach `bg_agent` and
`bg_stop` registrations call the shared runtime service; no worker manager or
native root wrapper is installed. Default mode and public input schemas are
unchanged. This is local implementation/test coverage, not live model certification.

## Prerequisites and isolated setup

Use both matching bridge revisions, Node 24.18+, the service checkout's installed
`tsx` loader, and supported Herdr agent integrations. The Pi-facing client is
Node22-safe. The foreground service must start inside the owning Herdr pane so
its existing pane manager inherits that pane/tab/workspace/socket context.
Keep state outside the granted task cwd, under a short, private, canonical path.
The service uses SQLite plus its existing exclusive service lock and UDS; no
second daemon is introduced. Do not run a native Codex root wrapper.

For a **disposable** setup, prepare isolated package copies and private Pi settings
containing exactly one pi-detach extension plus the matching Meta extensions and
role profiles. In an already running normal Pi session, its shell environment
provides `PI_SESSION_ID`. Record that exact session ID for the service; a different
Pi session is rejected even if it can access the same descriptor.

```sh
# Absolute paths to the two matching package revisions (dependencies prepared).
BRIDGE_META=/path/to/pi-meta-harness
BRIDGE_DETACH=/path/to/pi-detach
BRIDGE_STATE=/short/private/bridge-state
BRIDGE_CWD=/exact/authorized/worktree
BRIDGE_SESSION=<owning-Pi-session-id>

node --import "$BRIDGE_META/node_modules/tsx/dist/loader.mjs" \
  "$BRIDGE_META/scripts/advisor-runtime/pi-detach-host.mjs" \
  "$BRIDGE_DETACH" "$BRIDGE_STATE" "$BRIDGE_CWD" "$BRIDGE_SESSION"
```

The command creates its private descriptor at `$BRIDGE_STATE/pi.json`. For the
matching Pi client process, set these before its extensions load:

```sh
export ADVISOR_RUNTIME_DESCRIPTOR="$BRIDGE_STATE/pi.json"
export PI_DETACH_RUNTIME_BRIDGE="$BRIDGE_META/scripts/advisor-runtime/pi-detach-client.mjs"
```

For a previously created Pi session, start/resume that same session with the
matching settings/environment; future reloads recreate only the client. This
packet does not install into or reload a live Pi home. The CLI bootstrap/start/close
shape is exercised with isolated packed copies and **no task/model launch**.
`hostPiDetach({stateRoot,cwd,sessionId,credentialPath,port,slots})` is the equivalent
trusted embedding API; tests exercise actual tools, service and execution port.
No operator-authored per-task packets are needed.

SIGINT/SIGTERM asks the service to close. Close refuses active, recovery-required,
or unacknowledged work; it never interprets shutdown as cancellation. Reuse the
same state, descriptor, cwd, session and slot count on restart. Never delete an
owner lock to force adoption.

## Boundaries and behavior

- The host enrolls 16 exact root/worker slots by default (1–32 via embedding).
  Slots are never recycled after launch. Pool exhaustion is explicit. Tool call
  identity binds session + actual `toolCallId`; labels grant no authority.
- The service persists the resolved command, role prompt, requested model and
  thinking, skills, turn cap, effective harness, keepAlive, result policy, worker
  environment and raw invocation
  before core launch admission. Core receipt/outbox claim precedes acquisition;
  a handle containing pane, agent name, protocol session reference and initial
  `state_change_seq` commits before task prompt. The ten-second acceptance bound
  is unchanged. Unknown start/prompt/reply outcomes require recovery, never retry.
- Use the returned `pib-…` ID for list/output/stop, or as `name` for an exact owned
  **artifact BLOCKED** reply. This alias is a durable scope, not a live Herdr name
  lookup. Replies carry core attempt/request/revision bindings plus the durably captured
  BLOCKED generation. An intervening native turn rejects before prompting.
  Replies retain admitted launch settings; changing `keepAlive` rejects before effects.
  Root harness defaults apply only to new launches.
  Busy steer, terminal resume, arbitrary live-name takeover and explicit `agent`
  compatibility commands are unsupported in bridge mode.
- Custom `resultPath` is rejected before launch. Each launch's reserved source
  directory is explicit in its prompt. Matching Pi workers use that directory;
  configured result-discovery metadata remains in the immutable intent but the
  bridge uses reserved capture, not an arbitrary discovered path. Core validates
  captured bytes in its own `result.md`. Missing/blank/in-progress results stall;
  FAIL reports failure; BLOCKED remains blocked. None asserts independent proof.
- Artifact BLOCKED and an active terminal UI dialog are distinct. Bridged worker
  artifacts do not set Herdr's UI-blocked signal. Actual UI blocking has no safe
  typed reply route here and requires direct inspection. Credential/secret-class
  runtime replies are forbidden. Raw pane text is not used to bypass a dialog.
- `keepAlive` preserves successful panes; otherwise validated successful panes
  close through the existing driver. Kept terminal panes are for inspection;
  arbitrary terminal follow-up remains unsupported in v1.
- `bg_stop` admits cancellation before Escape. It returns `stopped:false` with
  `cancel-pending`: Escape and detached supervision do not establish terminal
  cancellation or process death. No kill escalation or recovery adoption exists.
- Runtime owns canonical events, artifact validation, exports and delivery.
  Legacy Pi-host writes/notifiers/reaping are fenced for bridged agents. Ordinary
  bg_run/watch/await and their notifications remain on the existing local paths.
- The Pi delivery consumer uses durable wait/ack and sendMessage. Reload during
  execution does not relaunch; lost ack may redeliver the same identity. Enqueue
  is not evidence of a later model turn. A frozen replay returns the prior tool
  outcome; use bg_list for current state. Output is the bounded captured transcript
  from settlement, with line/grep filtering; it is not a live terminal feed.
- A service-process restart retains ambiguous work as recovery-required. Client
  reconnect is different: the same live service retains driver observations.

## Deterministic verification

```sh
PI_DETACH_TEST_PACKAGE="$BRIDGE_DETACH" \
  node --import tsx tests/bridge/pi-detach-product.ts
npm run check
npm run typecheck
# In pi-detach, use an isolated child HOME for registry test logs:
npm test
npm run typecheck
```

The cross-package probe uses real product layers and protocol-shaped fake Herdr
responses. It also uses actual child-process death/restart. No provider is called.
The installed Herdr 0.8.2 CLI and protocol-20 schema were inspected. An actual
visible no-model worker was not launched: `agent start` supports recognized agent
kinds, not an arbitrary deterministic fixture command, and no supported fixture
integration was established in this packet. Real normal-Pi/Herdr model execution,
root wake, and live reload certification remain separate gates.
