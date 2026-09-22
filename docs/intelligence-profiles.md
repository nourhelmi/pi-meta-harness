# 🧠 Advisor intelligence profiles — deep dive

Named JSON profiles guide which models and reasoning levels an advisor should
prefer for each worker role. They do **not** configure `pi-detach`, constrain
worker identity, or poll Codex weekly, Anthropic 5-hour, or Cursor spend.

The split is deliberate:

- `bg-agent-profiles.json` is fixed semantic role configuration: instructed
  skill and portable skill path, anchors, and instructional cycle caps.
- `advisor-intelligence.json` is the live advisor-owned guide: model character,
  default reasoning guidance, and ordered role recommendations.

Recommendations are advisory, not exhaustive or enforceable. An advisor chooses
the best model and reasoning for the task from or outside the guide, balancing
fit, capability, cost, quota, and availability. An outside-guide choice needs a
concise rationale only when material and never permission merely for being
unlisted. Workers accept outside-guide and changed identities while recording
launch/current identity for audit.

Shipped default: **`codex-max`**. Reinstall refreshes fixed roles and all named
guides but preserves the name in `intelligence-profiles/ACTIVE`.

## ⚡ Daily commands

`/advisor` is a skill invoke, not a CLI with profile flags:

```text
/advisor

my task here
```

Pick the guide before workers launch:

```bash
node "$HOME/.pi/agent/bin/intelligence-profile.mjs" --list
node "$HOME/.pi/agent/bin/intelligence-profile.mjs" grok-cycle
```

Names: `codex-max` | `codex-lean` | `anthropic-heavy` | `balanced` | `grok-cycle`.

Choose worker transport separately. `/advisor` asks once and persists the answer;
`/skill:advisor-pi` and `/skill:advisor-native` select it directly. The active
guide still chooses model and reasoning in either mode. Pi mode forwards that
identity to Pi. Native mode maps OpenAI providers to Codex CLI and Anthropic
providers to Claude Code while retaining the same three semantic roles and skills.
Cursor/Grok recommendations are not directly routable in native mode, so the
advisor uses a task-fit OpenAI/Anthropic alternative from the same guide or
reports the mismatch.

The switcher validates the fixed role names and all guide references, copies the
selected named guide to `~/.pi/agent/advisor-intelligence.json`, writes `ACTIVE`,
and reports each role's preferred choice. It never writes
`bg-agent-profiles.json`. Already-running workers and this Pi session's `/model`
remain unchanged.

## 📐 Guide schema

Each named file uses this shape:

```json
{
  "name": "codex-max",
  "models": {
    "provider/model": {
      "character": "Advisory task-fit and capacity guidance.",
      "defaultThinking": "high"
    }
  },
  "recommendations": {
    "builder": [
      {
        "model": "provider/model",
        "thinking": "high",
        "fit": "Preferred implementation choice in this profile."
      }
    ]
  }
}
```

Recommendation order is preference order. Validation catches malformed
reasoning names, missing models, missing configured roles, and misspelled role
references. This validates the guide itself; it does not turn the guide into a
runtime allowlist.

## 🔀 Decision-bearing builders and locked executors

Recommendation order applies **among choices that fit the task**; it is not a
rule to spend the first model on every node. Builder routing starts with decision
load and risk:

- use the profile's strong builder when diagnosis, architecture, or a material
  product/schema/migration/auth/security/destructive-operation decision remains;
- use the profile's locked-packet executor when a concise execution packet has fixed
  the approach, bounded the surface, named existing patterns and non-goals, and
  provided deterministic anchors;
- if the locked-packet executor discovers a missing material decision or contradictory
  evidence, it stops and escalates rather than inventing a route.

The shipped locked-packet executors are:

| Profile | Executor |
| --- | --- |
| `codex-max` | GPT-6 Sol high |
| `codex-lean` | GPT-6 Sol xhigh |
| `balanced` | GPT-6 Sol high |
| `anthropic-heavy` | Opus 5.5 medium |
| `grok-cycle` | Opus 5.5 medium |

This is advisory task-fit guidance, not a model allowlist or a deterministic
small-file rule. A locked-packet maker does not automatically earn another checker;
review tier follows the product risk and deterministic anchors remain the backstop.

## 🧩 Topology

```mermaid
---
config:
  theme: dark
---
flowchart TB
  Named["intelligence-profiles/*.json"] --> Switcher["intelligence-profile.mjs"]
  Switcher --> Active["ACTIVE"]
  Switcher --> Guide["advisor-intelligence.json"]
  Guide -.->|recommended model + thinking| Advisor[advisor]
  Roles["fixed bg-agent-profiles.json"] -->|role skill + caps + anchor| Transport[bg_agent / pi-detach]
  Mode["advisor worker mode\npi or native"] --> Transport
  Advisor -->|chosen identity + role| Transport
  Transport --> Worker[worker pane]

  classDef cfg fill:#1a1a2e,stroke:#f0a500,color:#ffeaa7
  classDef adv fill:#533483,stroke:#e94560,color:#fff
  classDef tr fill:#0f3460,stroke:#16c79a,color:#e8fff7
  class Named,Active,Guide,Roles,Mode cfg
  class Switcher,Advisor adv
  class Transport,Worker tr
```

## 🌳 Which guide to pick

```mermaid
---
config:
  theme: dark
---
flowchart TD
  Start[Quota check you decide] --> CodexQ{Codex weekly healthy?}
  CodexQ -->|yes| UseCM[codex-max]
  CodexQ -->|dying leftover usable| UseCL[codex-lean]
  CodexQ -->|Opus 5.5 advises, GPT-6 Sol builds and checks| UseBA[balanced]
  CodexQ -->|dead| AnthQ{Spend Anthropic as workhorse?}
  AnthQ -->|yes| UseAH[anthropic-heavy]
  AnthQ -->|no| UseGC[grok-cycle]

  classDef q fill:#533483,stroke:#e94560,color:#fff
  classDef pick fill:#0f3460,stroke:#16c79a,color:#e8fff7
  class Start,CodexQ,AnthQ q
  class UseCM,UseCL,UseBA,UseAH,UseGC pick
```

- **healthy Codex** → `codex-max`
- **Codex leftover** → `codex-lean`
- **Codex dead and Anthropic should implement** → `anthropic-heavy`
- **Opus 5.5 advice/greenfield UX plus GPT-6 Sol builds/checks** → `balanced`
- **Codex dead and Grok owns maker/review** → `grok-cycle`

The shipped guides recommend Cursor only as `cursor/grok-4.6`; that is guidance,
not transport enforcement.

## 🃏 Profile cards

The tables summarize preferred order. The JSON `character` and `fit` fields hold
the detailed task and capacity guidance. The shipped roles are advisor, builder,
checker. Advisors own planning and synthesis; all three investigate, implement or
repair, and verify within their assignment. Browser verification belongs to the
author of the affected behavior, not a separate role or stage. Choose economical
models for genuinely narrow work, without commissioning another agent just to
collect evidence. Extra review resolves named uncertainty or a project/user
requirement. A different model is not required for independence; a nonauthor
assessment is. Required agentic PR review belongs to the project's review workflow.

### `codex-max` — healthy Codex

| Role | Ordered recommendations |
| --- | --- |
| advisor | GPT-6 Sol xhigh (root session and child advisor) |
| builder | GPT-6 Sol xhigh (all decision-bearing work), GPT-6 Sol high (locked packet), Grok high |
| checker | GPT-6 Sol xhigh, GPT-6 Sol high |

GPT-6 Sol owns advisor planning and synthesis and primary decision-bearing builds at
xhigh, including substantial implementation and every kind of UX work.
Greenfield and existing UX both load `frontend-design`. GPT-6 Sol xhigh handles
fresh-context review, including adversarial checks; GPT-6 Sol high handles routine
checks and locked execution packets. GPT-6 Luna max remains an optional economical model
for explicitly assigned browser-heavy builder/checker work, not a default handoff.
Grok stays as the capacity alternate for bounded backend work. This profile
recommends no Anthropic model. Lower total task cost is a hypothesis, not a measured
guarantee. Changing the guide does not change an already-running advisor's reasoning
level or a worker's launch identity.

### `codex-lean` — Codex-only, effort-lean

| Role | Ordered recommendations |
| --- | --- |
| advisor | GPT-6 Sol high (root session and child advisor) |
| builder | GPT-6 Sol xhigh; GPT-6 Sol max (ambiguous or wide breadth) |
| checker | GPT-6 Sol xhigh |

GPT-6 Sol runs at high for advisor planning and synthesis, xhigh as the regular
builder, locked-packet executor, and checker, and max for materially ambiguous or
wide-breadth implementation. GPT-6 Luna max remains an optional model for explicitly
assigned browser-heavy work. Every mapped model is an OpenAI Codex model; the guide
remains advisory rather than a runtime allowlist.

### `anthropic-heavy` — spend the 5-hour window deliberately

| Role | Ordered recommendations |
| --- | --- |
| advisor | Opus 5.5 high |
| builder | Opus 5.5 medium (locked/procedural), Opus 5.5 high (greenfield UX) |
| checker | Opus 5.5 medium |

Opus 5.5 medium is the default implementation and review workhorse, including locked
execution packets. Opus 5.5 high owns advisor planning and synthesis and greenfield UX.
This profile recommends only Opus 5.5.

### `balanced` — Opus 5.5 advises; GPT-6 Sol builds and checks

| Role | Ordered recommendations |
| --- | --- |
| advisor | Opus 5.5 high |
| builder | GPT-6 Sol high, Opus 5.5 high (greenfield UX) |
| checker | GPT-6 Sol xhigh |

GPT-6 Sol high is the default maker and locked-packet executor; GPT-6 Sol xhigh owns
fresh-context review. Opus 5.5 high owns advisor planning and synthesis and greenfield
UX. Other models are absent from the profile recommendations but are not blocked at
runtime.

### `grok-cycle` — no Codex recommendations

| Role | Ordered recommendations |
| --- | --- |
| advisor | Opus 5.5 high (root session); Grok high, Opus 5.5 medium (child) |
| builder | Grok high, Opus 5.5 medium (locked packet) |
| checker | Grok high, Opus 5.5 medium |

Grok is preferred for decision-bearing implementation and review, and is the root
advisor fallback when Opus 5.5 reaches capacity. Opus 5.5 medium handles locked
execution packets, procedural work, and native-harness assignments without a Cursor
route. When risk warrants independent review of a Grok build, use a fresh nonauthor
assessment and preserve deterministic evidence.

## 📁 Files on disk

| Path | Role |
| --- | --- |
| `config/bg-agent-profiles.json` | Fixed semantic role configuration and portable skill paths |
| `config/intelligence-profiles/<name>.json` | Named advisor guidance in this repository |
| `scripts/intelligence-profile.mjs` | Guide validator, status command, and switcher |
| `~/.pi/agent/bg-agent-profiles.json` | Installed fixed role configuration |
| `~/.pi/agent/intelligence-profiles/` | Installed named guides plus `ACTIVE` |
| `~/.pi/agent/advisor-intelligence.json` | Live copy of the selected guide |

Doctor verifies fixed role shape, validates every named guide against configured
role names, and requires `ACTIVE` to be present, nonempty, known, and
byte-equivalent to the live guide. Missing pointers, stale pointer/live pairs,
and interrupted switches fail precisely. Reinstall performs the same preflight
before creating a backup or replacing files, so it never silently chooses one
side of a mismatch.

Repair selection drift explicitly with:

```bash
node "$HOME/.pi/agent/bin/intelligence-profile.mjs" <intended-name>
node scripts/meta-harness.mjs doctor --live
```

A clean install selects `codex-max`; a legacy mixed configuration may migrate a
known `ACTIVE` name when no split live guide exists. Doctor does not inspect or
reject an advisor's runtime model choice.

Related: [`advisor-runtime.md`](advisor-runtime.md),
[`architecture.md`](architecture.md), and
[`skills/switch-intelligence-profile/SKILL.md`](../skills/switch-intelligence-profile/SKILL.md).
