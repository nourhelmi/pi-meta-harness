---
name: advisor-intelligence
description: Apply the harness intelligence profiles to model routing supported by a native Codex or Claude host, without changing global settings.
---

# Native intelligence routing

Profiles are advisory judgment/cost guidance, not model availability or tool permissions. Read only the selected profile, and only when a model-routing decision is relevant.

Selection order: the user's explicit choice; otherwise the existing `~/.pi/agent/advisor-intelligence.json` if present (read-only); otherwise the bundled `profiles/balanced.json`. The installer copies current canonical presets into this skill's `profiles/` directory. Available names are the JSON filenames there. Never load every preset at startup or after compaction.

Use the profile's role recommendations and task-fit descriptions. The current Codex Lean guide reserves Astra for advisor/planner and materially ambiguous or wide work; Sol medium owns regular implementation/checking/reduction; Luna max owns scouts and browser verification. The selected JSON is authoritative if these recommendations evolve.

A provider-prefixed Pi model identifier is not necessarily a valid native model selector. Consult the host's exposed controls and actual model availability. Map recommendations to verified native equivalents only; when the recommended family/effort is unavailable, retain the current model or choose an available task-appropriate equivalent and disclose material differences. Do not fabricate cross-provider support or silently route through the managed runtime to obtain it.

A skill cannot change your running root model. Do not modify global settings, authentication, permissions or the Pi ACTIVE selection to follow this guide. A user may choose a profile for this workstream without globally switching anything. Native delegation may expose fewer model/effort controls; preserve the role's reasoning and evidence requirements even when model choice is unavailable.
