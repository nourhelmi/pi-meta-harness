# Notices

Pi Meta Harness is first-party source by Nour Helmi and is available under the MIT license in [`LICENSE`](LICENSE).

Third-party Pi packages and Agent Skills are not vendored. Their package names, upstream repositories, versions, revisions, and content hashes are installation metadata. Each upstream project keeps its own license.

Exceptions and selected components:

- `extensions/unified-edit-fallback/upstream.ts` is a reviewed fallback snapshot from `mitsuhiko/agent-stuff` at the revision recorded in `config/third-party-extensions.lock.json`. It is licensed under Apache-2.0; see `third-party/licenses/agent-stuff-Apache-2.0.txt`.
- `pi-better-edit` is the compatible-range primary hash-anchored read/edit/undo package recorded in `config/third-party-extensions.lock.json` and retains its upstream MIT license.
- `pi-detach` is separate first-party MIT source and is installed from the exact public Git commit in `config/settings.overlay.json`.
- `pi-ui-pack` and `pi-skill-tags` use the exact Git commits recorded in `config/third-party-extensions.lock.json`; `@ogulcancelik/pi-codex-compaction` and `pi-mermaid` use the recorded compatible npm ranges. They retain their upstream MIT licenses.
