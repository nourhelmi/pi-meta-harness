import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AdvisorRuntime } from './runtime.mjs';
import { startService, readStoredCredential, writeCredential } from './service.mjs';
import { createPiDetachAdapter } from './adapters/pi-detach.mjs';
import { demand, privateDirectory } from './security.mjs';

/** Trusted bootstrap only; no per-task packet files and no provider launch here. */
export async function hostPiDetach({ stateRoot, cwd, sessionId, credentialPath, port, slots = 16 }) {
  demand(Number(process.versions.node.split('.')[0]) >= 24, 'NODE_24_REQUIRED');
  demand(typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 256, 'PI_SESSION_REQUIRED');
  demand(Number.isInteger(slots) && slots >= 1 && slots <= 32, 'BRIDGE_POOL_BOUNDS');
  const prefix = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  const scopes = Array.from({ length: slots }, (_, i) => ({ workstream: `pi-${prefix}`, run: `pib-${prefix}-${i}`, node: 'root', ownerEpoch: 1 }));
  const principal = { id: `pi-${prefix}`, kind: 'advisor', scopes: scopes.flatMap(({ ownerEpoch, ...scope }) => [scope, { ...scope, node: 'worker' }]), operations: ['workstream.create', 'packet.admit', 'node.launch', 'node.reply', 'node.cancel', 'progress', 'wait', 'delivery.ack', 'artifact.read', 'log.read'] };
  const adapter = createPiDetachAdapter(port);
  const canonicalCwd = realpathSync(cwd);
  const runtime = new AdvisorRuntime({ stateRoot, allowedRoots: [canonicalCwd], controlPaths: [credentialPath],
    adapters: { roots: {}, workers: { 'pi-detach': adapter } },
    piBridge: { version: 1, portVersion: port.version, principalId: principal.id, sessionId, scopes, cwd: canonicalCwd, prepare: port.prepare },
  });
  try {
    const old = existsSync(credentialPath) ? readStoredCredential(credentialPath) : null;
    const tokens = runtime.bootstrapPrincipals([{ principal, credentialPath }], [old]);
    if (tokens) writeCredential(credentialPath, { token: tokens[0], socketPath: `${runtime.stateRoot}/runtime.sock` }, runtime);
    const service = await startService(runtime);
    return { runtime, service };
  } catch (error) { runtime.disposeUnstarted(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Trusted local paths only. Run with the package's tsx loader; never import this
  // Node24 owner from the default Pi extension or copy it into the live home.
  try {
    const [detachPath, stateRoot, cwd, sessionId] = process.argv.slice(2);
    demand(detachPath && stateRoot && cwd && sessionId && process.argv.length === 6, 'USAGE_DETACH_PATH_STATE_CWD_SESSION');
    const module = await import(pathToFileURL(resolve(detachPath, 'src/execution-port.ts')).href);
    const { createHerdrCli } = await import(pathToFileURL(resolve(detachPath, 'src/herdr/cli.ts')).href);
    const { detectHerdrContext } = await import(pathToFileURL(resolve(detachPath, 'src/herdr/context.ts')).href);
    const { createPaneManager } = await import(pathToFileURL(resolve(detachPath, 'src/herdr/panes.ts')).href);
    const ctx = detectHerdrContext(); demand(ctx, 'HERDR_CONTEXT_REQUIRED');
    const cli = createHerdrCli();
    const port = module.createAgentExecutionPort({ cli, ctx, panes: createPaneManager(cli, ctx) });
    privateDirectory(stateRoot);
    const { service } = await hostPiDetach({ stateRoot, cwd, sessionId, credentialPath: `${stateRoot}/pi.json`, port });
    process.stdout.write('PI_DETACH_BRIDGE_READY\n');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { try { await service.close(); } catch (error) { process.stderr.write(`${error.code ?? 'SHUTDOWN_REFUSED'}\n`); } });
  } catch (error) { process.stderr.write(`${error.code ?? 'BRIDGE_START_FAILED'}\n`); process.exitCode = 1; }
}
