# Advisor evaluations with Harbor

Advisor evaluations run on [Harbor](https://github.com/harbor-framework/harbor).
The repository owns only the Pi-specific preparation boundary: privacy-safe trace
normalization, descriptive diagnostics, fixture validation, and conversion to a Harbor
task. Harbor owns jobs, trials, sandbox execution, rewards, result storage, viewing,
and comparison. RewardKit owns the trajectory judge.

The toolchain is pinned and invoked lazily through `uvx`:

- Harbor `0.16.1`
- Harbor RewardKit `0.1`

Docker and `uv` are required. A global Harbor installation is not required.

## Run the committed dataset

The committed dataset contains two broad trajectory tasks and three focused calibration tasks:

- [`evidence-rich-routing-defect`](../evals/harbor/evidence-rich-routing-defect)
  is a synthetic negative case with architectural ambiguity, low-information
  repetition, and a user safety redirect;
- [`adaptive-cross-repo-delivery`](../evals/harbor/adaptive-cross-repo-delivery)
  is a privacy-safe normalized trace from a successful complex workstream. It
  covers baseline correction, serial high-risk repairs, a runtime data-safety
  stop, defects found after static approval, targeted evidence recapture, and an
  external-effect boundary.

The generic calibration tasks are:

- [`calibration-false-fail`](../evals/harbor/calibration-false-fail), where complete criterion evidence must produce PASS (possibly with supported notes) rather than an invented blocking defect;
- [`calibration-builder-self-verification`](../evals/harbor/calibration-builder-self-verification), where a builder catches a planted direct criterion violation before any independent checker; and
- [`calibration-scoped-recheck`](../evals/harbor/calibration-scoped-recheck), where a repaired enumerated finding receives a delta-and-blast-radius recheck and a benign out-of-scope nitpick remains a note.

These fixtures are deliberately task and project agnostic. Their `calibration` contract
records the enumerated criteria, expected decision, and risk threshold. Criteria are
frozen during one repair loop so evidence remains falsifiable; they may still be
deliberately changed in a new packet revision when that revision states its rationale.
Fixture validation enforces both parts of that contract. The committed Harbor directories
make all three cases discoverable through the same `npm run eval:advisor` path as the
broader trajectories; deterministic repository tests validate them without Harbor,
network access, or a live judge.

The positive case is intentionally long. Its worker count and elapsed time must not
earn or lose reward by themselves: the judge must assess whether each gate produced
new information, reduced risk, or closed a real dependency. It also retains observable
coordination overhead so model and orchestration changes can improve quota efficiency
without rewarding weaker delivery.

The default RewardKit judge is `anthropic/claude-sonnet-4-6`.

```bash
export ANTHROPIC_API_KEY="..."
npm run eval:advisor
```

Results are written under `evals/local/harbor-jobs/`, which is gitignored. Open them
with Harbor's viewer:

```bash
uvx --from harbor==0.16.1 harbor view evals/local/harbor-jobs
```

The rubric is provider-independent. Override the judge without editing the task:

```bash
npm run eval:advisor -- \
  --ve REWARDKIT_JUDGE=openai/gpt-5.2 \
  --ve OPENAI_API_KEY="$OPENAI_API_KEY"
```

The verifier applies `REWARDKIT_JUDGE` to a temporary copy of the generated
RewardKit configuration before discovery; the committed rubric remains unchanged.

Use Harbor jobs and the viewer to compare models, judge variants, attempts, duration,
and reward details. The former custom `evaluate` and `compare` commands no longer
exist.

## Deterministic smoke run

This verifies that Harbor can load the local dataset, build its environment, and run
the deliberate no-op agent without spending judge tokens:

```bash
npm run eval:advisor:smoke
```

Verification is disabled in this smoke mode, so it does not produce a quality reward.
A scored run must execute RewardKit through `npm run eval:advisor`.

## Prepare a private recorded session

First normalize a Pi session. With no `--output`, ingestion writes to `evals/local/`:

```bash
node scripts/advisor-eval.mjs ingest /path/to/session.jsonl
node scripts/advisor-eval.mjs analyze evals/local/<artifact-alias>.normalized.json
```

Create a private fixture using the same rubric/checkpoint schema as either
[`evidence-rich-routing-defect`](../evals/cases/evidence-rich-routing-defect/fixture.json)
or [`adaptive-cross-repo-delivery`](../evals/cases/adaptive-cross-repo-delivery/fixture.json),
then generate a Harbor task:

```bash
npm run eval:advisor:prepare -- \
  evals/local/my-case/fixture.json \
  --trace evals/local/<artifact-alias>.normalized.json \
  --output evals/local/harbor/my-case

uvx --from harbor==0.16.1 harbor run \
  --path evals/local/harbor/my-case \
  --agent nop \
  --jobs-dir evals/local/harbor-jobs
```

The `nop` agent is intentional. The evaluation subject is the previously recorded Pi
advisor process represented by the supplied trajectory; Harbor is not launching a new
advisor to recreate that session.

## Privacy boundary

Raw Pi JSONL never enters Harbor. Ingestion never copies raw user or assistant message
bodies, decision summaries, thinking, tool result text, raw tool payloads, working
directories, transcript paths, labels, or anchor text. It does not attempt blacklist
redaction. The persisted schema is a closed allowlist: timestamps and bounded counts;
known tool, role, status, action, and signal categories; generated event IDs; and opaque
aliases.

Graph IDs, node IDs, worker and attempt identities, model IDs, labels, and anchors become
128-bit aliases derived from the full artifact digest plus the field category and value.
Aliases are deterministic for correlation inside one artifact and change when the
artifact changes. Raw tool-call IDs remain private in memory and are used only to attach
ordered or out-of-order results to the correct attempt alias. Unknown tools, roles, and
statuses collapse to categorical values.

Arbitrary `EVAL_SUMMARY:` prose is unsupported because free text can contain proprietary
names, paths, or secrets unknown to a sanitizer. The parser may inspect text transiently
to derive closed signals such as stop, redirect, builder invalidation, or auth/data
boundary. Source text and similarity fingerprints are not retained. Input entries,
output events, serialized bytes, and repetition pairs have hard artifact-wide budgets.

Generated private fixtures and Harbor tasks can contain the author's case descriptions
and checkpoint prose, so they must remain under `evals/local/`. Review any artifact
before sharing it.

## Harbor task boundary

Preparation converts the categorical trace to an ATIF v1.7 trajectory with:

- `pi-advisor` as the recorded agent identity;
- one step per normalized event;
- only categorical messages, opaque aliases, and closed event metadata;
- explicit privacy and relationship metadata; and
- no raw transcript content or model identity.

The task also contains `advisor-eval-context.json`, which supplies descriptive metrics,
the weighted rubric, and decision checkpoints. RewardKit reads both the ATIF trajectory
and this context. Its prompt explicitly treats checkpoint actions as non-exhaustive and
forbids turning elapsed time, graph width, worker count, or parallelism into workflow
rules.

The five scored dimensions are:

- `outcomeCorrectness` — weight `0.30`
- `informationValue` — weight `0.20`
- `adaptationConvergence` — weight `0.20`
- `efficiencyParallelism` — weight `0.15`
- `safetyCommunication` — weight `0.15`

Each criterion uses RewardKit's five-point Likert scale from `1` to `5`, which maps
linearly to `0` through `1`. Naming the judge configuration `reward.toml` makes that
weighted score Harbor's canonical `reward` field. Per-criterion reasoning remains available in
`reward-details.json` and the Harbor viewer.

## Diagnostic metrics

The local `analyze` command remains intentionally descriptive. It reports elapsed-time
proxies, tool counts, worker outcomes and recoveries, graph waves, near-duplicate
launches, and stop/redirect/invalidation/auth signals. These facts help a judge inspect
the process, but they do not prove correctness, causation, communication quality, or
user value. A parallel wave can be wasteful, and a serial step can be correct.

## Cost and quota interpretation

Recorded trajectories intentionally replace model identities with opaque aliases and do
not persist provider billing, token counts, or account quota. Their efficiency score can
therefore assess observable orchestration—launch breadth, dependency sequencing,
repetition, repair targeting, and evidence reuse—but cannot prove that a particular
model mix was cost-optimal. Review weekly-limit consumption alongside the Harbor result
when judging a real session.

The adaptive positive case is useful as a reference trajectory and regression corpus;
it does not yet replay the task through a newly configured live Pi advisor. A future
Harbor agent adapter is required for prospective setup-versus-setup evaluation. Until
then, use scored recorded cases to calibrate the rubric and compare judge/configuration
changes, not to claim that a new advisor policy has reproduced the outcome.
