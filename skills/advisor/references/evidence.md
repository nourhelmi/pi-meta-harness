# Evidence, verification, and review depth

Read this when judging whether evidence can be reused, how deep a review
should go, how a repair is closed, or how browser evidence and rebases are
handled at delivery.

## Evidence proportionality

Existing ticket evidence is valid input. Delegate or reproduce it only when the
work will resolve a named uncertainty, choose a code path, establish a needed
baseline, or satisfy delivery evidence. Do not inventory every screenshot,
log, or acceptance artifact by default. One strong witness may be sufficient;
repeat flaky or racy behavior when repetition materially changes confidence.

Treat worker results and your own workstream notes as concise evidence
indexes, not duplicate archives. Keep every claim's outcome, material
failures, and limitations visible; reference each distinct proof by a precise
locator instead of repeating commands, logs, probe programs, or whole diffs.
Preserve the reproducible invocation and needed source or output in the
linked artifact. Never collapse distinct executions or pass a claim merely
because a summary says PASS.

Use the summary when it answers the question; it is an index, not the only evidence.
Search the worker's recorded transcript for original decisions, commands and tool
results, and inspect the relevant files or captures directly. A terminal output
tail is not a complete transcript. Page large history instead of importing it all.
Required evidence, critical or contested claims, uncertain coverage/provenance and
contradictions still require underlying evidence. Missing proof stays unsatisfied,
but does not negate observed execution completion or prohibit unrelated work.
A recorded command proves only that invocation, not current behavior after a change.
Keep required launch criteria and material boundaries explicit; link supporting
detail rather than pasting upstream reports into every packet.

## Verification ownership

The maker proves every acceptance criterion, inspects its own diff, and
records exact commands and task-shaped evidence. Required checks and failure
probes are maker work, not something to leave for a checker. The advisor
inspects that evidence and the changed surface, then chooses any still-needed
authoritative rerun by risk, oracle strength, and uncertainty. It need not
replay every expensive criterion or become a second full-time verifier.

Evidence can travel between roles when its revision, covered surface, exact
command/outcome, provenance, and limitations are known. A commit alone is not
a revision identity for a dirty worktree: bind evidence to the actual tested
diff or content. Inspect authenticity and coverage; a PASS summary alone is
not proof. Carry forward evidence for unchanged relevant surfaces, including
through an integration or repair, but rerun what a code, test, dependency, or
environment change invalidates. Never inherit stale, contradicted, or
unverifiable evidence. Use ordinary text and artifact paths, not a new form or
mandatory schema.

A checker audits the same acceptance contract and declared risk tier, with
explicit assigned review claims and boundaries. Full contract and threat
context is not an instruction to repeat every maker command. Independently
probe the critical, weak, residual-risk, conflicting, or contested parts and
account for every assigned claim with inspected or newly produced evidence,
clearly attributed. Explicitly required independent checks must actually run;
evidence reuse never waives them. Missing proof remains unsatisfied. A
genuinely new finding that meets the packet's severity bar remains valid even
though it was not known to the maker.

Assign delivery gates to an owner rather than every layer. Follow the repository's
actual required checks, agentic PR review, verdict and merge/release requirements
for the delivered revision, plus explicit user requirements. Agentic PR review is
owned by the project's review/CI workflow, not a mandatory local harness stage.
Inspect that review's findings and verdict for the current PR revision, and follow
its re-review rules after changes. Pending, unavailable or stale required review
remains an unmet delivery gate: a local checker, green tests or an older verdict
cannot substitute for it. Do not invent external review where none is required,
or add/change workflows, publish verdicts or merge without scope and authorization.
Do not duplicate already-authoritative checks or add unrelated repository sweeps.

## Review depth and closure

Give the checker the full acceptance contract, declared risk tier, known
threat model, maker claims, and command evidence. State its assigned review
claims, the reviewed surface it owns, relevant evidence to carry forward, and
which checks another owner will perform. Never hide a stricter known success
contract for review. The checker validates high-value evidence and
independently probes critical or contested risks; it does not blindly replay
every deterministic command or inherit an unverified PASS.

Choose review depth and model by risk, oracle strength, uncertainty, and
expected information gain. Sample meaningful failure modes and trust
boundaries, not exhaustive matrices or assertion counts for their own sake.
Deepen when a concrete gap or contradictory result warrants it. Stop when
assigned claims and material risks are resolved with current evidence and no
material contradiction remains; more possible tests or files alone do not
justify continuing. Neither elapsed time nor absence of findings is proof.

Verify repairs with affected criterion reruns and a targeted diff or blast-radius
read, and carry forward unaffected valid evidence. Another review is useful when
the repair invalidates prior reasoning or leaves a named uncertainty, not merely
because a file changed or a test once failed. Review that delta first; expand only
when the risk crosses its boundary. A checker's assessment of the original work
remains independent, but its patch's reruns are self-verification, not independent
review of that patch. No material checker delta automatically requires a non-author
or checker-of-checker: follow project/user review requirements, verify the affected
behavior and report remaining uncertainty without inventing another harness gate.

Independent read-only checks of the same frozen diff may run in parallel when
they materially shorten the critical path and neither is likely to invalidate
the other's evidence. Serialize a likely high-impact safety review first when
its findings would make parallel browser evidence stale or unsafe. A separate
browser specialist is not required: whoever changes behavior owns the affected
journey checks, including checker repairs and direct advisor work.

## Browser impact and evidence delivery

Use the worker contract's journey-impact rule before edits and again when repairs
or integration change the surface. Name plausible affected user journeys from the
actual diff and call/data flow, not every reachable screen. Exercise browser-facing
changes against the integrated application, including backend changes that affect
auth, API wiring, stored state or user-visible errors. Choose relevant personas,
states and failure paths; use current project browser tests when they cover the
flow, without defaulting to the whole suite. No plausible browser impact means
relevant unit/API/integration checks and a short rationale, not a browser ritual.
Unclear impact requires inspecting consumers. A missing safe target or unexercised
flow remains an explicit coverage gap, not a PASS inferred from non-browser tests.

Record tested content (including dirty changes), environment/persona, flow, checks,
observed outcomes and useful evidence paths during verification. Screenshots or
recordings support the claim when useful; a screenshot alone is not functional
proof. No mandatory manifest or extra evidence-only pass. Protect credentials and
private data; remove unsafe captures and recapture safely. Use repository-required
artifact formats and delivery rules when they exist.

At delivery, carry forward only still-valid evidence for the delivered revision.
Recheck coverage when code, tests, dependencies, configuration or environment
changes; a test-only commit or unchanged path alone proves nothing. Rerun affected
flows after repairs, not the entire browser suite by default. Submit evidence with
the PR only when required/authorized. Missing upload access does not prevent local
verification; report any required publication as pending rather than dropping it.

## Rebase policy

1. Do not rebase before PR by default. When the branch merges cleanly into
   the target and the changed-path intersection with the target delta is
   empty, open the PR from the current base; CI verifies the merge result.
2. When a rebase is genuinely required, inspect range-diff, aggregate diffs and
   the target's changes for equivalence and relevant integration effects. An
   unchanged patch does not prove an unchanged dependency or environment.
   Carry forward unaffected verdicts and captures with that justification;
   rerun invalidated criteria and required merge gates. Do not impose either
   an automatic full re-review or an arbitrary one-check ceiling.
