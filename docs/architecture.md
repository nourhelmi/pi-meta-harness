# 🏗️ Architecture

The harness separates **portable source** (this repository), **installed
configuration** (managed files under `~/.pi` and `~/.config/herdr`), and
**local runtime state** (never in Git).

```mermaid
---
config:
  theme: dark
  flowchart:
    curve: basis
---
flowchart LR
  subgraph src ["📦 Portable source — public Git"]
    R["pi-meta-harness"]
    D["pi-detach\n@ pinned commit"]
    U["managed\nPi package sources"]
    K["selected\nupstream skills"]
    H["herdr/ config"]
  end

  subgraph inst ["⚙️ Installers"]
    I["managed installer"]
    P["Pi package installer"]
    S["compatible skills CLI"]
  end

  subgraph machine ["💻 Installed configuration"]
    C["~/.pi/agent"]
    HC["~/.config/herdr"]
  end

  R --> I --> C
  D --> P
  U --> P --> C
  K --> S --> C
  H --> HC
  C --> X["🔒 Local credentials, sessions,\nand runtime state — never in Git"]
  HC --> X

  classDef srcN fill:#16213e,stroke:#533483,color:#eee
  classDef instN fill:#533483,stroke:#e94560,color:#fff
  classDef machN fill:#0f3460,stroke:#16c79a,color:#e8fff7
  classDef privN fill:#1a1a2e,stroke:#f0a500,color:#ffeaa7
  class R,D,U,K,H srcN
  class I,P,S instN
  class C,HC machN
  class X privN
```

## 🧱 Ownership boundaries

**The harness owns:**

- first-party advisor extensions and skills;
- fixed `bg_agent` semantic role contracts and portable skill paths;
- named advisor intelligence guides and the separate live guide they
  materialize (see [`intelligence-profiles.md`](intelligence-profiles.md));
- safe Pi and MCP overlays;
- compatible npm package ranges or full Git commits;
- Herdr presentation and notification configuration;
- install, restore, test, and doctor logic.

**Everything else stays with its owner:** Pi owns package installation and
provider login; Herdr owns and regenerates its Pi integration; upstream skill
repositories own third-party skill source.

## ⚙️ Install behavior

The installer copies first-party files, deep-merges safe MCP settings, and
merges package settings by package identity. A new range or commit replaces an
old source for the same package without deleting unrelated user packages.

`bg-agent-profiles.json` is installed as fixed, generic semantic role
configuration. Named guides are refreshed under `intelligence-profiles/`, while
the existing `ACTIVE` selection is preserved and rematerialized as
`advisor-intelligence.json`. Switching a guide never rewrites role transport.

Before each mutation, the installer creates a scoped backup. It does not reload
Pi, migrate an active session, or copy authentication.

`pi-detach` is not vendored. The settings overlay points to its public
repository at one full reviewed commit. That transport accepts legacy
intelligence fields but ignores them; this harness supplies standalone
role-only configuration.

## 🪟 Herdr session topology

`advisor_launch` is the canonical boundary for a separate advisor: it creates
an unfocused Herdr tab at the requested cwd, labels the root pane
`advisor · <purpose>`, starts Pi, and submits the advisor bootstrap. It never
falls back to splitting the caller's tab. `advisor_session_init` also restores
that root-pane label from workstream words.

Configured `bg_agent` workers follow the opposite rule: they stay visible as
panes in their owning advisor tab. Their labels are concise `role · <purpose>`
values; run IDs remain in agent identities and notifications rather than pane
titles. Each advisor persists one authoritative worker harness mode;
conflicting per-launch overrides are rejected. Pi mode starts Pi workers;
native mode maps the profile-selected OpenAI identity to Codex CLI or Anthropic
identity to Claude Code. Root advisors remain Pi. Native result artifacts are
reserved before launch and validated before close-on-settle; missing or
malformed results keep the worker pane visible for repair.

## 🔄 Resumed advisor doctrine

Pi preserves expanded skill text in session history, so `/reload` cannot
rewrite an old advisor snapshot. When an initialized advisor resumes,
`advisor-session.ts` compares that snapshot with the installed advisor skill.
If it is stale or absent, the extension adds the current installed doctrine to
the system prompt and marks the historical snapshot as archival. Current
snapshots are not duplicated.

## 📌 Reproducibility boundary

First-party files are exact, npm packages follow compatible caret ranges, and
Git packages use full commits. Each third-party skill group records a full
source commit and Git tree. The installer fetches that commit directly,
verifies both IDs, copies the selected skills, and then verifies each installed
folder against its SHA-256 lock.

Host package managers remain an update boundary: Homebrew resolves current
compatible Herdr and Engram builds, while the live doctor enforces the
supported minimums. Pi and agent-browser use compatible npm ranges and live
minimum-version checks.

Unit tests enforce full 40-hex Git package pins without network access. Run
`node scripts/meta-harness.mjs verify-git-pins` as an explicit publication or
cutover preflight to fetch each exact commit with a per-pin timeout. Keeping
the network check opt-in preserves deterministic offline tests.
