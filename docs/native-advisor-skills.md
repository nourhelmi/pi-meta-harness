# Native advisor skills

Use the advisor method without our managed runtime: native Codex and Claude Code provide the tools; the skills provide ownership, role, review and model-routing guidance. Herdr is not required.

```sh
node scripts/install-native-skills.mjs
```

Start a fresh native conversation and ask: **“Use the advisor skill for this task: …”**. Claude Code also exposes `/advisor`; Codex supports explicit skill invocation with `$advisor`. Native host feature availability and permissions still apply.

The installer copies nine skills (advisor, intelligence and seven roles) into `~/.local/share/pi-meta-harness/native-skills`, copies the canonical intelligence presets, and links them into `~/.codex/skills` and `~/.claude/skills`. Rerun to update. It refuses conflicting user-owned skill paths. Caught installation failures restore the previous bundle; this is not crash-atomic or concurrent-installer support. Do not run two installers together.

| Entry | Execution |
| --- | --- |
| Native `advisor` | Host tools; direct work or useful native delegation. No mandatory graph. |
| Native `meta-harness` | Existing managed MCP/runtime lane, with its supported transport requirements. |
| Pi `advisor` | Existing Pi advisor entry and managed tooling, unchanged. |

Role skills are instructions supplied to available native agents, not newly registered agent types. An unavailable delegation tool or model cannot be added by prose. Required independent review remains outstanding if the host cannot supply it. Current Pi intelligence selection is reused read-only when present; otherwise the bundled balanced guide is the fallback. Only the selected guide is loaded. Native model identifiers and effort controls must actually exist in that host.

This installation does not change native MCP registrations, permissions, settings, Pi skills or the active profile. It does not add background replay/delivery guarantees to native tools. The advisor and workers load relevant instructions on demand rather than preloading every role after compaction.
