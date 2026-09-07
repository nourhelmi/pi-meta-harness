import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { inspectInstallation } from './install.mjs';
import { fields } from './contract.mjs';
import { demand, safeFile, disjointControlPath, RuntimeError } from './security.mjs';
import { permissionConfig, configArgs, managedProviderHomes, assertPermissionConfig, providerEnvironment } from './native-boundary.mjs';
import { codexIsolatedConfig, codexVersion, CodexWire } from './adapters/codex.mjs';
import { NATIVE_LIMITS, ROOT_DOCTRINE, environment } from './adapters/common.mjs';
import { CLAUDE_CLI_VERSION } from './adapters/claude.mjs';

/** Explicit installed CLI root. No arbitrary argv, credentials or profile input. */
export function entryPlan(host, project, bootstrapPath) {
  demand(['codex', 'claude-code'].includes(host), 'ENTRY_HOST_UNSUPPORTED');
  safeFile(bootstrapPath); const text = readFileSync(bootstrapPath, 'utf8'); demand(text.length <= 65536, 'BOOTSTRAP_BOUND');
  let config; try { config = JSON.parse(text); } catch { throw new RuntimeError('INVALID_BOOTSTRAP'); }
  fields(config, ['stateRoot', 'allowedRoots', 'principals'], ['providerHomes']);
  const cwd = realpathSync(project); disjointControlPath(cwd, [...config.allowedRoots, config.stateRoot]);
  const homes = managedProviderHomes(config.stateRoot, [...config.allowedRoots, cwd], config.providerHomes);
  const registrations = config.principals.filter(v => v.principal.kind === 'advisor'); demand(registrations.length === 1, 'ENTRY_PRINCIPAL_BINDING');
  const { mcp } = inspectInstallation(host, cwd, registrations[0].credentialPath);
  const source = environment(); const home = homes[host];
  const controls = [config.stateRoot, bootstrapPath, ...config.principals.map(v => v.credentialPath), ...Object.values(homes)];
  for (const path of controls) disjointControlPath(path, [...config.allowedRoots, cwd]);
  const boundary = providerEnvironment(host, { PATH: source.PATH, LANG: source.LANG ?? 'en_US.UTF-8', HOME: home, [host === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: home }, cwd, join(config.stateRoot, 'runs'), controls);
  if (host === 'codex') {
    codexIsolatedConfig(home, cwd, { ownedEntryProject: true });
    const nativeConfig = { ...permissionConfig(cwd, boundary.controls, config.allowedRoots), projects: { [cwd]: { trust_level: 'trusted' } }, approval_policy: 'never', mcp_servers: { advisor_runtime: { ...mcp, environment_id: 'local', enabled: true, required: true, startup_timeout_sec: 8, tool_timeout_sec: 15 } } };
    // The interactive CLI selects the attested default_permissions config; -P is sandbox-only.
    return { host, command: 'codex', cwd, env: boundary.env, config: nativeConfig, args: [...configArgs(nativeConfig), '--ask-for-approval', 'never', '--cd', cwd, ROOT_DOCTRINE] };
  }
  const settings = { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: process.execPath, args: [fileURLToPath(new URL('./native-hook.mjs', import.meta.url)), cwd, JSON.stringify(config.allowedRoots)], timeout: 10 }] }] } };
  return { host, command: 'claude', cwd, env: boundary.env, args: ['--setting-sources', '', '--settings', JSON.stringify(settings), '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { advisor_runtime: { type: 'stdio', ...mcp } } }), '--tools', 'Read,Glob,Grep,AskUserQuestion', ...config.allowedRoots.flatMap(path => ['--add-dir', path]), '--permission-mode', 'default', '--append-system-prompt', ROOT_DOCTRINE] };
}

/** Public initialize/config/read only. This function never opens a thread/turn. */
export async function verifyCodexConfiguration(config, { cwd, env, spawnProcess = spawn }) {
  codexVersion(env);
  const child = spawnProcess('codex', ['app-server', '--stdio', '--strict-config', ...configArgs(config)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let bytes = 0;
  const session = { limits: NATIVE_LIMITS, failed: false,
    count(value) { bytes += Buffer.byteLength(value); demand(bytes <= NATIVE_LIMITS.bytes, 'NATIVE_OUTPUT_BOUND'); },
    fail() { this.failed = true; child.kill('SIGTERM'); },
    guarded(fn) { try { return fn(); } catch { this.fail(); } }, exited() {} };
  const wire = new CodexWire(child, session); wire.onMessage = message => {
    demand(message.method === 'remoteControl/status/changed' && message.params?.status === 'disabled', 'UNEXPECTED_PREFLIGHT_EVENT');
  };
  try {
    const init = await wire.request('initialize', { clientInfo: { name: 'advisor-entry-preflight', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    demand(init.userAgent?.includes('0.153.4'), 'CODEX_HANDSHAKE_VERSION'); wire.send({ method: 'initialized' });
    const response = await wire.request('config/read', { includeLayers: false, cwd }); assertPermissionConfig(response.config, config);
    demand(!session.failed, 'CODEX_PREFLIGHT_FAILED'); return { permissions: config.default_permissions, checked: true };
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.kill('SIGTERM'); try { await exited; } finally { clearTimeout(timer); }
    }
  }
}
export function verifyClaudeEntryVersion(plan, probe = spawnSync) {
  const version = probe('claude', ['--version'], { env: plan.env, cwd: plan.cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  demand(version.status === 0 && version.stdout.trim() === `${CLAUDE_CLI_VERSION} (Claude Code)`, 'CLAUDE_CLI_ENTRY_VERSION_UNSUPPORTED');
  return CLAUDE_CLI_VERSION;
}
export async function enter(host, project, bootstrapPath) {
  const plan = entryPlan(host, project, bootstrapPath);
  if (host === 'codex') await verifyCodexConfiguration(plan.config, plan);
  else verifyClaudeEntryVersion(plan);
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'inherit' });
  const [code, signal] = await once(child, 'exit'); demand(signal === null && code === 0, 'NATIVE_ENTRY_EXIT');
  return { exited: true };
}
