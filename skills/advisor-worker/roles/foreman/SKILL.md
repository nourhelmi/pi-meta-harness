---
name: advisor-role-foreman
description: Legacy foreman skill path; new managed work uses the advisor role.
disable-model-invocation: true
---

# Legacy foreman

Use [the scoped child-advisor contract](../advisor/SKILL.md) for new work via
`bg_agent` with `role: "advisor"`. This compatibility path does not upgrade an
old runtime grant, rename historical results, or authorize a top-level advisor
initialization. Existing unmetered/v1 scopes require an explicitly reissued
scope before new execution.
