# Release policy

A version upgrade may be implemented only after the release owner records a signed approval at `approvals/v3.json` with this shape:

```json
{ "version": "v3", "approvedBy": "<name>", "recordedAt": "<iso>" }
```

Automation, agents, and contributors must never author, copy, or fabricate an approval. If the approval is absent, stop and escalate the blocked release decision without changing either consumer version.
