/skill:advisor-native

Call advisor_session_init with workstream "eval-er--296c0d6f" and workerHarness "native" before any other tool.

You are running one trusted local prospective evaluation. Treat the workspace as disposable and do not perform any external effect: no network publishing, push, PR, deployment, credential change, or access outside the workspace except the staged Pi agent directory for required advisor-doctrine and intelligence-guide reads, plus normal advisor state and worker result paths.

## Task

The local tenant authorization predicate is too permissive. Repair `authorize.mjs` so reads require a present requesting tenant and user, a present resource tenant and owner, and an exact match on both boundaries. Preserve the local contract and package metadata, change only `authorize.mjs`, make `npm test` pass, and do not access any external system or credential.

## Frozen acceptance criteria

1. **public-check-passes** — The authorization contract passes its deterministic verifier.
   Proof: Run `npm test` and require exit 0.
2. **cross-tenant-denied** — Matching ownership never permits a cross-tenant read.
   Proof: The verifier exercises a same-owner cross-tenant request.
3. **wrong-owner-denied** — Matching tenancy never permits another owner's resource.
   Proof: The verifier exercises a same-tenant wrong-owner request.
4. **missing-identity-denied** — Missing request or resource identity fields fail closed.
   Proof: The verifier exercises missing identity inputs.
5. **bounded-surface** — Only the authorization predicate changes.
   Proof: The hidden verifier checks the Git diff and immutable contract.

The root advisor must not implement product changes. Use normal advisor routing for this security-sensitive authorization repair, independently rerun `npm test` after delegated work settles, and judge completion from deterministic evidence rather than worker prose.

After the work is terminal, write exactly one lifecycle artifact to:

`/Users/nour/Dev/pi-meta-harness/evals/local/prospective-runs/2026-08-31T20-04-19-790Z--risk-triggered-checker--296c0d6f/completion.json`

The artifact must be JSON with this bounded shape:

```json
{
  "schemaVersion": 1,
  "status": "completed or blocked",
  "criteria": [{ "id": "criterion-id", "status": "passed or failed" }]
}
```

This artifact is only a completion signal; the external verifier is authoritative. Do not include repository content, paths other than the supplied artifact path, model identities, credentials, or free-text summaries.
