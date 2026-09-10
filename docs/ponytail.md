# Ponytail: default working method

[Ponytail](https://github.com/DietrichGebert/ponytail) is on by default in managed
Pi sessions, including ordinary sessions without `/advisor`, parent/child advisors,
and Pi workers. Native role workers use the same core skill through their shared
worker contract. Use it throughout technical work, not as a separate ceremony.

The ladder is: understand the flow → question work that need not exist → reuse
repository code → standard library → native platform → installed dependencies →
the smallest clear implementation. Apply it to orchestration too: one capable
owner beats a graph of handoffs when the graph adds no value. It does not remove
advisor implementation authority or the single-maker fast path.

## Controls

- `/ponytail status` reports the current and configured default mode.
- `/ponytail full`, `/ponytail lite`, `/ponytail ultra`, or `/ponytail off` changes
  this Pi session's mode. Bare `/ponytail` activates the configured default (full
  when the configured default is off).
- `/ponytail default full` sets the default for future Pi sessions. Upstream
  precedence is `PONYTAIL_DEFAULT_MODE` → Ponytail config → `full`. The config is
  normally `~/.config/ponytail/config.json` (respects `XDG_CONFIG_HOME`). Existing
  explicit settings are preserved, not forcibly overwritten by installation.
- `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain`, and
  `/ponytail-help` invoke the corresponding skill once. Pi's `/skill:ponytail-*`
  forms also work. Review/audit are complexity-focused, read-only requests;
  debt inventories explicit `ponytail:` comments. They are not automatic stages.

Mode state is an upstream Pi custom entry, restored on resume/reload, not another
LLM-visible transcript message. A parent's session-local mode is **not** inherited
by a new Pi or native worker. Carry an explicit user choice in the worker packet
when needed. Native workers without Pi injection load the canonical core skill
once and follow their packet's mode choice; this is instruction-level guidance,
not a second native mode engine or a claim that Pi commands run in native CLIs.

## Compatibility, not weaker obligations

The managed adapter and role contracts explicitly resolve upstream shortcuts:

- Requested behavior, acceptance criteria, safety/security/accessibility, write
  ownership, and required evidence remain binding. A “lazy version” is an
  alternative to discuss, not permission to ship an incomplete request.
- “ONE check” is not a test ceiling. Use the repository's tooling and run all
  required checks. Three-line/code-first output advice cannot truncate required
  reports or explanations the user requested.
- Complexity-only review supplements correctness/security review and required
  independent verification; it does not replace them. A repair-capable checker
  does not become globally read-only by using Ponytail's simplicity lens.
- Do not optimize for a line count, remove necessary protections, or claim this
  repository saved the percentages in upstream benchmarks. `/ponytail-gain`
  reports upstream results on its stated tasks/models, not our measured gains.

Heavy use means applying the ladder in the current owner's decisions. It does
not mean launching more agents, replaying reviews, scanning the whole repository
on every task, or loading all six skills before delegating. Pi injects the active
core into the system prompt once per agent loop without accumulating copies in
message history. After compaction, use that injection rather than rereading the
core. Specialized skills remain progressive, decision-relevant reads.

## Installation and provenance

Ponytail 4.9.0 is pinned at `356918eba965ee1eac64bd3a7f0dd02108350de5`, tree
`3bb4226d87085db53fbf6a0013f6b5de07fcf815`, under its upstream MIT license.

- `config/settings.overlay.json` installs the official Git package but filters
  its automatic extension/skill discovery. `extensions/ponytail.ts` loads its
  unchanged Pi adapter from Pi's global Git package directory, then appends the
  compatibility rules. There is one registration, not two mode engines.
- The thin adapter sets `expandPromptTemplates: true` on upstream alias messages;
  current Pi otherwise sends their `/skill:...` text literally. Upstream owns
  commands, mode persistence, and instruction generation.
- `config/third-party-extensions.lock.json` records package provenance. All six
  skills are independently pinned in `config/skill-sources.json` and
  `config/third-party-skills.lock.json`, installed at `~/.agents/skills/` for Pi
  discovery and native access, rather than copied again from the package.
- No Ponytail CLI, MCP server, native-host hooks, extra model calls, or background
  service is required. Upstream auto-update instructions do not replace these
  managed pins; update and verify the extension and skill locks together.

Full bootstrap installs everything. For a scoped update on an existing managed
setup, install the package before reloading the managed adapter:

```sh
node scripts/meta-harness.mjs install --live
pi install git:https://github.com/DietrichGebert/ponytail@356918eba965ee1eac64bd3a7f0dd02108350de5
node scripts/meta-harness.mjs skills-plan --source DietrichGebert/ponytail
node scripts/meta-harness.mjs install-skills --live --source DietrichGebert/ponytail
node scripts/meta-harness.mjs doctor --live
```

Live commands refuse active advisors unless an intentional coordinated update
uses `--allow-active`. `--source` backs up, installs, and verifies only that
source's skills, preserving unrelated and retired skills and their generic-lock
entries; a full install still handles retirements. The installer checks selected
lock metadata, runs the skills CLI in a temporary home, and verifies all selected
installed content before publishing it. It retains a post-copy check and restores
both scoped backups if activation or lock release fails. This is not a guarantee
of crash-atomic multi-directory updates; keep the backups for manual recovery if
the process or filesystem fails during restoration. The scoped check is not a
full installation audit: run doctor afterwards. Installation never reloads Pi.
