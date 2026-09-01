# 🔁 Controlled live cutover

Use this procedure to update an existing machine. For a fresh machine, use
`npm run bootstrap`.

> [!IMPORTANT]
> Do not continue while an advisor or worker uses the current setup.

## 1️⃣ Prepare

1. Settle all advisor and worker sessions.
2. Rotate any credential that was exposed before this cutover.
3. Pull the reviewed harness revision.
4. Run `npm ci` and `npm test`.
5. Run `node scripts/meta-harness.mjs verify-git-pins` to confirm every exact
   Git package commit is publicly fetchable. This is an explicit bounded
   network check, not part of normal offline unit tests.

## 2️⃣ Install

1. Run `node scripts/meta-harness.mjs plan --live` and review every target.
2. Run `node scripts/meta-harness.mjs install --live`.

   This migration replaces the legacy mixed `bg-agent-profiles.json` with
   fixed role-only configuration, refreshes named intelligence guides,
   preserves the selected `intelligence-profiles/ACTIVE` name, and
   materializes it separately as `advisor-intelligence.json`.
3. Run `pi update --extensions` to install the configured package sources.
   npm packages advance within compatible caret ranges; Git packages remain at
   their reviewed full commits.
4. Run `node scripts/meta-harness.mjs install-skills --live` to restore the
   exact-commit third-party skills. It promotes verified copies into the
   single canonical `~/.agents/skills` root, removes duplicate Pi-specific
   copies and superseded skill names, and releases those entries from the
   generic skill updater; change them through the harness manifests instead.
5. Run `node scripts/meta-harness.mjs install-herdr-config --live`.
6. Run `node scripts/meta-harness.mjs install-herdr-integration --live`.

## 3️⃣ Validate

1. Run `node scripts/meta-harness.mjs doctor --live`.
2. Restart Pi or use `/reload` only after doctor passes.
3. Confirm `node ~/.pi/agent/bin/intelligence-profile.mjs --list` reports the
    intended active guide and preferred recommendations.
4. Start a fresh advisor workstream and run one bounded, read-only task that
    exercises worker transport. Let the advisor choose the task-fit role, and
    record a concise rationale if its identity is outside the active guide.
5. Keep both installer backups until a real workstream completes.

## 🩹 If something reports a mismatch

If doctor or install reports an ACTIVE/live mismatch, do not choose either
side implicitly. Run
`node ~/.pi/agent/bin/intelligence-profile.mjs <intended-name>` to perform the
explicit repair, then rerun doctor. For other validation failures, use the
named backup. Do not repair managed live files by hand because that creates
new drift from the repository source.
