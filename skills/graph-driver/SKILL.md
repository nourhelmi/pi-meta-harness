---
name: graph-driver
description: Run wide work as a graph — write a driver script (fan out → reduce → verify → synthesize) and launch it as ONE background run so intermediate results never enter this context. Use for audits, sweeps, research desks, and any task with independent parallel pieces.
---

# Graph Driver

Coordination is code, not conversation. For wide work you write a **driver
script** that runs the whole diamond and launch it with a single `bg_run`.
The script owns the intermediate results; you see one report and one wake
event. Never orchestrate a fan-out step-by-step from this context.

## The diamond, as a driver script

Write `<state-root>/graphs/<name>.ts` (bun) — the advisor state root under `~/.advisor/<repo-key>/` reported by `advisor_session_init` — then `bg_run("bun <state-root>/graphs/<name>.ts", ...)`:

```ts
// 1. FAN OUT — independent workers, fresh contexts, cheap model, schema'd output
const jobs = ANGLES.map((a, i) => run(
  `codex exec --cd ${WORKDIR} "${workerPrompt(a)} Write findings as JSON matching
   {claims:[{claim,source,date}]} to out/${i}.json. No prose."`,
));
await Promise.all(jobs);                     // parallelism is free here

// 2. REDUCE — plain code, zero tokens
const findings = dedupe(readAll("out/*.json"));   // validate schema; requeue rejects once
if (findings.length < ANGLES.length) flag(`only ${findings.length}/${ANGLES.length} returned`); // fan-in guard

// 3. VERIFY — fresh skeptic per finding, DIFFERENT model than the maker
const verdicts = await Promise.all(findings.map(f => run(
  `claude -p "Try to refute: ${esc(f)}. Reply keep|drop + reason."`,
)));
const survivors = findings.filter((_, i) => verdicts[i].includes("keep"));

// 4. SYNTHESIZE — one strong-model agent writes the report from survivors only
await run(`codex exec "Write report.md from survivors.json, ranked by confidence."`);
```

## Rules

- **Node contract**: every worker gets a bounded job, explicit input, and a
  fixed output shape written to a file. Free-text output is a broken node —
  the driver validates and retries once, then drops and flags.
- **Fresh verifier, different model**: the checker never sees the maker's
  chat, only the artifact. Majority vote (3 lenses: correct? current? source
  real?) for anything that feeds a decision.
- **Layered fan-in**: never feed N raw outputs into one step. Batch →
  summarize batches → synthesize summaries.
- **Fan-in guard**: every merge counts inputs vs expected and flags gaps.
  Never synthesize a partial set silently.
- **Isolation**: writer nodes get their own worktree. Any two nodes writing
  the same file need an edge, not parallelism.
- **Caps**: first run of any graph is capped (≤20 nodes) with a stated model
  mix. Report actual cost in the final output; widen only after a cheap run
  earned it.
- **Anchors**: graphs that claim "fixed" must show the anchor passing
  (test/build output captured in the report), not agent assertions.

## Choosing graph vs not

Apply the fake-edge test: walk the steps; an edge is real only if a step
consumes the previous step's output. No fake edges to cut → it's sequential →
use one worker or `/goal`, not a graph. A graph buys breadth, never judgment.

## Reuse

When a run comes out good, keep the script in the state root's `graphs/` with a
one-line header comment (goal, cap, cost of last run). Next time, rerun the
saved script instead of redesigning — parameterize angles/paths via argv.
