# Notices

Pi Meta Harness is first-party source by Nour Helmi and is available under the MIT license in [`LICENSE`](LICENSE).

Third-party Pi packages and Agent Skills are not vendored. Their package names, upstream repositories, versions, revisions, and content hashes are installation metadata. Each upstream project keeps its own license.

Exceptions and selected components:

- `extensions/unified-edit.ts` is a reviewed snapshot from `mitsuhiko/agent-stuff` at the revision recorded in `config/third-party-extensions.lock.json`. It is licensed under Apache-2.0; see `third-party/licenses/agent-stuff-Apache-2.0.txt`.
- `pi-detach` is separate first-party MIT source and is installed from the exact public Git commit in `config/settings.overlay.json`.
- `pi-ui-pack`, `pi-skill-tags`, `@ogulcancelik/pi-codex-compaction`, and `pi-mermaid` are installed from the exact sources recorded in `config/third-party-extensions.lock.json`. They retain their upstream MIT licenses.
