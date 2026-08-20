---
name: switch-intelligence-profile
description: >
  Switch or show the advisor intelligence profile (codex-max, codex-lean,
  anthropic-heavy, balanced, grok-cycle). Use when the user says "switch to
  lean", "switch to balanced", "switch to grok-cycle", "codex weekly is gone",
  "use the anthropic-heavy map", "change intelligence profile", or asks which
  model map is active.
  Mid-session switches apply to subsequent bg_agent launches immediately.
---

# Switch intelligence profile

The live advisor model map is `~/.pi/agent/bg-agent-profiles.json`. Named
profiles live in `~/.pi/agent/intelligence-profiles/`. Switching copies a named
file over the live map. The next `bg_agent` launch re-reads that file. Do not
edit the live map by hand.

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

If the live copy is missing, run it from the harness checkout:

```bash
node /Users/nour/Dev/pi-meta-harness/scripts/intelligence-profile.mjs <name>
```

Then **re-read** the live `bg-agent-profiles.json` before the next launch.
Choose `model` and `thinking` only from that file's `models` map and the
role's `allowedModels`. Character notes in the new map are binding.

## After a switch

- Already-running workers keep their launch model. Only new launches change.
- This advisor session's `/model` does not change. If the session was on Sol
  and the new map has no Sol, tell the user to switch the session to Fable or
  Grok. Workers cannot change the advisor's active model.
- Report the active profile name and the workhorse/reviewer from the new map.

## Profiles

| Name | When | Workhorse | Adversarial review | Procedural |
| --- | --- | --- | --- | --- |
| `codex-max` | Codex weekly is healthy | Sol | Terra | Luna |
| `codex-lean` | Codex leftover: Sol plans + hard builds; Grok lives on grok-cycle | Sol / Sonnet / Luna by hardness | Terra | Luna, Sonnet |
| `anthropic-heavy` | Spend Anthropic on purpose | Sonnet | Sonnet, Opus if high-risk | Luna, else Grok |
| `balanced` | No Grok; Codex builds hard, Anthropic checks | Sonnet default; Sol/Terra hard; Opus greenfield UX | Sonnet, Opus if extreme-risk | Luna, Sonnet |
| `grok-cycle` | No Codex; Grok owns maker + hefty review | Grok | Grok | Sonnet |

Cursor may only appear as `cursor/grok-4.6`.

Deep dive (topology, spend, pick tree, per-role allowlists):
[`docs/intelligence-profiles.md`](../../docs/intelligence-profiles.md).
