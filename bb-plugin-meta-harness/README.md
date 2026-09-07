# BB Advisor

Public BB conversation/fleet client for the **same** standalone durable advisor runtime, plus the existing canonical trace viewer. No BB thread/provider bootstrap, second root, scheduler, SQLite writer, or model credentials in the plugin.

## Configure

The native service must already be running on the selected enrolled BB host. Follow the installed `@nourhelmi/advisor-native` documentation to bootstrap exact scopes and an operator descriptor. Node **24+** runs that separate service; the plugin's public host transport itself needs only the BB-supported Node version. Native state must be outside the writable workspace.

Using the supported BB CLI (these commands change the selected BB installation; the verification builder does not execute them):

```sh
bb plugin install path:/absolute/path/to/bb-plugin-meta-harness --yes
bb plugin config meta-harness set hostId <connected-host-id>
bb plugin config meta-harness set stateRoot /canonical/private/advisor-state
bb plugin config meta-harness set runtimeDescriptor /canonical/private/advisor-state/operator.json
bb plugin reload meta-harness
```

`runtimeDescriptor` is a **path**, never JSON or a bearer token. Only the host entry opens it. Use a canonical absolute path (on macOS, `/private/tmp`, not the `/tmp` symlink). The file must be a same-user private regular file; its Unix socket must be mode 0600 in a canonical mode-0700 directory. No command can override the selected host, descriptor, principal or service address.

Open `/plugins/meta-harness/advisor` (or the **Advisor** navigation panel). Choose an advertised workstream/run and owner epoch, then **Open workstream**. An authorized but absent run can be created using **Create workstream** and an allowed workspace. Creation cannot invent grants: adding a workstream/run/node requires trusted operator registration first.

- **Create root** creates one runtime-owned conversation using an explicitly selected adapter/model/effort and first message. The native service must have its advisor MCP registration configured. BB never calls `threads.spawn`.
- Send messages, inspect streamed progress, reply to exact durable requests, and inspect bounded `request.json`, `result.md`, and `native.json` artifacts. Request IDs, attempts and revisions are visible. Native questions have choice/custom-answer forms; known permission requests offer only the adapter's exact vocabulary. Codex grants are deny-only; Claude Write/Edit may allow the exact file input once. Unknown permission shapes cannot be approved. Credentials belong in host login, never in the transcript.
- **Admit a maker packet**, then **Launch maker**, use the same transaction/outbox as the root's MCP tools. If the root already launched it, the runtime rejects duplicate reservation. Graph execution remains runtime/root-owned; direct launch does not create a hidden graph.
- **Cancel maker** / **Cancel root turn** request cancellation. Acceptance, finalization, process-exit observation and delivery acknowledgment are different facts. **Stop idle root** is available only when idle; no plugin shutdown cancels work.
- **Reconnect and resync** reads durable snapshot/history/unacked delivery rows. Polling is explicit (1.5 seconds), not an unsolicited model wake. **Acknowledge** records receipt; it never deletes history. The view retains at most 256 entries; history pages are 64 rows / 256 KiB, and artifacts are at most 64 KiB. Load subsequent pages or use the scoped CLI for larger histories/artifacts.
- A transport failure may follow a committed mutation. **Retry exact command** retains its original ID, body, revision and scope, including across reload in the same browser tab. Only that pending command is held in versioned session storage; the transcript is always reconstructed from SQLite. Do not clear browser storage or change runtime authority while uncertain. After a *definite* stale rejection, inspect refreshed state and deliberately resubmit with a new ID. Old registrations must explicitly add `history`; there is no inferred grant or legacy-history fallback.
- Stored-session resume is explicitly unsupported by current native adapters. **Request stored resume** shows the typed rejection. Reconnect to the same live service instead; never restart a service to hide ambiguous effects.

## Trace viewer remains separate

`/plugins/meta-harness/trace` reads direct `<stateRoot>/traces/<runId>.jsonl` files through the original realpath/descriptor policy. Refresh, settings changes and reconnect reconstruct canonical v1 protocol-revision-1.1 projections. It does not open trace-derived result paths or become the runtime writer. Existing graph/wave/attempt/reply/cancel metadata and advisory result validation stay intact.

## Deterministic verification

Run with Node 24+ for the SQLite integration tests:

```sh
npm --prefix bb-plugin-meta-harness ci --ignore-scripts
npm --prefix bb-plugin-meta-harness run typecheck
npm --prefix bb-plugin-meta-harness test
npm --prefix bb-plugin-meta-harness run test:public-sdk
```

`test/runtime-host.test.ts` packs and actually npm-installs `@nourhelmi/advisor-native` offline into a temporary prefix containing spaces. Public BB server/host harnesses connect to that installed package's private Unix service and real SQLite, injecting a **no-model adapter**. Tests prove scope/epoch/path/receipt gates, transaction rollback/postcommit ambiguity, exact replay, bounded acknowledged history, both sides of conversation, process/cancel distinction, disconnect and persisted reopen. Test packaging requires the containing source checkout and npm's cached optional-package metadata; the production plugin has **no repository-relative imports or native package dependency**. Its version-1 bounded socket client duplicates transport only, never admission/store/scheduling.

UI tests use public SDK app/RPC mocks and do not prove native execution. Canonical conformance tests compare package-local schema/projector against the containing reference repository (`ADVISOR_META_ROOT` can override it).

For a standalone browser-only fixture:

```sh
npm --prefix bb-plugin-meta-harness run test:browser
# Open http://127.0.0.1:4179/test/browser.html
```

The visibly labeled fixture uses the production conversation component with synthetic RPC data. It cannot call a native model or BB host. See [the parent integration runbook](docs/integration-runbook.md) for the distinct live gate and exact click flow.
