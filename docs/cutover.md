# Controlled live cutover

Use this procedure to update an existing machine. For a fresh machine, use `npm run bootstrap`.

Do not continue while an advisor or worker uses the current setup.

1. Settle all advisor and worker sessions.
2. Rotate any credential that was exposed before this cutover.
3. Pull the reviewed harness revision.
4. Run `npm ci` and `npm test`.
5. Run `node scripts/meta-harness.mjs plan --live` and review every target.
6. Run `node scripts/meta-harness.mjs install --live`.
7. Run `pi update --extensions` to install the exact package sources.
8. Run `node scripts/meta-harness.mjs install-skills --live` to restore the exact pinned third-party skills. It promotes verified copies into the single canonical `~/.agents/skills` root, removes duplicate Pi-specific copies, and releases those entries from the generic skill updater; change them through the harness pin manifests instead.
9. Run `node scripts/meta-harness.mjs install-herdr-config --live`.
10. Run `node scripts/meta-harness.mjs install-herdr-integration --live`.
11. Run `node scripts/meta-harness.mjs doctor --live`.
12. Restart Pi or use `/reload` only after doctor passes.
13. Start a fresh advisor workstream and launch one bounded Scout.
14. Keep both installer backups until a real workstream completes.

If validation fails, use the named backup. Do not repair managed live files by hand because that creates new drift from the repository source.
