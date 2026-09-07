#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { AdvisorRuntime } from './runtime.mjs';
import { callSocket, readCredential, readStoredCredential, startService, writeCredential } from './service.mjs';
import { serveMcp } from './mcp.mjs';
import { createNativeAdapters } from './adapters/index.mjs';
import { managedProviderHomes } from './native-boundary.mjs';
import { LIMITS, fields } from './contract.mjs';
import { RuntimeError, canonicalLocation, demand, safeFile } from './security.mjs';

async function stdinJson() {
  let bytes = Buffer.alloc(0);
  const timer = setTimeout(() => process.stdin.destroy(new RuntimeError('INPUT_TIMEOUT')), 10000);
  try {
    for await (const chunk of process.stdin) { bytes = Buffer.concat([bytes, chunk]); demand(bytes.length <= LIMITS.envelope, 'ENVELOPE_TOO_LARGE'); }
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new RuntimeError('INVALID_JSON'); }
  } finally { clearTimeout(timer); }
}

/** Trusted host injection point for later native adapters; config never selects executable/module. */
export async function host(config, adapters, { bootstrapPath = null } = {}) {
  fields(config, ['stateRoot', 'allowedRoots', 'principals'], ['providerHomes']);
  demand(Array.isArray(config.principals) && config.principals.length > 0 && config.principals.length <= 64, 'INVALID_PRINCIPALS');
  for (const registration of config.principals) fields(registration, ['principal', 'credentialPath']);
  const controlPaths = [...config.principals.map(v => v.credentialPath), ...(bootstrapPath ? [bootstrapPath] : [])];
  const providerHomes = !adapters || config.providerHomes ? managedProviderHomes(config.stateRoot, config.allowedRoots, config.providerHomes) : null;
  const runtime = new AdvisorRuntime({ stateRoot: config.stateRoot, allowedRoots: config.allowedRoots, controlPaths, controlDirectories: Object.values(providerHomes ?? {}), adapters: adapters ?? createNativeAdapters(config.principals, {}, { providerHomes }) });
  try {
    const credentials = config.principals.map(v => existsSync(v.credentialPath) ? readStoredCredential(v.credentialPath) : null);
    const tokens = runtime.bootstrapPrincipals(config.principals, credentials, bootstrapPath, providerHomes);
    if (tokens) config.principals.forEach((registration, i) => writeCredential(registration.credentialPath, { socketPath: `${runtime.stateRoot}/runtime.sock`, token: tokens[i] }, runtime));
    const service = await startService(runtime);
    return { runtime, service };
  } catch (error) { runtime.disposeUnstarted(); throw error; }
}
export async function main(argv) {
  demand(Number(process.versions.node.split('.')[0]) >= 24, 'NODE_24_REQUIRED');
  if (argv.length === 1 && argv[0] === 'mcp-env') { demand(process.env.ADVISOR_RUNTIME_DESCRIPTOR_PATH, 'DESCRIPTOR_PATH_REQUIRED'); await serveMcp(readCredential(process.env.ADVISOR_RUNTIME_DESCRIPTOR_PATH)); return 0; }
  demand(argv.length === 2, 'USAGE_call_OR_mcp_CREDENTIAL_OR_serve_BOOTSTRAP');
  const [mode, path] = argv;
  if (mode === 'call') {
    const result = await callSocket(readCredential(path), await stdinJson());
    process.stdout.write(JSON.stringify(result) + '\n'); return result.ok ? 0 : 1;
  }
  if (mode === 'mcp') { await serveMcp(readCredential(path)); return 0; }
  demand(mode === 'serve', 'UNKNOWN_MODE');
  // Operator-only filesystem bootstrap, never an MCP tool or remote endpoint.
  safeFile(path); let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new RuntimeError('INVALID_BOOTSTRAP'); }
  const { service } = await host(config, undefined, { bootstrapPath: canonicalLocation(resolve(path)) });
  process.stdout.write(JSON.stringify({ ready: true, socketPath: service.socketPath }) + '\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    try { await service.close(); process.exitCode = 0; }
    catch (error) { process.stderr.write((error instanceof RuntimeError ? error.code : 'SHUTDOWN_ERROR') + '\n'); }
  });
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { process.stderr.write((error instanceof RuntimeError ? error.code : 'RUNTIME_ERROR') + '\n'); process.exitCode = 1; });
}
