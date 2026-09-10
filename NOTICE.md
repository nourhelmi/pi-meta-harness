# Notices

Pi Meta Harness is first-party source by Nour Helmi and is available under the MIT license in [`LICENSE`](LICENSE).

Except for the explicitly listed snapshots below, third-party packages and skills retain their own installation metadata and licenses.

Exceptions and selected components:

- `third-party/gentle-engram/` is the unchanged gentle-engram 0.1.12 Pi adapter (Gentleman Programming, MIT). `extensions/advisor-memory.ts` composes its public Pi hooks to select the managed checkpoint protocol instead of a duplicate diary; ordinary sessions keep upstream behavior. Snapshot hashes are in `third-party/gentle-engram/SNAPSHOT.json`.
- `extensions/unified-edit-fallback/upstream.ts` is a reviewed fallback snapshot from `mitsuhiko/agent-stuff` at the revision recorded in `config/third-party-extensions.lock.json`. It is licensed under Apache-2.0; see `third-party/licenses/agent-stuff-Apache-2.0.txt`.
- Ponytail is installed at the exact Git revision recorded in `config/third-party-extensions.lock.json`, with six canonical skills pinned in the skill locks. Its unchanged official Pi adapter is loaded by the first-party `extensions/ponytail.ts` compatibility adapter. Ponytail retains DietrichGebert's upstream MIT license.
- `pi-better-edit` is the compatible-range primary hash-anchored read/edit/undo package recorded in `config/third-party-extensions.lock.json` and retains its upstream MIT license.
- `pi-claude-agent-sdk` is the compatible-range Claude Code subscription bridge recorded in `config/third-party-extensions.lock.json` and retains its upstream MIT license.
- `pi-detach` is separate first-party MIT source and is installed from the exact public Git commit in `config/settings.overlay.json`.
- `pi-ui-pack` and `pi-skill-tags` use the exact Git commits recorded in `config/third-party-extensions.lock.json`; `@ogulcancelik/pi-codex-compaction` and `pi-mermaid` use the recorded compatible npm ranges. They retain their upstream MIT licenses.
