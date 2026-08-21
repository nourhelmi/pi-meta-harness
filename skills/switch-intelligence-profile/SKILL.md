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

Then re-read `advisor-intelligence.json` before the next launch. Use its ordered
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
- New workers do not reject outside-guide identities or later identity changes;
  manifests retain launch/current model and thinking for audit.
- Role skill, no-advisor promotion, tool restrictions, anchors, and cycle caps
  remain hard regardless of the chosen identity.

## Profiles

| Name | When | Workhorse | Adversarial review | Procedural |
| --- | --- | --- | --- | --- |
| `codex-max` | Codex weekly is healthy | Sol | Terra xhigh / Sol medium | Luna |
| `codex-lean` | Codex remainder is usable | Sol / Sonnet / Luna by hardness | Terra | Luna, Sonnet |
| `anthropic-heavy` | Spend Anthropic on purpose | Sonnet | Sonnet, Opus if high-risk | Luna, else Grok |
| `balanced` | Codex builds hard, Anthropic checks, no Grok | Sonnet default; Sol/Terra hard; Opus greenfield UX | Sonnet, Opus if extreme-risk | Luna, Sonnet |
| `grok-cycle` | No Codex; Grok owns maker + hefty review | Grok | Grok | Sonnet |

Deep dive: [`docs/intelligence-profiles.md`](../../docs/intelligence-profiles.md).
