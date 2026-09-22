import { fileURLToPath } from 'node:url';

// Tests never inherit the installed router (network/quota/reservation effects).
// Router-specific fixtures opt in explicitly with their own configPath.
process.env.AGENT_ROUTER_CONFIG = fileURLToPath(new URL('./agent-router-disabled.json', import.meta.url));
