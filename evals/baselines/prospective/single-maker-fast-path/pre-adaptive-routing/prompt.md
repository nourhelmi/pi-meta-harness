/skill:advisor-native

Call advisor_session_init with workstream "eval-th--1dfedc15" and workerHarness "native" before any other tool.

You are running one trusted local prospective evaluation. Treat the workspace as disposable and do not perform any external effect: no network publishing, push, PR, deployment, credential change, or access outside the workspace except the staged Pi agent directory for required advisor-doctrine and intelligence-guide reads, plus normal advisor state and worker result paths.

## Task

The local retry configuration no longer matches `contract.json`. Diagnose and repair the mismatch so `npm test` passes. Preserve the contract and package metadata, change only `settings.json`, and do not perform any external effect.

## Frozen acceptance criteria

1. **public-check-passes** — The retry configuration passes its deterministic verifier.
   Proof: Run `npm test` and require exit 0.
2. **retry-limit-aligned** — The configured retry limit exactly matches the local contract.
   Proof: The verifier compares `settings.json` with `contract.json`.
3. **contract-preserved** — The contract remains unchanged.
   Proof: The hidden verifier checks the committed contract value and Git diff.
4. **bounded-surface** — Only `settings.json` changes.
   Proof: The hidden verifier checks `git diff --name-only HEAD`.

The root advisor must not implement product changes. Use normal advisor routing for the bounded task, independently rerun `npm test` after delegated work settles, and judge completion from deterministic evidence rather than worker prose.

After the work is terminal, write exactly one lifecycle artifact to:

`/Users/nour/Dev/pi-meta-harness/evals/local/prospective-runs/2026-08-31T19-50-54-721Z--single-maker-fast-path--1dfedc15/completion.json`

The artifact must be JSON with this bounded shape:

```json
{
  "schemaVersion": 1,
  "status": "completed or blocked",
  "criteria": [{ "id": "criterion-id", "status": "passed or failed" }]
}
```

This artifact is only a completion signal; the external verifier is authoritative. Do not include repository content, paths other than the supplied artifact path, model identities, credentials, or free-text summaries.
