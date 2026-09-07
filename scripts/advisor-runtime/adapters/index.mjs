import { fileURLToPath } from 'node:url';
import { createCodexAdapter } from './codex.mjs';
import { createClaudeAdapter } from './claude.mjs';
import { demand } from '../security.mjs';
import { environment } from './common.mjs';

/** Principal bindings originate only in private operator bootstrap, never in a model command. */
export function createNativeAdapters(registrations, seams = {}, { providerHomes } = {}) {
  const providerEnv = host => {
    const source = environment();
    if (!providerHomes) return source; // direct trusted factory callers still undergo pre-launch validation
    const home = providerHomes[host];
    return { PATH: source.PATH, LANG: source.LANG ?? 'en_US.UTF-8', HOME: home, [host === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: home };
  };
  const binding = scope => {
    const matches = registrations.filter(({ principal }) => principal.kind === 'advisor' && principal.scopes.some(g => g.workstream === scope.workstream && g.run === scope.run && g.node === 'root'));
    demand(matches.length === 1, 'ROOT_PRINCIPAL_BINDING_REQUIRED');
    const registration = matches[0];
    demand(registration.principal.operations.includes('node.launch') && registration.principal.operations.includes('wait'), 'ROOT_FLEET_GRANTS_REQUIRED');
    return { command: process.execPath, args: [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'mcp-env'], env: { ADVISOR_RUNTIME_DESCRIPTOR_PATH: registration.credentialPath } };
  };
  const codex = createCodexAdapter({ env: providerEnv('codex'), ...seams.codex, mcpFor: scope => ({ advisor_runtime: { ...binding(scope), environment_id: 'local', enabled: true, required: true, startup_timeout_sec: 8, tool_timeout_sec: 15 } }) });
  const claude = createClaudeAdapter({ env: providerEnv('claude-code'), ...seams.claude, mcpFor: scope => ({ advisor_runtime: { type: 'stdio', ...binding(scope) } }) });
  return { roots: { codex, 'claude-code': claude }, workers: { codex, 'claude-code': claude } };
}
