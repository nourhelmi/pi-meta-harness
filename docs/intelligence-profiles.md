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
providers to Claude Code while retaining the same seven semantic roles and skills.
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
- use the profile's cheap executor when a concise execution packet has fixed the
  approach, bounded the surface, named existing patterns and non-goals, and
  provided deterministic anchors;
- if the cheap executor discovers a missing material decision or contradictory
  evidence, it stops and escalates rather than inventing a route.

The shipped locked-packet executors are:

| Profile | Cheap executor |
| --- | --- |
| `codex-max` | Sol high |
| `codex-lean` | Sol high |
| `balanced` | Sol high |
| `anthropic-heavy` | Sol high while Codex capacity remains |
| `grok-cycle` | Sonnet medium |

This is advisory task-fit guidance, not a model allowlist or a deterministic
small-file rule. A cheap maker does not automatically earn another checker;
review tier follows the product risk and deterministic anchors remain the
backstop.

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
  CodexQ -->|hard builds plus Anthropic checks, no Grok| UseBA[balanced]
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
- **Codex hard builds plus Anthropic default builds/checks, no Grok** → `balanced`
- **Codex dead and Grok owns maker/review** → `grok-cycle`

The shipped guides recommend Cursor only as `cursor/grok-4.6`; that is guidance,
not transport enforcement.

## 🃏 Profile cards

The tables summarize preferred order. The JSON `character` and `fit` fields hold
the detailed task and capacity guidance.

### `codex-max` — healthy Codex

| Role | Ordered recommendations |
| --- | --- |
| advisor | Astra max (session guidance) |
| planner | Astra max |
| builder | Astra high (all decision-bearing work), Sol high (locked packet), Grok high |
| foreman | Astra xhigh |
| checker | Sol xhigh, Sol high |
| reducer | Sol xhigh |
| scout | Sol high, Grok high |
| browser-verifier | Sol high, Astra high |

Astra (GPT-6) is the advisor session and planner model at max. Foremen use
Astra xhigh. All Astra builders use high, including substantial implementation,
bounded-judgment work, and every kind of UX work. Greenfield and existing UX
both load `frontend-design`. Sol xhigh is the
fresh-context reviewer and reducer, including adversarial checks. Sol high is
the procedural tier: scouting, browser verification, routine checks, and
locked execution packets; it stops instead of making material product or
architecture decisions. Grok stays as the capacity alternate for research and
bounded backend work. This profile recommends no Anthropic model.

This split concentrates deeper reasoning on decisions that shape downstream
work; lower total task cost is a hypothesis, not a measured guarantee.
Changing the guide does not change an already-running advisor's reasoning
level or a worker's launch identity.

### `codex-lean` — spend the Codex remainder carefully

| Role | Ordered recommendations |
| --- | --- |
| planner | Astra high |
| builder | Astra high, Sonnet high, Sol high (locked packet) |
| checker | Sol xhigh, Sonnet high |
| reducer | Sol xhigh, Sonnet high |
| scout | Sol high, Sonnet high |
| browser-verifier | Sol high, Sonnet high |

Astra high plans and handles hard builds, while Sol xhigh handles adversarial
review and hefty reduction. Sonnet handles medium well-known work and ordinary
review; Sol high handles locked execution packets and procedural work. Fable is
advisor-session guidance rather than a worker recommendation in this profile.

### `anthropic-heavy` — spend the 5-hour window deliberately

| Role | Ordered recommendations |
| --- | --- |
| planner | Fable high, Grok high |
| builder | Sonnet high, Opus medium, Grok high, Sol high (locked packet) |
| checker | Sonnet high, Opus medium, Sol high, Grok high |
| reducer | Sonnet high, Opus medium |
| scout | Sol high, Grok high, Sonnet high |
| browser-verifier | Sol high, Grok high |

Sonnet is the decision-bearing implementation and review workhorse, Opus is the
greenfield UX or extreme-risk option, Sol high uses remaining Codex for locked
execution packets and procedural work, and Grok remains the profile's existing
capacity fallback.

### `balanced` — Codex builds hard, Anthropic builds/checks the rest

| Role | Ordered recommendations |
| --- | --- |
| planner | Fable high, Astra high |
| builder | Sonnet high, Astra high (hard backend), Opus medium, Sol high (locked packet) |
| checker | Sonnet high, Opus medium, Sol xhigh |
| reducer | Sonnet high, Opus medium, Sol xhigh |
| scout | Sol high, Sonnet high |
| browser-verifier | Sol high, Sonnet high |

Sonnet is the default decision-bearing maker and checker; Astra high
takes hard backend work; Opus takes greenfield UX; Sol high executes locked
packets and procedural work and Sol xhigh is the Codex review and reduction
alternate. Grok is intentionally absent from
the recommendations but is still not blocked at runtime.

### `grok-cycle` — no Codex recommendations

| Role | Ordered recommendations |
| --- | --- |
| planner | Fable high, Grok high |
| builder | Grok high, Sonnet medium (locked packet) |
| checker | Grok high, Sonnet medium |
| reducer | Grok high, Sonnet medium (native fallback) |
| scout | Sonnet medium, Grok high |
| browser-verifier | Sonnet medium, Grok high |

Grok is the preferred model for hefty decision-bearing implementation, review,
and reduction when those roles are justified. Sonnet medium handles locked
execution packets, short-leash procedural work, and reduction when the session
uses native harnesses without a Cursor route. When risk warrants independent
review of a Grok build, use a fresh invocation and preserve deterministic anchors
as the independence backstop.

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
