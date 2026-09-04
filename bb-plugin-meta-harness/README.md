# BB Meta Harness adapter PoC

Private, additive BB transport and projection for the existing Meta Harness and pi-detach contracts.

Meta Harness remains authoritative for workstreams, advisor sessions, roles, graphs, waves, dependency order, and worktree isolation. pi-detach remains authoritative for run IDs, logs, reserved result artifacts, validation, settlement, same-run continuation, durable run projection, and settlement generations. BB owns only visible unparented thread transport, additive presentation, reconstructible correlation, lifecycle invalidation, and ordinary wake delivery after pi-detach authorization.

The plugin SQLite database stores only reconstructible run/thread correlation, private launch admission identifiers and hashes, role state, initialization state, and wake admission. A worker launch reserves an immutable request before using BB's authenticated private thread-initialization API. BB core injects the plugin/thread/input/generation identity; the resolver validates the exact host, project, provider, model, reasoning, worktree, visibility, and unparented topology before releasing role state. The prompt remains the user's literal task. No bearer or private role state enters a prompt, model capture, or ordinary provider channel.

The Pi worker extension consumes the role state from the process-local private initialization registry before the first input. Missing capability, missing consumer, identity drift, duplicate generation, or an ambiguous transport boundary fails closed. Ambiguous delivery is retained as `unknown`; the same generation is never replayed and no exactly-once claim is made.

Wake admission uses `pending`, `claimed`, `sent`, or `unknown`. `unknown` requires an explicit operator retry or skip. A skipped admission stays visibly `unknown`; it is never mislabeled `sent`. This PoC claims one ordinary wake on the validated common path, not literal crash-safe exactly-once delivery.

## Pinned runtime

- Node `v24.18.0` for every release gate and wrapper child.
- Pi `0.84.4`.
- BB `0.41.0` at `99c0ad71841ff6ff2d42b3f7864b6dba0b0f7337`.
- upstream proof Plugin SDK private-initialization surface based on `0.4.40`.
- no `@bb/*`, BB core fork, BB Harness/Advisor, Herdr, routines, intercom, or community workflow dependency.

The normal Pi profile contains exactly the three Meta Harness extensions plus pi-detach, with `packages: []`. Pinned BB always supplies its `update_environment_directory` dynamic tool; the wrapper accepts only that exact definition and strips its scratch-file handle before Pi model input so a fixed-worktree worker cannot relocate itself. Every collision or other dynamic tool fails closed. The wrapper recognizes provider-Pi's exact singleton `--version` maintenance probe from the pinned Pi package manifest, then permits only catalog or normal RPC argv. It also rejects project `.pi` discovery, profile extensions, profile drift, additional Pi skills, unsupported argv, noncanonical roots, session escapes, and any runtime/version mismatch. Catalog children alone receive one appended `--no-extensions`, a fresh isolated HOME/Pi/XDG/TMP/workspace, and mode-0600 snapshots of only the curated profile's auth and model cache; the entire catalog root is removed when the child exits.

## One-time local setup

The provider-Pi declaration passes only `BB_PI_BRIDGE_COMMAND` and `BB_PI_BRIDGE_ARGS` into its bridge process. The setup script therefore encodes non-secret canonical roots, host identity, and the verified Pi `0.84.4` entrypoint into the versioned static wrapper argument; extra environment variables and the daemon's ambient `PATH` are not trusted across that boundary.

Start in a shell pinned to Node 24.18.0:

```sh
export PATH=/Users/nour/.nvm/versions/node/v24.18.0/bin:$PATH
node --version
cd /Users/nour/Dev/pi-meta-harness-worktrees/bb-adapter-poc/bb-plugin-meta-harness
npm ci
eval "$(npm run --silent setup:print-env -- --host-id '<connected-bb-host-id>' --bb-skill-root '<canonical-bb-global-skills-root>')"
```

Run that `eval` before starting the BB dev server and host daemon. By default it creates the external curated profile at `~/.bb/meta-harness-pi`, uses provider-Pi's fixed public session root `~/.bb/pi-bridge-sessions`, allows only the two maker worktrees, and configures these canonical state roots:

- `/Users/nour/.advisor/pi-meta-harness-0c8d98ab`
- `~/.pi/detach`

Repeat `--allow-root /absolute/canonical/worktree` for a different explicitly trusted maker root. `--profile-root`, `--advisor-state-root`, and `--detach-state-root` are also available. Symlinks, relative paths, traversal, and unknown flags fail closed.

Repeat `--bb-skill-root` for each exact canonical root supplied by pinned BB's `skills/configure` handshake. This permits the normal provider argv without turning `--skill` into an arbitrary-path escape; a missing, extra, duplicate, or changed root fails closed. The option is intentionally empty by default.

The setup script does not copy credentials. Before a live model turn, seed the isolated profile's `auth.json` (and `models.json` or `models-store.json` only when your Pi provider setup requires it) as regular mode-0600 files. Never commit them. For example, after reviewing the source and destination:

```sh
install -m 600 /Users/nour/.pi/agent/auth.json /Users/nour/.bb/meta-harness-pi/auth.json
```

## Build and install

From `/private/tmp/get-bb-research`, with the setup exports present and Node 24 first on PATH:

```sh
pnpm bb:dev plugin build /Users/nour/Dev/pi-meta-harness-worktrees/bb-adapter-poc/bb-plugin-meta-harness
pnpm bb:dev plugin install path:/Users/nour/Dev/pi-meta-harness-worktrees/bb-adapter-poc/bb-plugin-meta-harness --yes
pnpm bb:dev plugin list
pnpm bb:dev plugin reload meta-harness
pnpm bb:dev plugin logs meta-harness
```

The plugin adds one stable `navPanel`; it does not replace BB's thread list or sidebar. The panel refetches canonical graph/run/artifact state on initial render, realtime invalidation, websocket reconnect, and host-worker restart. It also exposes launch reservations so an unbound `reserved`, `failed`, or `unknown` launch is diagnosable without another spawn. Open, stop, message, typed `BB-POC-CONTINUE`, and explicit ambiguous-wake controls use public SDK/RPC paths.

## Deterministic verification

```sh
export PATH=/Users/nour/.nvm/versions/node/v24.18.0/bin:$PATH
node --version
npm run typecheck
npm test
npm run check:public-sdk
npm run test:wrapper
npm run build
```

`test:wrapper` is the committed 19-assertion lane: two harmless real Pi RPC children, five exit-64 rejects before Pi, catalog-only `--no-extensions`, isolated catalog identity/roots, exact normal provider argv pass-through, exact curated public-tool ownership, and fd3/fd4 round trip.

## PoC boundaries

Only configured Pi role launches are supported under BB. Native harnesses, explicit agent commands, `minimal` reasoning, tool filters, unexpected profile CLI arguments, and uncurated dynamic tools fail closed. All workers are distinct visible BB roots with `originKind: null` and no `parentThreadId`; logical parentage exists only in immutable Meta Harness graph/correlation data. BLOCKED is nonterminal, accepts only the typed token through the adapter control, and resumes the same pi-detach run and BB thread. BB lifecycle events only invalidate projections; they never settle a run.
