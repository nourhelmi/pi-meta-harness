# Model routing

The live guide in your system prompt, materialized from
`~/.pi/agent/advisor-intelligence.json`, carries model characters and ordered role
recommendations. Named profiles live in `~/.pi/agent/intelligence-profiles/`
(`codex-max`, `codex-lean`, `anthropic-heavy`, `balanced`, `grok-cycle`); switch with
`switch-intelligence-profile`. `bg-agent-profiles.json` holds role transport only and
never pins a model. Recommendations are advisory: choose the model and reasoning that
fit the node, note a material outside-guide choice in one line, and never ask permission
for it.

## Frontend

Sol and Luna below mean GPT-6; Opus means Claude Opus 5.5 at medium or high.

In `codex-max`, every UX builder uses Sol xhigh with `frontend-design`. In
`codex-lean`, regular UX builders use Sol xhigh and materially ambiguous or wide-breadth
UX builders use Sol max, with `frontend-design`. In `anthropic-heavy`, greenfield UX uses
Opus high and substantial existing UX uses Opus medium. In `balanced`, greenfield UX
uses Opus high and other UX uses Sol high. `grok-cycle` uses its named Grok/Opus medium
fallbacks. All UX work loads `frontend-design` plus the repository's frontend skill.

## Sessions and workhorses

In `codex-max` the advisor session, child advisor, and primary builder run on Sol at
xhigh, with Sol high for locked packets and Sol xhigh for review. In `codex-lean`, the
advisor and child advisor nodes use Sol high; Sol xhigh handles regular builders,
locked packets, and checking, while Sol max handles ambiguous or wide work. In
`anthropic-heavy`, Opus high advises, Opus medium builds and checks, and Opus high
handles greenfield UX. In `balanced`, Opus high advises, Sol high builds by default,
Opus high handles greenfield UX, and Sol xhigh checks. `grok-cycle` uses Grok with
Opus medium for procedural work. Cursor is recommended only as `cursor/grok-4.6`.

## Locked execution packets

When behavior and approach are decided, the surface is bounded and a deterministic check
proves completion, hand a short packet (decisions, surface, non-goals, done-when,
evidence paths, stop conditions) to the guide's cheap executor. It makes ordinary local
choices and clears tooling obstacles, recording them under `Deviations`. It stops and
reports rather than invent a product, architecture, schema, migration, auth,
destructive-operation or external-effect decision. Keep the stronger model when diagnosis
is the work or such a decision must be made while editing. Prefer one maker for adjacent
work that shares decisions, worktree and checks; split only for real parallel ownership.
