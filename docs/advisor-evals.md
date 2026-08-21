# Advisor evaluations

The first evaluation layer measures observable advisor judgment without declaring one
workflow to be correct. It has four separate stages:

1. **ingest** a Pi session JSONL file into bounded, sanitized event metadata;
2. **analyze** descriptive trace facts;
3. **evaluate** a rubric/checkpoint fixture into a model-judge-ready packet; and
4. **compare** two metric reports without assigning a winner.

```bash
npm run eval:advisor -- ingest /path/to/session.jsonl
npm run eval:advisor -- analyze evals/local/<artifact-alias>.normalized.json
npm run eval:advisor -- evaluate evals/cases/evidence-rich-routing-defect/fixture.json \
  --output evals/local/evidence-rich.packet.json
npm run eval:advisor -- compare evals/local/left.metrics.json evals/local/right.metrics.json
```

When `ingest` has no `--output`, it writes under `evals/local/`. That directory is
gitignored. Keep real traces there; never add Pi sessions, transcripts, credentials,
browser state, or advisor runtime artifacts to Git.

## Privacy boundary

Ingestion never copies raw user/assistant message bodies, decision summaries, thinking,
tool result text, raw tool payloads, working directories, transcript paths, labels, or
anchor text. It does not attempt blacklist redaction. The persisted schema is a closed
allowlist: timestamps and bounded counts; known tool, role, status, action, and signal
categories; generated event IDs; and opaque aliases.

Graph IDs, node IDs, worker and attempt identities, model IDs, labels, and anchors become
128-bit aliases derived from the full artifact digest plus the field category and value.
Aliases are deterministic for correlation inside one artifact and change when the
artifact changes. Raw tool-call IDs remain private in memory and are used only to attach
ordered or out-of-order results to the correct attempt alias. Unknown tools, roles, and
statuses collapse to the categorical values `other` or `unknown`.

Arbitrary `EVAL_SUMMARY:` prose is intentionally unsupported: even opt-in free text can
contain proprietary names, paths, or secrets unknown to a sanitizer. The parser may
inspect message text transiently to derive closed signals such as stop, redirect, builder
invalidation, or auth/data boundary, and to derive repetition relationships between
generated event IDs; source text and similarity fingerprints are not retained. Input
entries, output events, serialized bytes, and repetition pairs have hard artifact-wide
budgets. Review remains appropriate before sharing even though the normalized contract
contains no user-controlled free text.

## Diagnostic metrics

`analyze` reports:

- wall elapsed time and active elapsed time, where each inter-event gap is capped at five minutes;
- tool-name counts;
- successful worker attempts by role, failed and resumed launches, and recovery ratio;
- graph count, dependency/parallel waves, maximum wave width, and same-timestamp launch batches;
- exact or near-duplicate anchor/label pairs;
- builder invalidation, user redirect/stop, and auth/data boundary signals.

These are diagnostics, not orchestration law. A parallel wave can be wasteful, a serial
step can be correct, a recovery can be wise, and a short trace can fail the task. The
metrics do not prove correctness, causation, communication quality, or user value.
Near-duplicate and text-signal detection is heuristic and requires human review.

## Fixture and judge boundary

A fixture contains a weighted five-dimension rubric and checkpoints tied to normalized
event IDs. Checkpoint IDs and action IDs must be unique, and normalized duplicate action
descriptions/support sets are rejected. Every checkpoint must offer at least two
genuinely distinct acceptable next actions, so validation rejects a hidden golden plan.
The dimensions are:

- `outcomeCorrectness`
- `informationValue`
- `adaptationConvergence`
- `efficiencyParallelism`
- `safetyCommunication`

`evaluate` validates the fixture and emits an `advisor-rubric-judge-input` packet with
the sanitized trace, diagnostics, rubric, checkpoints, and a structured future judge
output contract. It does not call a model. A future judge adapter should consume this
packet and return dimension scores, rationales, event IDs, checkpoint assessments, and
uncertainties without changing ingestion or metric semantics.

## Synthetic foundation case

[`evals/cases/evidence-rich-routing-defect`](../evals/cases/evidence-rich-routing-defect)
is a public, synthetic analogue. It includes an evidence-rich report, provider ownership
ambiguity, safe baseline browser evidence, deprecated-subsystem risk, a repeated
low-information browser attempt, an auth/data boundary, builder invalidation, and an
endpoint-matrix blind spot. It contains no real company, product, ticket, user, endpoint,
credential, or transcript data. Its baseline report is deterministic and descriptive.
