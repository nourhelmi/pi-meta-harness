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

Read the claim/evidence summary first, then inspect the relevant linked proof.
Do not open every supporting artifact by default. Required evidence, critical
or contested claims, uncertain coverage/provenance, and contradictions still
require the underlying evidence. Missing or inaccessible proof stays
unsatisfied. Keep required launch criteria and material boundaries explicit;
link supporting detail rather than pasting upstream reports into every packet.

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
genuinely new finding at or above the declared risk tier remains valid even
though it was not known to the maker.

Assign delivery gates to an owner rather than every layer. Run the
repository's actual required merge or CI gates once for the delivered
revision; do not add unrelated repository-wide sweeps or duplicate gates
already authoritative for that revision and environment. Do not mandate
unrelated repository-wide sweeps.

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

Verify repairs with affected criterion reruns and a targeted diff or
blast-radius read, and carry forward unaffected valid evidence. Another
independent review is warranted only when the repair invalidates prior
independent reasoning or leaves material independent risk, not merely because
a file changed or a test once failed. Review that delta first; expand only
when the risk crosses its boundary. A checker's assessment of the original
work remains independent, but its own patch's reruns are self-verification,
not independent review of that patch. Close a well-proven delta with the rerun
evidence and a targeted diff read when no material independent risk remains.
Otherwise assign the unresolved delta to a reviewer who did not author the
patch; the original maker can serve when its prior assumptions are not the
contested issue. Preserve unaffected review evidence and never launch an
automatic checker-of-checker for closed work.

Independent read-only checks of the same frozen diff may run in parallel when
they materially shorten the critical path and neither is likely to invalidate
the other's evidence. Serialize a likely high-impact safety review first when
its findings would make parallel browser evidence stale or unsafe. Any
verifying agent that launches a browser records evidence during that same run
and registers it in an evidence manifest in its run directory: capture commit
SHA, flows covered, and artifact paths. Verifiers never upload and never need
artifact-upload credentials. Never schedule a separate browser pass whose only
purpose is evidence capture.

## Evidence delivery

Evidence is captured while verifying and submitted at delivery.

1. Verifiers record during verification with safe local or dev personas only
   and write an evidence manifest (capture SHA, flows, artifact paths) in
   their run directory. Unsafe captures are deleted and recaptured, never
   retained.
2. The delivery node collects the manifests, compares each capture SHA to the
   delivered SHA, and submits still-valid evidence with the PR. Evidence stays
   valid while the delta does not touch its recorded surfaces: a
   proven-equivalent rebase, test-only commits, or changes outside the
   recorded flows.
3. Only stale evidence earns a re-capture, and only for the affected flows,
   never the full suite by default.
4. Artifact-upload authorization is a delivery-time gate. Pre-flight the
   actual upload capability once early in the workstream when browser work is
   planned, and again before launching the delivery node, so a credential
   failure escalates early. An upload-authorization failure never blocks
   verification or recording.

## Rebase policy

1. Do not rebase before PR by default. When the branch merges cleanly into
   the target and the changed-path intersection with the target delta is
   empty, open the PR from the current base; CI verifies the merge result.
2. When a rebase is genuinely required, prove equivalence deterministically:
   range-diff all `=`, byte-identical aggregate diffs, empty changed-path
   intersection. That proof carries every prior verdict and evidence manifest
   forward. Do not relaunch checkers or verifiers over a proven-equivalent
   rebase; the rebase node's own single criterion rerun is the maximum.
