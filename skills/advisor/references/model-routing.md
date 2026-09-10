# Model routing and locked execution packets

Read this when choosing a model or reasoning level that the guide in your
system prompt does not settle, when routing UX work, or when preparing a
locked execution packet for a cheap executor.

## Selection doctrine

The fixed `bg-agent-profiles.json` contains role transport only; it never pins
or allowlists a model. The active intelligence guide, materialized from
`~/.pi/agent/advisor-intelligence.json`, carries model characters, default
reasoning guidance, and ordered role recommendations, and it is rendered into
your system prompt on every turn, so a profile switch takes effect on the next
turn without a read. Named profiles live in `~/.pi/agent/intelligence-profiles/`
(`codex-max`, `codex-lean`, `anthropic-heavy`, `balanced`, `grok-cycle`). When
the user asks to switch guides, load `switch-intelligence-profile` and run the
switcher. Switching never changes `bg-agent-profiles.json`.

Choose the model and reasoning that best fit the node, whether listed in the
guide or not. Treat model character, capability, cost, quota, availability,
and task risk as judgment inputs rather than bindings. Record a concise
rationale for an outside-guide choice only when it is material; never ask
permission merely because a model or reasoning level is unlisted.
Recommendations are advisory and non-exhaustive; worker runtime never rejects
an outside-guide or changed identity. Roles do not pin or allowlist a model.

## Frontend routing

Frontend routing is scope- and capacity-aware guidance, and the preferred IDs
come from the live guide:

- in `codex-max`, every UX builder, greenfield or existing and substantial or
  bounded, uses Astra xhigh with `frontend-design`; no Anthropic model is
  recommended there;
- in `codex-lean`, regular UX builders use Sol medium and materially
  ambiguous or wide-breadth UX builders use Astra medium, always with
  `frontend-design`; no Anthropic or Cursor model is recommended there;
- in the remaining guides, genuinely new or greenfield UX uses the model whose
  character reserves it for greenfield UX (Opus while Anthropic capacity is
  healthy), always with `frontend-design`; if that model is missing, capacity
  is tight, or a launch reports a capacity limit, prefer the UX fallback named
  in its character note and never silently downgrade the UX requirement;
- substantial changes to an existing UX use the generalist whose character
  covers existing UX (Sonnet in `anthropic-heavy` or `balanced`; Grok in
  `grok-cycle`);
- minor targeted tweaks to an existing UX may use the model whose character
  includes that work;
- all UX implementation loads `frontend-design`; load the repository's normal
  frontend skill as well when one exists.

## Session and role capacity notes

In guides that map Fable, treat its shared Anthropic session allowance as an
important cost and quota input: reserve Opus for the greenfield UX or
extreme-risk work named in the live character notes, and reserve Fable for the
advisor session (at medium) or guide-recommended planning (at high); if Fable
reaches capacity, prefer the fallback in its character note (Astra at high in
`balanced`, Grok in `grok-cycle` and `anthropic-heavy`). In `codex-lean`, the
advisor uses Astra xhigh while planner and foreman nodes use Astra high. In
`codex-max` the advisor session, planner, foreman, and primary builder run on
Astra at xhigh. These are strong defaults, not role allowlists;
depart when capability and task risk justify it and record the rationale when
material. Workers still cannot silently change the advisor's active model.

For non-UX work, normally pick the implementation workhorse from the live
characters: Astra xhigh for all decision-bearing builders in `codex-max`, with Sol high for
locked packets and Sol xhigh for review and reduction; Sol medium for regular
builders, locked packets, checking, and reduction in `codex-lean`, reserving
Astra medium for materially ambiguous or wide-breadth implementation;
Sonnet default with Astra high for hard backend in `balanced`; Grok in
`grok-cycle`; Sonnet in `anthropic-heavy`. The shipped
guides recommend Cursor only as `cursor/grok-4.6`; another Cursor identity is
simply an outside-guide choice and needs only a concise rationale when
material, not a transport override. A feature spanning independently editable
surfaces may split under the normal builder rules (distinct worktrees plus
explicit approval when parallel, otherwise serial in one worktree).

## Locked execution packets and cheap builders

Choose builder identity by **decision load and risk**, not by the nominal
builder role or a file-count threshold. Every live guide names a cheap
procedural model that may implement a locked execution packet. Prefer that
executor when the material behavior and approach are already decided, the
edit surface and existing pattern are bounded, and deterministic criteria can
prove completion. Keep the guide's stronger implementation model when
architecture is still ambiguous, diagnosis is the work, or schema, migration,
authorization, security, money, destructive data behavior, or another
high-risk boundary must be decided while editing.

A locked execution packet is concise, not a deterministic recipe. Store it
under the advisor state root and give the worker its path plus the essential
context. It records the fixed product and architecture decisions; the bounded
surface, existing pattern, and explicit non-goals; the acceptance criteria and
relevant upstream artifacts; and material stop conditions. It obeys the same
freeze lists as every packet: it locks decisions and criteria, never tool
versions, directory modes, retry counts, or command order.

The cheap executor owns normal local implementation choices inside that
packet, including resolving environment and tooling obstacles locally and
recording them under `Deviations`. It must stop and report evidence rather
than invent or change a material product, architecture, schema, migration,
auth, product-fallback, destructive-operation, or external-effect decision.
The advisor then clarifies the packet or selects a stronger model. Do not add
an extra checker merely because the maker was cheap; review tier still follows
product risk, while deterministic criteria backstop the packet.

Prefer one maker packet for adjacent work that shares a decision set, risk
tier, worktree, skills, and criterion suite. Split when those boundaries
differ, the combined context would weaken execution, or real parallel
ownership shortens the critical path. This is a cohesion presumption, not a
worker-count target. Never split mechanically by package, and never merge
unrelated decisions merely to reduce launch count.

## Browser verification preflight

Assign task-shaped readiness to the maker or browser verifier and reuse current
proof before a costly separate launch. Check relevant runtime ownership, safe
environment/data target, local auth and doctor/health gates, not a universal
checklist that the advisor repeats itself. If readiness can only be established
inside the verifier, make it the first step before page control. Resolve permitted
local obstacles there; a missing safe target, credential or authority is a real
stop, not permission to proceed unsafely.
