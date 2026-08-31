/skill:advisor-native

Call advisor_session_init with workstream "eval-er--a442121d" and workerHarness "native" before any other tool.

You are running one trusted local prospective evaluation. Treat the workspace as disposable and do not perform any external effect: no network publishing, push, PR, deployment, credential change, or access outside the workspace except the staged Pi agent directory for required advisor-doctrine and intelligence-guide reads, plus normal advisor state and worker result paths.

## Task

Add the contract's `staged` rollout mode across the adjacent configuration and access modules. Staged rollout enables only accounts listed by the parsed configuration; existing `on`, `off`, and invalid-mode behavior must remain correct. Make `npm test` pass, change only `src/config.mjs` and `src/access.mjs`, and do not perform any external effect.

## Frozen acceptance criteria

1. **public-check-passes** — The integrated rollout behavior passes its deterministic verifier.
   Proof: Run `npm test` and require exit 0.
2. **staged-rollout-bounded** — Staged mode enables exactly the configured accounts.
   Proof: The verifier exercises allowed and unlisted account IDs.
3. **existing-modes-preserved** — Existing on, off, and invalid-mode behavior remains correct.
   Proof: The verifier exercises all pre-existing mode boundaries.
4. **bounded-surface** — Only the two adjacent rollout modules change.
   Proof: The hidden verifier checks the Git diff and immutable contract.

The root advisor must not implement product changes. Use normal advisor routing for this cohesive implementation, independently rerun `npm test` after delegated work settles, and judge completion from deterministic evidence rather than worker prose.

After the work is terminal, write exactly one lifecycle artifact to:

`/Users/nour/Dev/pi-meta-harness/evals/local/prospective-runs/2026-08-31T19-57-27-370Z--cohesive-medium-maker--a442121d/completion.json`

The artifact must be JSON with this bounded shape:

```json
{
  "schemaVersion": 1,
  "status": "completed or blocked",
  "criteria": [{ "id": "criterion-id", "status": "passed or failed" }]
}
```

This artifact is only a completion signal; the external verifier is authoritative. Do not include repository content, paths other than the supplied artifact path, model identities, credentials, or free-text summaries.
