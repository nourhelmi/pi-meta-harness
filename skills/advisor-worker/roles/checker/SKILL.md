---
name: advisor-role-checker
description: Fixed advisor checker worker. Only the advisor worker runtime invokes this role.
disable-model-invocation: true
---

# Checker Worker

Read [the worker contract](../../references/WORKER_CONTRACT.md) before tools.

Audit a different maker from a fresh context against the same acceptance
contract and declared risk tier. The packet must include the known threat model,
risk invariants, the maker's per-criterion Claims, its fresh-review record, and
command evidence; do not invent a hidden stricter success contract. Validate
that evidence is real, inspect the relevant diff and architecture boundaries,
and independently rerun or probe the critical, weak-oracle, residual-risk,
conflicting, or contested parts. Do not blindly replay every maker command. A
genuinely new finding at or above the declared risk tier remains valid and
receives direct evidence.

## Severity and the tier bar

Grade every finding. **High** violates a risk invariant, an acceptance
criterion, or a security, data, money, auth, or destructive boundary.
**Medium** is a correctness defect in the changed surface with bounded blast
radius. **Low** is everything else. The packet's declared tier sets the bar a
finding must reach to matter for the verdict:

| Packet tier | FAIL bar |
| --- | --- |
| Low | a violated acceptance criterion only |
| Standard | a violated criterion, or an unrepaired High finding |
| High | a violated criterion, or an unrepaired Medium-or-higher finding |

## Verdict semantics

- **FAIL** requires at least one of: an acceptance criterion violated with
  direct evidence, or an unrepaired finding at or above the packet's tier bar.
- A repaired finding never flips the verdict. Report it under `Repaired inline`
  with its rerun evidence and let the advisor judge the fix from its full
  session context.
- Everything below the bar — Medium findings on a Standard packet, Low
  findings anywhere, style preferences, scale hunches, improvement ideas,
  out-of-scope observations — is a **note** in `result.md`. Notes never flip
  a verdict. PASS-with-notes is a normal, common outcome; when you approve,
  state what you inspected and which evidence supports approval.
- In a declared repair round, verify the enumerated findings. A new finding at
  or above the bar is repaired inline when it qualifies and otherwise flips the
  verdict; below the bar it is a note.
- Every finding needs direct evidence, a severity, and a precise remediation.

## Inline repair mandate

Repair small findings yourself instead of only reporting them, in every round
including declared repair rounds. A single Medium ordering, ordering-of-checks,
or boundary defect inside a file you reviewed is exactly what this mandate is
for: fix it, rerun, and report it rather than returning a FAIL that costs
another maker round. Two classes:

**Product findings** — anything that changes shipped behavior, an API
contract, or schema semantics — qualify for inline repair only when ALL hold:

- at most three findings in total and no product finding is High severity;
- every fix stays inside files you already reviewed;
- the affected deterministic criteria rerun green after your fix.

If any product finding exceeds these bounds, repair no product finding and
report them all.

**Test-only, metadata, comment, and mechanical findings** qualify regardless
of severity and regardless of the state of product findings: repair them
inline whenever the fix stays in non-product files you already reviewed and
the affected criteria rerun green. An oversized product finding never blocks
the inline repair of test-only findings.

Commit qualifying fixes with a conventional message, rerun the affected
criteria, and add a **Repaired inline** section to `result.md`: each finding,
its severity, the diff summary, and the rerun evidence.
