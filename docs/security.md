# Security and portability boundary

This repository is designed for public access. Treat every tracked file as public data.

## Allowed content

The repository can contain:

- first-party TypeScript extensions and skills;
- model names, reasoning levels, tool restrictions, and prompt-cycle caps;
- safe Pi settings and exact package versions or Git commits;
- MCP command definitions that use environment placeholders;
- third-party source URLs, licenses, versions, revisions, and content hashes;
- installer, validation, CI, and documentation files;
- reviewed Herdr theme, keybinding, UI, and notification assets.

## Forbidden content

Never add:

- `auth.json`, provider tokens, OAuth data, API keys, or filled `.env` files;
- private keys, browser profiles, cookies, or session cookies;
- Pi sessions, run transcripts, detach logs, or Taskplane state;
- machine trust decisions;
- `.advisor/` sessions, workstreams, events, runs, graphs, or locks;
- model catalogs, MCP caches, generated caches, or update notices;
- Engram databases, memories, or cloud credentials;
- intercom sockets, PIDs, mailboxes, or routine scheduler state;
- Herdr sessions, logs, sockets, release notices, integration output, or backups;
- `node_modules`, installed package clones, or platform binaries.

The doctor scans tracked and nonignored release-candidate files for forbidden paths, file names, and common credential patterns. CI also runs Gitleaks. These checks reduce risk; they do not replace review.

## Public history

Scan every ref, not only the working tree, before a visibility change. A deletion commit does not remove old paths from Git history. When private development history contains machine paths or retired vendored source, keep that repository private and publish a fresh reviewed history to the public repository.

## Credential handling

[`config/mcp.json`](../config/mcp.json) contains variable placeholders only. Export real values from a shell profile or secret manager. Do not write them into this repository.

If a value appears in a model transcript or command output, treat it as disclosed and rotate it. Deleting the visible text is not sufficient because logs and provider history can retain it.

Authentication stays local:

1. install Pi and Claude Code;
2. run the harness bootstrap;
3. start Pi inside Herdr;
4. use `/login` for each Pi provider;
5. log in to Claude Code through its supported local flow.

The harness does not create fallback credentials or copy authentication from another machine.

## Third-party code

Third-party Pi packages are installed by exact package version or full Git commit. They are not vendored, except for `extensions/unified-edit.ts`.

`unified-edit.ts` is a narrow reviewed snapshot. Installing its full upstream repository previously introduced an unnecessary dependency tree with security findings. The tracked file imports only Pi and Node APIs. Its upstream revision, Apache-2.0 license, and content hash are recorded in [`config/third-party-extensions.lock.json`](../config/third-party-extensions.lock.json).

Third-party skills are installed from full source commits. The installer verifies the Git tree before it invokes the pinned skills CLI with copy mode, then checks every installed folder against the recorded SHA-256 hash. Updating a skill requires a reviewed commit, tree, and hash change.

`pi-detach` is first-party MIT source in its own public repository. This harness installs it from a full commit.

`pi-ui-pack`, `pi-codex-compaction`, `pi-mermaid`, and `pi-web-search` are installed from the exact sources recorded in the extension lock. OpenAI compaction can create provider-side compaction artifacts and local session metadata; it does not make session data portable through this repository. Web search sends queries to the active model provider's native search API and stores nothing in this repository.
