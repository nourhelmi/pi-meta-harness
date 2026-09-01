#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for command in engram git node npm pi herdr claude; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command is not available: %s\n' "$command" >&2
    exit 1
  fi
done

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) { console.error(`Node 22.19+ is required; found ${process.version}`); process.exit(1); }'

printf '\n==> Install and verify the harness\n'
npm ci
npm test

printf '\n==> Install the browser verifier CLI and browser\n'
npm install --global 'agent-browser@^0.36.0'
agent-browser install

printf '\n==> Review the live install plan\n'
node scripts/meta-harness.mjs plan --live

printf '\n==> Install Pi configuration and managed package sources\n'
node scripts/meta-harness.mjs install --live
pi update --extensions

printf '\n==> Install the selected third-party skills\n'
node scripts/meta-harness.mjs install-skills --live

printf '\n==> Install Herdr configuration and regenerate its Pi integration\n'
node scripts/meta-harness.mjs install-herdr-config --live
node scripts/meta-harness.mjs install-herdr-integration --live

printf '\n==> Verify the installed setup\n'
node scripts/meta-harness.mjs doctor --live

cat <<'EOF'

Bootstrap passed.

Credentials and sessions were not copied. Complete these local steps:
1. Export the optional MCP variables from .env.example through your shell or secret manager.
2. Start a fresh Pi session inside Herdr and use /login for each provider.
3. Confirm Claude Code authentication.
4. Run /advisor to start an isolated workstream.
EOF
