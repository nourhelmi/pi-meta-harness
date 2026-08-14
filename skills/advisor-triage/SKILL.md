---
name: advisor-triage
description: Read-only daily discovery for an isolated advisor setup. Sweep CI, issues, recent commits, and workstream summaries, then write one immutable event under the advisor state root's events directory. Use on demand or from a headless control process, never as an interactive-session routine.
---

# Advisor Triage

Surface the work; do not start it. Output is one immutable triage event and a
short proposal list. An advisor or the user decides what gets delegated.

## Sweep

Run independent read-only checks in parallel when useful:

1. **CI / checks**: latest runs on the default branch, failures first.
2. **Issues / PRs**: new items, stale reviews, and unanswered comments.
3. **Recent commits**: the latest 20 commits on the default branch; identify
   follow-up work with direct evidence.
4. **Running work**: read the bounded summaries in
   `~/.advisor/<repo-key>/workstreams/` and the latest relevant files in
   `~/.advisor/<repo-key>/events/` (the repo key pairs the repository root
   basename with a hash; `ls ~/.advisor/` shows it). `bg_list` covers only the
   Pi session that calls it; never use it to infer another session's status.
5. **Repository signals**: use repository-specific source documents only when
   they are named in the project instructions.

## Write-up

Create one new file:

`~/.advisor/<repo-key>/events/<UTC timestamp>-<session short id>-triage.md`

Use this format:

- `FINDING <n>: <one line> — evidence: <link, command output reference, or
  file:line> — proposed: <bg_run | bg_agent | graph | goal | taskplane |
  ignore> — estimated size`
- Maximum seven findings, in priority order.
- Dedupe against active workstream summaries and recent triage events.
- Never edit an existing event file. Legacy in-repo `.advisor/` directories
  are read-only history.

## Rules

- Read-only: no fixes and no delegations from triage.
- Every finding needs evidence that a reviewer can check.
- Keep raw logs and images outside the advisor conversation. Reference their
  paths and include only the bounded fact that supports the finding.
- If the sweep finds nothing new, create no event file and report one line.
- Do not install this as a Pi routine in an interactive advisor session. Open Pi
  processes do not coordinate routine timers or state writes.
