import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Run against fresh packed package roots; no checkout runtime imports in the probe.
const meta = process.env.PI_BRIDGE_META_PACKAGE;
const detach = process.env.PI_DETACH_TEST_PACKAGE;
assert.ok(meta && detach);
const root = process.env.DEFAULT_FIXTURE_ROOT || realpathSync(mkdtempSync('/tmp/pid1-'));
const phase = process.env.DEFAULT_FIXTURE_PHASE;
if (phase === 'connect') {
  const { ensurePiDetach } = await import(pathToFileURL(join(meta, 'scripts/advisor-runtime/pi-detach-bootstrap.mjs')));
  const result = await ensurePiDetach({ cwd: join(root, 'work'), sessionId: 'default-fixture', detachPath: detach, herdr: { paneId: 'w1:p1' } });
  console.log(JSON.stringify({ descriptor: result.descriptor, stateRoot: result.stateRoot }));
  process.exit(0);
}
for (const dir of ['home', 'work', 'fake', 'bin']) mkdirSync(join(root, dir), { mode: 0o700 });
const target = join(root, 'install');
const env = { PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: join(root, 'home'), PI_OFFLINE: '1', PI_TELEMETRY: '0', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', BRIDGE_FAKE_ROOT: join(root, 'fake') };
const install = spawnSync(process.execPath, [join(meta, 'scripts/meta-harness.mjs'), 'install', '--target', target], { env, encoding: 'utf8' });
assert.equal(install.status, 0, install.stderr);
const config = JSON.parse(readFileSync(join(target, 'pi-detach-runtime.json')));
assert.equal(config.backend, 'runtime'); assert.ok(existsSync(config.host));
const doctor = spawnSync(process.execPath, [join(meta, 'scripts/meta-harness.mjs'), 'doctor', '--target', target], { env, encoding: 'utf8' });
assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr); assert.match(doctor.stdout, /Node owner ready/);
const key = createHash('sha256').update(JSON.stringify({ config: config.host, sessionId: 'default-fixture' })).digest('hex').slice(0, 20);
const state = join(config.stateBase, key);
env.BRIDGE_FAKE_DATABASE = join(state, 'runtime.sqlite');
env.PI_CODING_AGENT_DIR = target;
// The shell shim invokes only this fixture executable. Product uses its real CLI port.
const fake = fileURLToPath(new URL('./fake-herdr.mjs', import.meta.url));
writeFileSync(join(root, 'bin/herdr'), `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
const connect = () => new Promise((resolveChild, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...env, PI_BRIDGE_META_PACKAGE: meta, PI_DETACH_TEST_PACKAGE: detach, DEFAULT_FIXTURE_ROOT: root, DEFAULT_FIXTURE_PHASE: 'connect' } });
  let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
  child.on('exit', code => code === 0 ? resolveChild(JSON.parse(stdout)) : reject(new Error(stderr)));
});
const connected = await Promise.all([connect(), connect(), connect()]);
assert.ok(connected.every(v => v.descriptor === connected[0].descriptor));
const ownerPath = join(state, 'service.lock/owner.json');
const ownerBefore = readFileSync(ownerPath, 'utf8');
const descriptorHash = createHash('sha256').update(readFileSync(connected[0].descriptor)).digest('hex');
for (const key of Object.keys(process.env)) if (key.startsWith("HERDR_") || key.startsWith("ADVISOR_") || key.startsWith("PI_DETACH_")) delete process.env[key];
Object.assign(process.env, env); delete process.env.PI_DETACH_RUNTIME_BRIDGE; delete process.env.ADVISOR_RUNTIME_DESCRIPTOR; delete process.env.PI_DETACH_WORKER_HARNESS;
const extension = (await import(pathToFileURL(join(detach, 'extensions/index.ts')))).default;
const { resetBridgeClients } = await import(pathToFileURL(join(detach, 'src/runtime-bridge.ts')));
const tools = new Map(), handlers = new Map(), commands = new Map(), notices = [];
const pi = { registerTool(t) { tools.set(t.name, t); }, registerCommand(n, d) { commands.set(n, d); }, on(n, h) { handlers.set(n, [...handlers.get(n) || [], h]); }, sendMessage(m) { notices.push(m); }, registerMessageRenderer() {} };
extension(pi);
const ctx = { cwd: join(root, 'work'), sessionManager: { getSessionId: () => 'default-fixture' }, isIdle: () => true, ui: { notify(m) { notices.push(m); } } };
const emit = async name => { for (const h of handlers.get(name) || []) await h({ reason: name === 'session_start' ? 'reload' : 'reload' }, ctx); };
await emit('session_start');
const launched = await tools.get('bg_agent').execute('default-tool', { prompt: 'Write the bounded result', promoteAfterMs: 0 }, undefined, undefined, ctx);
assert.ok(launched.details.runId.startsWith('pib-'));
const { ensurePiDetach, childWorkSettled } = await import(pathToFileURL(join(meta, 'scripts/advisor-runtime/pi-detach-bootstrap.mjs')));
const { createPiDetachClient } = await import(pathToFileURL(join(meta, 'scripts/advisor-runtime/pi-detach-client.mjs')));
const client = createPiDetachClient(connected[0].descriptor);
const req = (action, payload) => client.request('default-fixture', action, payload);
let node;
for (let n = 0; n < 200; n++) { node = await req('get', { runId: launched.details.runId }); if (node.snapshot.state === 'terminal') break; await new Promise(r => setTimeout(r, 25)); }
assert.equal(node.status, 'done');
const localRun = await tools.get('bg_run').execute('local-tool', { command: 'printf LOCAL_NON_AGENT', promoteAfterMs: 1000 }, undefined, undefined, ctx);
assert.equal(localRun.details.exitCode, 0);
assert.match((await tools.get('bg_output').execute('local-output', { runId: localRun.details.runId }, undefined, undefined, ctx)).content[0].text, /LOCAL_NON_AGENT/);
assert.ok((await tools.get('bg_list').execute('mixed-list', {}, undefined, undefined, ctx)).details.runs.some(r => r.id === localRun.details.runId));
await emit('session_shutdown');
const pending = await req('wait', { runId: launched.details.runId, timeoutMs: 0 });
await connect();
assert.equal(readFileSync(ownerPath, 'utf8'), ownerBefore);
assert.equal(createHash('sha256').update(readFileSync(connected[0].descriptor)).digest('hex'), descriptorHash);
assert.deepEqual(await req('wait', { runId: launched.details.runId, timeoutMs: 0 }), pending);
const calls = JSON.parse('[' + readFileSync(join(root, 'fake/calls.jsonl'), 'utf8').trim().split('\n').join(',') + ']');
assert.equal(calls.filter(a => a[1] === 'prompt').length, 1);
// Drift: code installed after the service started is reported by /bg_backend on every call, never hot-swapped.
const backend = commands.get('bg_backend'); assert.ok(backend);
const noticesBeforeBackend = notices.length;
await backend.handler({}, ctx);
assert.ok(notices.slice(noticesBeforeBackend).some(n => typeof n === 'string' && /runtime connected/.test(n) && !/older code/.test(n)), 'matching code reports no drift');
const driftFile = join(detach, 'src/herdr/sentinel.ts');
writeFileSync(driftFile, readFileSync(driftFile, 'utf8') + '\n// drift probe\n');
await backend.handler({}, ctx);
assert.ok(notices.slice(noticesBeforeBackend).some(n => typeof n === 'string' && /older code/.test(n)), 'bg_backend recomputes the installed revision');
assert.equal(calls.filter(a => a[1] === 'prompt').length, 1, 'drift detection has no worker effect');
for (const d of await req('wait', { runId: launched.details.runId, timeoutMs: 0 })) await req('ack', { runId: launched.details.runId, deliveryId: d.id });
const connectInput = { cwd: ctx.cwd, sessionId: 'default-fixture', detachPath: detach, herdr: { paneId: 'w1:p1' } };
const configFile = join(target, 'pi-detach-runtime.json');
const callsBeforeNegatives = readFileSync(join(root, 'fake/calls.jsonl'), 'utf8');
await assert.rejects(client.request('foreign-session', 'list', {}), /SESSION_MISMATCH/);
await assert.rejects(ensurePiDetach({ ...connectInput, cwd: join(root, 'fake') }), /BINDING_MISMATCH/);
await assert.rejects(ensurePiDetach({ ...connectInput, herdr: { paneId: 'foreign-pane' } }), /BINDING_MISMATCH/);
for (const [patch, expected] of [[{ node: '/missing-node' }, /NODE_24_REQUIRED/], [{ node: '/bin/true' }, /NODE_24_REQUIRED/], [{ host: join(root, 'missing-host') }, /RUNTIME_MISSING/], [{ stateBase: join(ctx.cwd, 'control') }, /OVERLAP/]]) {
 writeFileSync(configFile, JSON.stringify({ ...config, ...patch }));
 await assert.rejects(ensurePiDetach(connectInput), expected);
 resetBridgeClients();
 const noticeIndex = notices.length;
 await emit('session_start');
 assert.ok(notices.slice(noticeIndex).some(n => typeof n === 'string' && expected.test(n)), 'startup reports the typed failure visibly');
 await assert.rejects(tools.get('bg_agent').execute('invalid-config-tool', { prompt: 'Must never launch', promoteAfterMs: 0 }, undefined, undefined, ctx), expected);
}
writeFileSync(configFile, JSON.stringify(config));
resetBridgeClients();
assert.equal(readFileSync(join(root, 'fake/calls.jsonl'), 'utf8'), callsBeforeNegatives, 'invalid identities/configuration cause no worker effects');
// Reserved depth-1 grant starts its own empty service, not a parent credential.
const childState = join(config.stateBase, 'child-fixture');
mkdirSync(childState, { mode: 0o700 });
const childInput = { ...connectInput, sessionId: 'child-fixture', herdr: { paneId: 'w1:p99' }, env: { ...env, ADVISOR_BRIDGE_CHILD_STATE: childState } };
await assert.rejects(ensurePiDetach(childInput), /ENOENT/);
writeFileSync(join(childState, 'child-grant.json'), JSON.stringify({ v: 1, cwd: ctx.cwd, stateRoot: childState }), { mode: 0o600 });
const child = await ensurePiDetach(childInput);
assert.notEqual(child.descriptor, connected[0].descriptor);
assert.equal(await childWorkSettled(childState), true);
await child.client.request('child-fixture', 'shutdown', {});
assert.equal(existsSync(join(childState, 'service.lock/owner.json')), false);
assert.equal(readFileSync(join(root, 'fake/calls.jsonl'), 'utf8'), callsBeforeNegatives, 'child bootstrap itself never prompts a worker');
await req('shutdown', {});
for (let n = 0; n < 100 && existsSync(ownerPath); n++) await new Promise(r => setTimeout(r, 10));
assert.equal(existsSync(ownerPath), false);
await assert.rejects(ensurePiDetach(connectInput), /UNAVAILABLE|PI_DETACH_START_UNCONFIRMED_RECOVERY_REQUIRED/, 'closed descriptor is not silently adopted');

console.log(JSON.stringify({ status: 'PASS', fixture: root, prompts: 1, concurrentClients: 3, sameOwner: true, cleanShutdown: true, evidence: 'real extension-shaped startup/service/SQLite/port with fake Herdr; no model or live Pi witness' }));
