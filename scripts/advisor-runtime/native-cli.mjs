#!/usr/bin/env node
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectInstall } from './install.mjs';
import { codexVersion, CODEX_VERSION } from './adapters/codex.mjs';
import { loadClaude, CLAUDE_SDK_VERSION, CLAUDE_CLI_VERSION } from './adapters/claude.mjs';
import { environment } from './adapters/common.mjs';
import { demand, disjointControlPath, privateDirectory, RuntimeError, within } from './security.mjs';
import { OPERATIONS } from './contract.mjs';
import { managedProviderHomes } from './native-boundary.mjs';
import { entryPlan, enter } from './native-entry.mjs';

export async function doctor() {
  const issues = []; let codex = null; let claude = null;
  if (Number(process.versions.node.split('.')[0]) < 24) issues.push('Install Node >=24 (tested: 24.18.0).');
  try { codex = codexVersion(environment()); } catch { issues.push(`Install Codex CLI ${CODEX_VERSION} on PATH; Codex App attachment is unsupported.`); }
  try { const sdk = await loadClaude(); claude = { sdk: sdk.version, bundledCli: sdk.cliVersion }; } catch { issues.push(`Install optional @anthropic-ai/claude-agent-sdk@${CLAUDE_SDK_VERSION} in this package prefix; it uses bundled CLI ${CLAUDE_CLI_VERSION}, not a standalone claude binary.`); }
  issues.push('Use explicit managed provider homes from bootstrap.json; authenticate them out of band without copying credentials. Live host certification is separate from configured boundaries.');
  return { node: process.versions.node, platform: process.platform, arch: process.arch, codex, claude,
    capabilities: { liveCertified: false, codexReadBoundary: 'pinned named filesystem profiles; effective-config preflight', claudeReadBoundary: 'all-invocation PreToolUse over explicit file tools',
      codexAppAttachment: false, storedSessionResume: false, liveServiceReconnect: true, permissionExpansion: false, nodeLaunch: true }, issues };
}
export function bootstrap(state, workspace, host) {
  demand(['codex', 'claude-code'].includes(host), 'UNSUPPORTED_HOST');
  const cwd = realpathSync(workspace); const stateRoot = resolve(state); demand(!within(cwd, stateRoot) && !within(stateRoot, cwd), 'STATE_WORKSPACE_OVERLAP');
  disjointControlPath(stateRoot, [cwd]);
  const providerHomes = managedProviderHomes(stateRoot, [cwd]);
  privateDirectory(stateRoot);
  const path = join(stateRoot, 'bootstrap.json'); demand(!existsSync(path), 'BOOTSTRAP_EXISTS');
  const scopes = ['root', 'maker'].map(node => ({ workstream: 'work', run: 'run', node }));
  const config = { stateRoot, allowedRoots: [cwd], providerHomes, principals: [
    { principal: { id: 'operator', kind: 'operator', scopes, operations: OPERATIONS }, credentialPath: join(stateRoot, 'operator.json') },
    { principal: { id: 'native-advisor', kind: 'advisor', scopes, operations: OPERATIONS.filter(op => !op.startsWith('root.')) }, credentialPath: join(stateRoot, 'advisor.json') },
  ] };
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
  const create = { v: 1, op: 'workstream.create', commandId: 'create-run', expectedRevision: 0, scope: { ...scopes[0], ownerEpoch: 1 }, payload: { cwd, host } };
  writeFileSync(join(stateRoot, 'create-run.json'), JSON.stringify(create), { mode: 0o600, flag: 'wx' });
  return { bootstrap: path, createCommand: join(stateRoot, 'create-run.json'), scope: { ...scopes[0], ownerEpoch: 1 }, workerNode: 'maker', host };
}
export async function main(argv) {
  const [mode, ...args] = argv;
  if (mode === 'doctor') { demand(args.length === 0, 'DOCTOR_USAGE'); return doctor(); }
  demand(Number(process.versions.node.split('.')[0]) >= 24, 'NODE_24_REQUIRED');
  if (mode === 'init') { demand(args.length === 3, 'INIT_STATE_WORKSPACE_HOST'); return bootstrap(...args); }
  if (['install', 'uninstall', 'restore'].includes(mode)) {
    demand(args.length === (mode === 'install' ? 3 : 2), 'INSTALL_HOST_PROJECT_DESCRIPTOR'); return projectInstall(mode, ...args);
  }
  if (mode === 'entry-plan' || mode === 'enter') { demand(args.length === 3, 'ENTRY_HOST_PROJECT_BOOTSTRAP'); return mode === 'entry-plan' ? entryPlan(...args) : enter(...args); }
  if (mode === 'help') return { commands: ['doctor', 'init STATE WORKSPACE HOST', 'install HOST PROJECT DESCRIPTOR', 'uninstall HOST PROJECT', 'restore HOST PROJECT', 'entry-plan HOST PROJECT BOOTSTRAP', 'enter HOST PROJECT BOOTSTRAP'], guide: new URL('../../docs/advisor-native.md', import.meta.url).pathname };
  throw new RuntimeError('NATIVE_USAGE');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main(process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => { process.stderr.write((error instanceof RuntimeError ? error.code : 'NATIVE_ERROR') + '\n'); process.exitCode = 1; });
