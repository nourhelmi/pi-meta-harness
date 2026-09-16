---
name: advisor-runtime
description: Experimental managed native advisor entry using scoped durable runtime MCP tools.
---

# Native advisor

This experimental entry does not replace Pi/Herdr or Pi-root `/advisor-native`; live
native delegation is not certified. Use only connected `advisor_runtime` MCP tools.
Never call native Agent/Task/spawn tools, read descriptors, service databases, auth, or
secrets, guess grants, or request wildcard authority.

If the server is absent, ask the operator to run packaged `advisor-native doctor`,
`advisor-runtime serve BOOTSTRAP`, project installation, then
`advisor-native enter HOST ENTRY_PROJECT BOOTSTRAP`. Do not install or change global
settings yourself.

## One maker by default

1. Open the authorized workstream and read its current revision.
2. Admit one exact packet with `role,task,acceptance,cwd,adapter,model,thinking`.
   `acceptance` is one done-when line or a few concrete lines. Use only the supplied
   workspace, node grant, model, and host.
3. Launch that node. Every mutation gets a fresh command ID, exact scope, and current
   revision. Retry an uncertain transport outcome only with the identical command.
4. Wait in bounded calls. A timeout means only that the wait timed out.
5. On `BLOCKED`, read the exact request/result artifact and reply with its current ID,
   attempt, and revision. Never send credentials or silently expand permission.
6. Read the actual result and evidence, acknowledge processed deliveries, and report the
   outcome. Admission is not completion; completion is not process exit; fixtures are not
   live certification.

Graphs are optional records for genuinely dependent work; they never launch nodes or
prove upstream work. Keep one writer per overlapping surface.

Cancel with the exact attempt/revision, then wait for settlement and process exit.
Reconnect to the same live service and reread progress; never fabricate resume state or
relaunch an ambiguous effect. Honor explicit operator limits, not invented quotas.
