# Advisor evaluations

The first evaluation layer measures observable advisor judgment without declaring one
workflow to be correct. It has four separate stages:

1. **ingest** a Pi session JSONL file into bounded, sanitized event metadata;
2. **analyze** descriptive trace facts;
3. **evaluate** a rubric/checkpoint fixture into a model-judge-ready packet; and
4. **compare** two metric reports without assigning a winner.

```bash
npm run eval:advisor -- ingest /path/to/session.jsonl
npm run eval:advisor -- analyze evals/local/session.normalized.json
npm run eval:advisor -- evaluate evals/cases/evidence-rich-routing-defect/fixture.json \
  --output evals/local/evidence-rich.packet.json
npm run eval:advisor -- compare evals/local/left.metrics.json evals/local/right.metrics.json
```

When `ingest` has no `--output`, it writes under `evals/local/`. That directory is
gitignored. Keep real traces there; never add Pi sessions, transcripts, credentials,
browser state, or advisor runtime artifacts to Git.

## Privacy boundary

Default ingestion never copies raw user/assistant message bodies, thinking, tool result
text, raw tool payloads, working directories, transcript paths, or anchor text. It keeps
only selected evaluation metadata: timestamps, tool names, graph IDs and dependency
waves, worker role/model/sanitized label/status, launch versus resume, and small derived
signals. Anchors become a one-way fingerprint, a similarity signature, and a word count.

Metadata text is length-bounded and redacts obvious paths, URLs, email addresses,
ticket-like IDs, UUIDs, common token prefixes, and long opaque strings. This is not a
complete proprietary-name detector. Review any artifact before sharing it.

Decision summaries are opt-in. `--include-summaries` accepts only message lines prefixed
with `EVAL_SUMMARY:` and applies the same sanitizer; it does not summarize arbitrary
message bodies. A fixture may set `ingest.includeTaggedSummaries` for a reviewed
synthetic trace. The parser may inspect message text locally to emit shallow boolean
signals such as stop, redirect, builder invalidation, or auth/data boundary; the source
text is not retained.

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
event IDs. Every checkpoint must offer at least two acceptable next actions, so fixture
validation rejects a single golden plan. The dimensions are:

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
