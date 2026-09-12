import { createHash } from 'node:crypto';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { AdvisorRuntime } from './runtime.mjs';
import { startService, readStoredCredential, writeCredential } from './service.mjs';
import { createPiDetachAdapter } from './adapters/pi-detach.mjs';
import { closeChildServices, installedRevision, workspaceRoots } from './pi-detach-bootstrap.mjs';
import { demand, privateDirectory } from './security.mjs';
import { familyCall, readChildGrant } from './child-scope.mjs';

/** Trusted bootstrap only; no per-task packet files and no provider launch here. */
export async function hostPiDetach({ stateRoot, cwd, sessionId, credentialPath, port, slots = 16, managedIdentity = null, maxLaunches = 256, revision = null, keepAlive = true }) {
  demand(Number(process.versions.node.split('.')[0]) >= 24, 'NODE_24_REQUIRED');
  demand(typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 256, 'PI_SESSION_REQUIRED');
  demand(Number.isInteger(slots) && slots >= 1 && slots <= 32, 'BRIDGE_POOL_BOUNDS');
  demand(Number.isInteger(maxLaunches) && maxLaunches >= 1 && maxLaunches <= 256, 'BRIDGE_LAUNCH_BOUND');
  demand(revision === null || (typeof revision === 'string' && /^[0-9a-f]{32}$/.test(revision)), 'BRIDGE_REVISION');
  const rootHost = managedIdentity?.rootHost ?? 'pi';
  demand(['pi', 'codex', 'claude-code'].includes(rootHost), 'UNSUPPORTED_HOST');
  const prefix = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  const scopes = Array.from({ length: managedIdentity ? 1 : slots }, (_, i) => ({ workstream: `pi-${prefix}`, run: `pib-${prefix}-${i}`, node: 'root', ownerEpoch: 1 }));
  const principal = { id: `pi-${prefix}`, kind: 'advisor', scopes: scopes.flatMap(({ ownerEpoch: _ownerEpoch, ...scope }) => [scope, { ...scope, node: 'worker' }]), operations: ['workstream.create', 'packet.admit', 'node.launch', 'node.reply', 'node.task', 'node.cancel', 'progress', 'wait', 'delivery.ack', 'artifact.read', 'log.read', 'team.status', 'team.enlist', 'team.rename', 'team.context', 'team.assign', 'team.message', 'team.retire'] };
  const adapter = createPiDetachAdapter(port);
  const canonicalCwd = realpathSync(cwd);
  const childGrant = existsSync(`${stateRoot}/child-grant.json`) ? readChildGrant(stateRoot, canonicalCwd) : null;
  demand(!managedIdentity?.childState || childGrant, 'PI_DETACH_CHILD_GRANT_MISMATCH');
  const allowedRoots = childGrant?.v === 2 ? childGrant.allowedRoots : managedIdentity ? workspaceRoots(cwd) : [canonicalCwd];
  if (childGrant?.v === 2) await familyCall(childGrant, 'bind', { grant: childGrant, sessionId, workstream: scopes[0].workstream });
  const runtime = new AdvisorRuntime({ stateRoot, allowedRoots, controlPaths: [credentialPath],
    adapters: { roots: {}, workers: { 'pi-detach': adapter } },
    piBridge: { version: 1, portVersion: port.version, principalId: principal.id, sessionId, scopes, cwd: canonicalCwd, prepare: port.prepare, managedIdentity, rootHost, maxLaunches, allowedRoots, childGrant, dynamic: Boolean(managedIdentity) || childGrant?.v === 2, readLive: adapter.readLive, revision },
  });
  try {
    const old = existsSync(credentialPath) ? readStoredCredential(credentialPath) : null;
    const tokens = runtime.bootstrapPrincipals([{ principal, credentialPath }], [old]);
    if (tokens) writeCredential(credentialPath, { token: tokens[0], socketPath: `${runtime.stateRoot}/runtime.sock` }, runtime);
    runtime.initializeFamily();
    // Family children are flat on disk; typed close follows explicit service parentage.
    const service = await startService(runtime, { keepAlive, beforeShutdown: async () => {
      const children = await runtime.familyOperation('children').catch(error => {
        if (['PI_DETACH_LEGACY_CHILD_REQUIRES_REISSUE', 'FAMILY_LEGACY_ACCOUNTING_REQUIRED'].includes(error.code)) return [];
        throw error;
      });
      await closeChildServices(runtime.stateRoot, children);
    } });
    return { runtime, service };
  } catch (error) { runtime.disposeUnstarted(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // TypeScript under an installed node_modules package requires its shipped
  // production loader; Node's native stripping only works outside node_modules.
  try {
    const [detachPath, stateRoot, cwd, sessionId, marker] = process.argv.slice(2);
    demand(detachPath && stateRoot && cwd && sessionId && [6, 7].includes(process.argv.length), 'USAGE_DETACH_PATH_STATE_CWD_SESSION');
    const require = createRequire(resolve(detachPath, 'package.json'));
    const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
    register({ tsconfig: false });
    const module = await import(pathToFileURL(resolve(detachPath, 'src/execution-port.ts')).href);
    const { createHerdrCli } = await import(pathToFileURL(resolve(detachPath, 'src/herdr/cli.ts')).href);
    const { detectHerdrContext } = await import(pathToFileURL(resolve(detachPath, 'src/herdr/context.ts')).href);
    const { createPaneManager } = await import(pathToFileURL(resolve(detachPath, 'src/herdr/panes.ts')).href);
    const ctx = detectHerdrContext(); demand(ctx, 'HERDR_CONTEXT_REQUIRED');
    const cli = createHerdrCli();
    const port = module.createAgentExecutionPort({ cli, ctx, panes: createPaneManager(cli, ctx) });
    privateDirectory(stateRoot);
    const managedIdentity = marker ? JSON.parse(readFileSync(marker, 'utf8')).identity : null;
    const revision = installedRevision(detachPath, fileURLToPath(import.meta.url));
    const { service } = await hostPiDetach({ stateRoot, cwd, sessionId, credentialPath: `${stateRoot}/pi.json`, port, managedIdentity, revision });
    process.stdout.write('PI_DETACH_BRIDGE_READY\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { try { await service.close(); } catch (error) { process.stderr.write(`${error.code ?? 'SHUTDOWN_REFUSED'}\n`); } });
  } catch (error) { process.stderr.write(`${error.code ?? 'BRIDGE_START_FAILED'}\n`); process.exitCode = 1; }
}
