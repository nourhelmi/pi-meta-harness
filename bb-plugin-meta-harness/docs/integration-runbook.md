# Parent-owned BB integration gate

**Do not run live steps before the designated independent High-risk review.** The builder's proofs are deterministic only. No model calls, auth changes, global BB/native installation, baseline eval or commits were performed. Public SDK harnesses are not a running BB application. Codex desktop App attachment is not certified.

## Exact public SDK surface

Pinned compile/runtime-test facade: `@get-bb/plugin-sdk@0.4.47`.

| API | Installed public declaration evidence | Use |
| --- | --- | --- |
| `defineRpcContract`, `bb.rpc.register`, `bb.settings.define` | `bundled-types/bb-plugin-sdk.d.ts` (`defineRpcContract` at 13210) | Strict browser envelope; trusted host/descriptor settings read on every call |
| `bb.hosts.experimental_client({contract})` | same declaration, 18136–18141 | One typed client for the plugin's singular host entry; explicit `hostId` on calls |
| `experimental_defineHostEntry({contract,handlers})` | `bundled-types/bb-plugin-sdk-host.d.ts`, 88–123 | Request/lifecycle AbortSignals and bounded host-only descriptor/socket IO |
| `app.slots.navPanel`, `useRpc`, `useSettings`, `useRealtimeConnectionState` | `bundled-types/bb-plugin-sdk-app.d.ts`, 352–363, 1599, 2365–2376 | Plugin-owned `/plugins/<id>/advisor` route and reconnect reconciliation |
| `createFakePluginHost`, `experimental_createHostEntryHarness`, `loadPluginApp`, `renderSlot` | public `/testing`, `/testing/host`, `/testing/app` exports | Executed deterministic public server/host/UI integration |

The host contract explicitly labels signals ephemeral and aborts requests when their worker is disposed. BB therefore owns only a socket request/poll, not the service lifecycle. We use no host background worker lease, provider bridge, thread spawning, bearer injection or realtime broadcasts. Frontend runtime imports are browser-safe; host IO never enters the app bundle. The SDK-only scan has no private dependencies/dynamic-import exemptions; `react-dom/client` is allowed solely to render the standalone deterministic browser fixture.

## Deterministic reproduction (no model, safe before live approval)

From the isolated checkout:

```sh
npm --prefix bb-plugin-meta-harness ci --ignore-scripts
npm --prefix bb-plugin-meta-harness run typecheck
npm --prefix bb-plugin-meta-harness test
npm --prefix bb-plugin-meta-harness run test:public-sdk
npm --prefix bb-plugin-meta-harness run test:browser
```

Open `http://127.0.0.1:4179/test/browser.html`. Select **work / run**, **Open workstream**. The banner says **DETERMINISTIC FIXTURE ONLY**. Reply to the maker's exact request, inspect result and identity, send a message, click **Fixture lose next response** before another message, then **Retry exact command**. Toggle **Fixture disconnect**, append progress, and **Fixture reconnect**. Check desktop and 390px/320px mobile, Tab/Shift-Tab, artifact Escape/focus restoration and reduced motion. Stop the Vite process afterward. This page does not talk to BB or a native service.

`test/runtime-host.test.ts` separately performs actual npm pack + offline installation into `native prefix with spaces`, imports the **installed package** using Node 24+'s `createRequire`, creates its actual `AdvisorRuntime` and Unix service, and runs the real plugin server and host entry through public harnesses. The injected adapter writes deterministic artifacts and emits bounded lifecycle events; it never launches a native binary/model. Assertions cover rollback/postcommit ambiguity, current CAS, exact replay, token non-disclosure, root/node replies, acknowledged Unicode/byte-bounded history, artifact traversal/symlinks, scope/epoch/wrong-run denial, disconnect-without-cancel, delivery redelivery, observed exit, and reopened SQLite history. The plugin itself has no dependency on the source checkout or the native npm package; only its bounded wire protocol is shared.

## Live prerequisites (parent/operator action)

1. Record independent-review approval and remaining **combined six-attempt** native/Claude/BB/eval budget. One client-mode root only; do not also launch a Codex CLI root for this run. Count cancelled attempts and retries that start a new task.
2. Use the actual packaged native build produced from the reviewed source. Have Node 24+, exact supported Codex CLI 0.153.4, an available model, and supported isolated authentication ready. Follow installed `docs/advisor-native.md` security rules: state outside workspace; service `CODEX_HOME` explicit/private/no config.toml; no `.codex` directory at the workspace or its ancestors; no credential copying. Claude requires SDK 0.3.263/bundled CLI 2.1.263 and its own explicit authentication. A missing credential or unsupported version is a blocker, not permission to change global settings.
3. Have a parent-approved BB instance and enrolled connected host, with the public BB CLI available. `bb` was **not on the builder's PATH**, so actual BB CLI build/install and live host compatibility were not exercised. `/Applications/BB.app/Contents/MacOS/bb` exists, but was not launched or assumed to be the standalone CLI. Use BB's supported CLI setup, not an invented private launch/bootstrap command. The following BB commands preserve the repository's existing documented public installation recipe; they are an operator action, not builder evidence.

## Launch exactly one client-mode service/root

Set canonical isolated paths and the explicit available model; paths below are placeholders to replace, not hardcoded product paths:

```sh
export PREFIX='/absolute/reviewed native prefix with spaces'
export ARTIFACTS='/absolute/reviewed artifacts'
# Build/install only into the parent-approved isolated prefix, not globally:
node scripts/pack-advisor-native.mjs "$ARTIFACTS"
npm install --prefix "$PREFIX" --ignore-scripts --omit=optional "$ARTIFACTS/nourhelmi-advisor-native-0.1.0.tgz"
export PATH="$PREFIX/node_modules/.bin:$PATH"
export STATE='/private/tmp/bb-live-A'  # new, canonical, short (socket path <=100 bytes)
export WORK='/absolute/isolated-bb-maker-workspace'
export CODEX_HOME='/absolute/isolated-adapter-auth-home'
umask 077
mkdir -p "$WORK" "$CODEX_HOME"
printf 'alpha\nbeta\n' > "$WORK/fixture.txt"
# If needed, authenticate CODEX_HOME through explicit supported login; never copy auth.
advisor-native doctor
advisor-native init "$STATE" "$WORK" codex
# Visible terminal A; keep running. No model until BB Create root:
advisor-runtime serve "$STATE/bootstrap.json"
```

Do **not** run `create-run.json` through the CLI for this flow: BB's **Create workstream** exercises admission. Do not install/launch the ordinary CLI advisor root as well. `init` registers exact `work/run/root` and `work/run/maker`; the native advisor descriptor is used only in the root's host-side MCP configuration.

In the approved BB instance:

```sh
bb plugin install path:/absolute/reviewed/bb-plugin-meta-harness --yes
bb plugin config meta-harness set hostId <enrolled-host-id>
bb plugin config meta-harness set stateRoot "$STATE"
bb plugin config meta-harness set runtimeDescriptor "$STATE/operator.json"
bb plugin reload meta-harness
```

Never paste descriptor **contents**, auth, socket token, or raw native stderr into chat, settings, artifacts or screenshots.

## Exact click/observation flow

1. Open **Advisor** (`/plugins/meta-harness/advisor`). Select **work / run**, epoch **1**, **Open workstream**. The missing-run rejection should explain creation. Enter WORK, Codex CLI, **Create workstream**. Observe accepted receipt and run revision.
2. Set adapter Codex CLI, the operator's available explicit model and `high` effort. First message:

   > Use the runtime MCP tools to admit and launch exactly one maker node `maker` in this work/run. Inspect only WORK/fixture.txt and report its line count with evidence in the native result artifact. Use role builder, high risk, the selected available model and high effort; acceptance is an evidence-backed line count and a readable result. Ask one non-secret question if your supported host exposes it; never invent a question event. Do not use native nested agents, another root, shell/network approval expansion or any credentials. Wait for the maker, inspect its actual result, and synthesize the outcome. Do not assert verification from PASS prose alone.

   Replace WORK/model in the prompt explicitly. Click **Create root once**. Start the attempt clock (180s/session; max six conversation submissions; no automatic relaunch).
3. Observe root text/progress and maker identity/attempt/revision in **Fleet**. The root normally admits/launches the packet using the same service. To test manual controls instead, tell the root *not to launch* and deliberately use **Admit a maker packet → Launch maker**; never do both. Check one node.launched in the canonical trace.
4. If a real question is emitted, inspect **request.json**, select/type the answer under **Needs your reply**, and **Send reply to maker/root**. Check exact request ID, attempt and current revision. A reply to a worker advances attempt. If the actual native mode cannot expose questions, record that specific capability gap rather than presenting fixture data as live proof. Deny unsupported expanded permissions; Claude one-shot file approval must match the inspected path/input hash.
5. **Open result maker** and **Inspect identity maker/root**. Record requested versus observed model/effort/session independently. Read root synthesis. Do not call formatting a verified acceptance attestation.
6. **Acknowledge** inspected deliveries. Close only the BB client/panel or disconnect its connection while the service stays alive. Reopen, select the same scope and **Reconnect and resync**. Previously acknowledged history must remain; unacked deliveries must redeliver. No new root/maker is created. For a naturally lost mutation response, use **Retry exact command**; verify same ID/body, replayed receipt and one effect. Do not manufacture a second live task to test a UI failure already proven deterministically.
7. **Request stored resume** should show `RESUME_UNSUPPORTED`, not silently create a new conversation. Keep the same live service for reconnect.
8. After root idle, **Stop idle root**; inspect observed process exit separately from receipt. A meaningful cancellation probe generally needs a **second counted attempt with a new bootstrap state** because a completed maker cannot be relaunched/resumed. During that attempt use **Cancel maker** while active/blocked and **Cancel root turn** if running, then observe finalization/exit before **Stop idle root**. Use the same configured new authority deliberately; do not switch descriptors while any previous command is uncertain.
9. Open **Advisor traces** (`/plugins/meta-harness/trace`) and verify the original viewer still shows the generated canonical run/wave/attempt/cancel state. Acknowledge remaining deliveries. Only then request service shutdown in terminal A; typed refusal means inspect active work, not delete the SQLite/lock.

## Evidence and limits to record

Record exact BB/SDK/Node/native CLI/SDK versions; content and tarball hashes; one service/run/root/node identity; commands/receipts/attempt count; root stream, exact request/reply, result/identity, cancellation acceptance versus native terminal/exit, acknowledged/unacked reconnect history, trace and screenshots, available time/turn/usage observations. Never infer usage/cost or an observed model from requested fields.

Current builder evidence proves deterministic readiness on this macOS host only. Public SDK methods are experimental where named; actual installed BB host transport and native model behavior remain the parent's live gate. Service-restart recovery is not stored-session resume; unresolved effects become recovery-required, never blind replay. Session-storage exact retry survives reload in the same tab, not cleared storage/new devices. The same-UID local trust boundary and native sandbox read-isolation limits in `docs/advisor-native.md` remain in force.
