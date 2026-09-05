# bb-plugin-meta-harness

Read-only BB panel for canonical Advisor Core v1 traces. The plugin reads only
direct `<stateRoot>/traces/<runId>.jsonl` files through its host entry. BB is a
projection; it does not read result artifacts, watch files, invoke workers, or
write advisor state.

## Configure

```sh
bb plugin install path:/absolute/path/to/bb-plugin-meta-harness --yes
bb plugin config meta-harness set hostId <connected-host-id>
bb plugin config meta-harness set stateRoot /absolute/advisor/state/root
bb plugin reload meta-harness
```

Open `/plugins/meta-harness/trace`. The panel fetches on mount, explicit
Refresh, settings changes, and reconnect after a previously established
connection. A reload or host restart reconstructs the view from trace files;
there is no watcher or cached canonical state.

## Verify

Release evidence uses Node `v24.18.0` (pinned in `.nvmrc`) and
`@get-bb/plugin-sdk@0.4.47`.

```sh
npm install --include=dev
npm run typecheck
npm test
npm run test:public-sdk
ADVISOR_META_ROOT=/absolute/path/to/pi-meta-harness npm run test:conformance
```
