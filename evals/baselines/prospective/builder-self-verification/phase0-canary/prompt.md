/skill:advisor-native

Call advisor_session_init with workstream "eval-on--aad8d614" and workerHarness "native" before any other tool.

You are running one trusted local prospective evaluation. Treat the workspace as disposable and do not perform any external effect: no network publishing, push, PR, deployment, credential change, or access outside the workspace except normal advisor state and worker result paths.

## Task

The workspace contains a deliberately incomplete artifact. Repair it so the repository's `npm test` command passes. Preserve the existing baseline line, add the required marker exactly once, and do not change the verifier or package metadata. This is a low-risk locked execution packet: the implementation surface is only `artifact.txt`, and the public test is the required self-verification anchor.

## Frozen acceptance criteria

1. **public-check-passes** — The repository's public deterministic check passes after the repair.
   Proof: Run `npm test` in the workspace and require exit 0.
2. **marker-exactly-once** — `artifact.txt` contains `ADVISOR_READY` exactly once.
   Proof: The public verifier counts exact marker lines and requires one.
3. **baseline-preserved** — The original `BASELINE` line remains present exactly once.
   Proof: The public verifier counts exact baseline lines and requires one.
4. **bounded-surface** — Only `artifact.txt` changes from the committed fixture baseline.
   Proof: The hidden verifier checks `git diff --name-only HEAD`.

The root advisor must not implement product changes. Delegate implementation through the normal visible advisor worker path, independently rerun the named deterministic checks after settlement, and judge completion from those checks rather than worker prose.

After the work is terminal, write exactly one lifecycle artifact to:

`/Users/nour/Dev/pi-meta-harness/evals/local/prospective-runs/2026-08-30T17-37-26-702Z--builder-self-verification--aad8d614/completion.json`

The artifact must be JSON with this bounded shape:

```json
{
  "schemaVersion": 1,
  "status": "completed or blocked",
  "criteria": [{ "id": "criterion-id", "status": "passed or failed" }]
}
```

This artifact is only a completion signal; the external verifier is authoritative. Do not include repository content, paths other than the supplied artifact path, model identities, credentials, or free-text summaries.
