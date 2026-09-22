---
name: switch-intelligence-profile
description: >
  Switch or show the advisor intelligence profile (codex-max, codex-lean,
  anthropic-heavy, balanced, grok-cycle). Use when the user says "switch to
  lean", "switch to balanced", "switch to grok-cycle", "codex weekly is gone",
  "use the anthropic-heavy guide", "change intelligence profile", or asks which
  guidance is active. Mid-session switches guide subsequent bg_agent choices.
---

# Switch intelligence profile

The live advisor guide is `~/.pi/agent/advisor-intelligence.json`. Named guides
live in `~/.pi/agent/intelligence-profiles/`. Fixed role guardrails live in
`~/.pi/agent/bg-agent-profiles.json` and must remain byte-unchanged by a switch.

## Do this

Run the switcher with an argv array, never a shell-interpolated command:

```bash
node "$HOME/.pi/agent/bin/intelligence-profile.mjs"
node "$HOME/.pi/agent/bin/intelligence-profile.mjs" --list
node "$HOME/.pi/agent/bin/intelligence-profile.mjs" codex-lean
node "$HOME/.pi/agent/bin/intelligence-profile.mjs" anthropic-heavy
node "$HOME/.pi/agent/bin/intelligence-profile.mjs" balanced
node "$HOME/.pi/agent/bin/intelligence-profile.mjs" grok-cycle
node "$HOME/.pi/agent/bin/intelligence-profile.mjs" codex-max
```

If the installed switcher is missing, run it from the harness checkout:

```bash
node /Users/nour/Dev/pi-meta-harness/scripts/intelligence-profile.mjs <name>
```

The advisor's system prompt renders `advisor-intelligence.json` on every turn,
so a switch takes effect on the next turn without a read. Use its ordered
`recommendations` and model `character` notes as preferred guidance. The list is
not exhaustive or enforceable: choose outside it when task fit, availability,
or capacity warrants, and include a concise rationale in the task packet or
advisor record. Do not edit the fixed role config.

The switcher is also the explicit repair path for a missing, stale, or
interrupted ACTIVE/live selection. Pick the intended named profile and run it;
do not manually copy one side over the other. Doctor and reinstall refuse an
inconsistent pair rather than guessing which side is authoritative.

## After a switch

- Report the active profile and preferred workhorse/reviewer shown by the switcher.
- Already-running workers keep their launch identity.
- This advisor session's `/model` does not change.
- This advisor session's persisted worker harness (`pi` or `native`) does not change.
- In native mode, new OpenAI selections route to Codex CLI and Anthropic selections
  route to Claude Code. Cursor/Grok selections need a task-fit OpenAI/Anthropic
  alternative from the active guide or an explicit transport-mismatch report.
- New workers do not reject outside-guide identities or later identity changes;
  manifests retain launch/current model and thinking for audit.
- Role skill, no-advisor promotion instruction, anchors, and cycle-cap instructions
  remain hard regardless of the chosen identity.

## Profiles

| Name | When | Workhorse | Adversarial review | Procedural |
| --- | --- | --- | --- | --- |
| `codex-max` | Codex weekly is healthy | GPT-6 Sol xhigh; high for locked packets | Sol xhigh | Luna max browser verification; Sol high locked execution |
| `codex-lean` | Codex remainder is usable | Sol xhigh; Sol max for ambiguous/wide builds | Sol xhigh | Luna max browser verification; Sol xhigh locked execution |
| `anthropic-heavy` | Spend Anthropic on purpose | Opus 5.5 medium; high for greenfield UX | Opus medium | Opus medium locked execution |
| `balanced` | Opus high advises; Sol builds and checks | Sol high; Opus high for greenfield UX | Sol xhigh | Sol high locked execution |
| `grok-cycle` | No Codex; Grok owns maker + hefty review | Grok | Grok | Opus 5.5 medium |

Sol and Luna refer to GPT-6; Opus refers to Claude Opus 5.5. Opus uses medium or high,
never xhigh/max. Every former Sonnet recommendation uses Opus medium.

In `codex-lean`, Sol high is the advisor and child-advisor choice. Regular builders,
checking, and fully locked execution use Sol xhigh; materially ambiguous or
wide-breadth builders use Sol max. Luna max is an optional economical choice for
explicitly assigned browser-heavy work. The named guide contains only OpenAI Codex models.

In `anthropic-heavy`, Opus high advises, medium builds and checks, and high handles
greenfield UX. In `balanced`, Opus high advises, Sol high is the default builder,
Opus high handles greenfield UX, and Sol xhigh checks.

In `codex-max`, the advisor, child advisor, and primary builder use GPT-6 Sol
xhigh, including substantial and all UX implementation. Review uses Sol xhigh;
Luna max remains optional for browser-heavy work. Advisors own planning and synthesis;
builders and checkers own their investigation, local planning and verification.
Browser verification belongs to the author, not a separate worker stage. The
profile does not mandate reviewers or replace project-owned agentic PR review.
Changing this guidance does not switch the running advisor's reasoning level.

Deep dive: [`docs/intelligence-profiles.md`](https://github.com/nourhelmi/pi-meta-harness/blob/main/docs/intelligence-profiles.md)
(the repository link also works from an installed skill).
