import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentRouterControl, readJevRouterDefaults, writeJevRouterDefaults } from '../scripts/advisor-runtime/agent-router-control.mjs';
import { createRoutedExecutionPort } from '../scripts/advisor-runtime/agent-router.mjs';
import { hostPiDetach } from '../scripts/advisor-runtime/pi-detach-host.mjs';
import { createPiDetachClient } from '../scripts/advisor-runtime/pi-detach-client.mjs';
import { childStatePath } from '../scripts/advisor-runtime/child-scope.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
function fixture(t, { enabled = true, moduleSource } = {}) {
  const root = realpathSync(mkdtempSync('/tmp/jrc-')); const cwd = join(root, 'work'); mkdirSync(cwd, { mode: 0o700 });
  const env = { HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent') };
  const directory = join(root, '.config', 'agent-router'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const modulePath = join(root, 'router.mjs'); const configPath = join(directory, 'config.pi.json');
  writeFileSync(modulePath, moduleSource ?? `
import { readFileSync } from 'node:fs';
export const events = []; export const leases = new Set(); export const control = { failRenew: false };
let next = 0;
function config(options) { const value = JSON.parse(readFileSync(options.configPath, 'utf8')); if (!value.enabled) throw new Error('SNAPSHOT_DISABLED'); return value; }
export async function route(request, options) {
  events.push({ kind: 'route', request, options, config: config(options) });
  const id = 'lease-' + ++next; leases.add(id);
  return { version: 1, id, selected: { model: request.pin?.model ?? 'fixture/routed', thinking: request.pin?.thinking ?? 'high' }, strategy: 'fallback', at: '2026-01-01T00:00:00Z' };
}
export async function renew(id, options) { events.push({ kind: 'renew', id, options, config: config(options) }); if (control.failRenew || !leases.has(id)) throw new Error('LEASE_LOST'); }
export async function release(id, options) { events.push({ kind: 'release', id, options, config: config(options) }); leases.delete(id); }
`, { mode: 0o600 });
  const template = { version: 1, enabled, modulePath, stateDir: join(root, 'shared-quota'), credentialsFile: join(root, 'DO-NOT-READ-credentials'),
    benchmarkFile: join(root, 'benchmarks'), candidates: [{ model: 'fixture/routed', thinking: 'high', fit: 'fixture' }], pools: [{ id: 'shared' }], policy: { reserve: 17 }, jev: { enabled: true } };
  save(configPath, template);
  const hosts = [];
  t.after(async () => { for (const host of hosts.reverse()) { try { await host.service.close(); } catch { try { host.runtime.disposeUnstarted(); } catch {} } } rmSync(root, { recursive: true, force: true }); });
  const make = (sessionId, options = {}) => createAgentRouterControl({ stateRoot: join(root, sessionId), sessionId, allowedRoots: [cwd], allowInitialize: true, env, ...options });
  async function host(sessionId, options = {}) {
    const stateRoot = options.stateRoot ?? join(root, sessionId); const stub = port();
    const identity = { fixture: true };
    const started = await hostPiDetach({ stateRoot, cwd, sessionId, credentialPath: join(stateRoot, 'pi.json'), port: stub.value, managedIdentity: identity, keepAlive: false, env, ...options });
    hosts.push(started);
    const client = createPiDetachClient(join(stateRoot, 'pi.json'));
    const request = (action, payload = {}) => client.request(sessionId, action, payload);
    const launch = async (key, params = {}) => {
      const response = await request('call', { toolCallId: key, tool: 'bg_agent', cwd, params: { prompt: key, ...params } });
      await started.runtime.dispatch(); return response.runId;
    };
    const settle = async runId => {
      const launched = stub.launches.find(value => value.id === runId);
      writeFileSync(join(launched.intent.sourceDirectory, 'result.md'), '# Status\nPASS\n# Claims\nFake router verification.');
      await launched.hooks.settled('done', 'fixture', 2);
      for (const delivery of await request('wait', { runId, timeoutMs: 0 })) await request('ack', { runId, deliveryId: delivery.id });
    };
    return { ...started, ...stub, identity, client, request, stateRoot, launch, settle };
  }
  return { root, cwd, env, configPath, modulePath, template, make, host };
}
function port() {
  const prepares = []; const launches = [];
  return { prepares, launches, value: { version: 1,
    async prepare(params, sourceDirectory, scope = {}) {
      prepares.push({ params, scope });
      return { v: 1, command: 'fixture', prompt: params.prompt, role: params.role ?? 'builder', runtime: 'pi', model: params.model ?? 'fixture/manual', thinking: params.thinking ?? 'off', maxTurns: null, requiredSkills: [], harness: 'pi', keepAlive: Boolean(params.keepAlive), label: 'fixture', resultDiscovery: null, resultPolicy: 'runtime-capture', sourceDirectory,
        environment: { ADVISOR_RUNTIME_DESCRIPTOR: '', PI_DETACH_RUNTIME_BRIDGE: '', ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_RUNTIME_CANONICAL_OWNER: '1', ADVISOR_BRIDGE_CHILD_STATE: params.delegate ? scope.childState : '' } };
    },
    async launch(input) {
      launches.push(input); input.hooks.recordHandle?.({ id: 'fixture-' + launches.length, session: 'fixture-worker' });
      return { async runtimeObservation() { return { session: 'fixture-worker', generation: 1, state: 'idle' }; },
        async interrupt(observer) { await observer?.beforeInterrupt?.(); await observer?.settled?.('idle', '', 2); } };
    },
  } };
}
const hooks = overrides => ({ expectedHandle: null, observeOnly: false, completed: false, async settled(value) { return value; }, ...overrides });

// Config and status never import the fixture module, much less collect quota or read credentials.
test('defaults prefer Pi, explicit overrides mode, exact/private writes affect only future sessions', async t => {
  const f = fixture(t);
  const legacy = join(f.root, '.config', 'agent-router', 'config.json'); save(legacy, { ...f.template, enabled: false });
  assert.deepEqual(readJevRouterDefaults(f.env), { version: 1, enabled: true, configPath: f.configPath });
  const a = f.make('a'); const b = f.make('b');
  const original = readFileSync(f.configPath, 'utf8');
  writeJevRouterDefaults({ version: 1, enabled: false, configPath: f.configPath }, f.env);
  const c = f.make('c');
  assert.equal(a.status().enabled, true); assert.equal(b.status().enabled, true); assert.equal(c.status().enabled, false);
  await a.set({ enabled: false, expectedGeneration: 0 });
  assert.equal(b.status().enabled, true);
  assert.deepEqual(f.make('a', { allowInitialize: false }).status(), a.status(), 'resume uses durable gate');
  const capture = b.capture(); assert.ok(Object.isFrozen(capture)); assert.ok(Object.isFrozen(capture.snapshot));
  b.status().enabled = false; assert.equal(b.status().enabled, true, 'status is not write authority');
  assert.equal(f.make('fork').status().enabled, false, 'new IDs use future defaults');
  for (const name of ['a', 'b', 'c']) {
    assert.deepEqual(json(join(f.root, name, 'router-config.json')), { ...f.template, enabled: true });
    assert.equal(statSync(join(f.root, name, 'router-control.json')).mode & 0o777, 0o600);
  }
  assert.equal(readFileSync(f.configPath, 'utf8'), original); assert.equal(json(legacy).enabled, false);
  assert.equal(statSync(join(f.env.PI_CODING_AGENT_DIR, 'jev-router.json')).mode & 0o777, 0o600);
  assert.deepEqual(readJevRouterDefaults({ ...f.env, AGENT_ROUTER_CONFIG: legacy }), { version: 1, enabled: false, configPath: legacy });
  writeJevRouterDefaults({ version: 1, enabled: true, configPath: f.configPath }, f.env);
  assert.equal(f.make('override', { env: { ...f.env, AGENT_ROUTER_CONFIG: legacy } }).status().enabled, false);
  assert.equal(f.make('explicit', { configPath: legacy }).status().enabled, false);
  rmSync(join(f.env.PI_CODING_AGENT_DIR, 'jev-router.json')); rmSync(f.configPath);
  assert.equal(readJevRouterDefaults(f.env).configPath, legacy);
  rmSync(legacy); assert.deepEqual(readJevRouterDefaults(f.env), { version: 1, enabled: false, configPath: null });
  chmodSync(f.env.PI_CODING_AGENT_DIR, 0o755);
  writeJevRouterDefaults({ version: 1, enabled: false, configPath: null }, f.env);
  assert.equal(statSync(f.env.PI_CODING_AGENT_DIR).mode & 0o777, 0o755, 'do not chmod the existing Pi directory');
  assert.equal(statSync(join(f.env.PI_CODING_AGENT_DIR, 'jev-router.json')).mode & 0o777, 0o600);
  chmodSync(f.env.PI_CODING_AGENT_DIR, 0o777);
  assert.throws(() => writeJevRouterDefaults({ version: 1, enabled: false, configPath: null }, f.env), /UNSAFE_DIRECTORY/);
});

test('immutable full snapshots survive template mutation/removal and preserve large UTF-8 catalogs', async t => {
  const f = fixture(t); f.template.candidates[0].fit = '🛰️'.repeat(18000); save(f.configPath, f.template);
  const control = f.make('session'); const wrapped = createRoutedExecutionPort(port().value, { control: () => control });
  save(f.configPath, { ...f.template, enabled: false, stateDir: '/unrelated/store' });
  const intent = await wrapped.prepare({ prompt: 'unchanged' }, '/source', {});
  const router = await import(f.modulePath);
  assert.deepEqual(router.events[0].config, f.template);
  rmSync(f.configPath); await control.set({ enabled: false, expectedGeneration: 0 });
  await wrapped.release(intent);
  assert.equal(router.events.at(-1).config.stateDir, f.template.stateDir);
  assert.equal(control.status().error, undefined);
});

for (const enabled of [true, false]) test(`prepare captures ${enabled ? 'ON before OFF' : 'OFF before ON'} ahead of its first await, including descendant inheritance`, async t => {
  const f = fixture(t, { enabled }); const control = f.make('parent'); const stub = port();
  const barrier = Promise.withResolvers(); const entered = Promise.withResolvers(); const base = stub.value.prepare;
  let first = true;
  stub.value.prepare = async (...args) => { if (first) { first = false; entered.resolve(); await barrier.promise; } return base(...args); };
  const wrapped = createRoutedExecutionPort(stub.value, { control: () => control });
  const state = join(f.root, 'parent'); const childState = childStatePath(state, state, 'captured');
  const preparing = wrapped.prepare({ prompt: 'before', delegate: true }, '/source', { childState });
  await entered.promise;
  const acknowledged = await control.set({ enabled: !enabled, expectedGeneration: 0 });
  assert.equal(acknowledged.enabled, !enabled); assert.equal(acknowledged.generation, 1);
  barrier.resolve(); const before = await preparing;
  assert.equal(Boolean(before.routing), enabled);
  assert.equal(json(join(childState, 'router-seed.json')).enabled, enabled);
  const after = await wrapped.prepare({ prompt: 'after' }, '/source', {});
  assert.equal(Boolean(after.routing), !enabled);
  await wrapped.release(before); await wrapped.release(after);
});

test('active/keepAlive leases renew, recover, release and rehydrate against the snapshot while OFF', async t => {
  const f = fixture(t); const control = f.make('session'); const stub = port();
  const wrapped = createRoutedExecutionPort(stub.value, { control: () => control, renewIntervalMs: 2 });
  const router = await import(f.modulePath); const renewed = Promise.withResolvers();
  const launch = stub.value.launch;
  stub.value.launch = async input => {
    const driver = await launch(input);
    return { ...driver, async runtimeObservation() {
      if (!control.status().enabled) renewed.resolve();
      return driver.runtimeObservation();
    } };
  };
  const intent = await wrapped.prepare({ prompt: 'kept', keepAlive: true }, '/source', {});
  await wrapped.launch({ intent, hooks: hooks() });
  const eventCount = router.events.length;
  await control.set({ enabled: false, expectedGeneration: 0 });
  assert.equal(router.events.length, eventCount, 'OFF does not renew/release/reroute any lease');
  assert.equal(stub.launches.length, 1, 'OFF does not relaunch the worker');
  const timeout = setTimeout(() => renewed.reject(new Error('keepAlive timer stopped while OFF')), 1000);
  try { await renewed.promise; } finally { clearTimeout(timeout); }
  assert.ok(router.events.slice(eventCount).some(event => event.kind === 'renew'));
  assert.equal(stub.launches.length, 1);
  await wrapped.release(intent);
  const next = await control.set({ enabled: true, expectedGeneration: 1 });
  const active = await wrapped.prepare({ prompt: 'rehydrate' }, '/source', {});
  await control.set({ enabled: false, expectedGeneration: next.generation });
  rmSync(f.configPath);
  const recovered = createRoutedExecutionPort(port().value, { control: () => f.make('session', { allowInitialize: false }) });
  await recovered.launch({ intent: active, hooks: hooks({ expectedHandle: { id: 'owned', session: 'fixture-worker' } }) });
  await recovered.release(active);
  assert.equal(router.leases.size, 0);
  assert.ok(router.events.every(event => event.config.stateDir === f.template.stateDir && event.config.enabled));
});

test('lease failure still interrupts and retains recovery semantics while OFF', async t => {
  const f = fixture(t); const control = f.make('session'); const stub = port(); const recovery = Promise.withResolvers(); let interrupted = 0;
  stub.value.launch = async () => ({ async interrupt(observer) { interrupted++; await observer.settled(); } });
  const wrapped = createRoutedExecutionPort(stub.value, { control: () => control, renewIntervalMs: 2 });
  const intent = await wrapped.prepare({ prompt: 'recover' }, '/source', {});
  const router = await import(f.modulePath);
  await wrapped.launch({ intent, hooks: hooks({ recoveryRequired: code => recovery.resolve(code) }) });
  await control.set({ enabled: false, expectedGeneration: 0 }); router.control.failRenew = true;
  // A referenced timeout only bounds failure; lease timers are deliberately unref'd in production.
  const timeout = setTimeout(() => recovery.reject(new Error('renewal stopped while OFF')), 1000);
  try { assert.equal(await recovery.promise, 'BRIDGE_ROUTER_LEASE_LOST'); } finally { clearTimeout(timeout); }
  assert.equal(interrupted, 1); await wrapped.release(intent); assert.equal(router.leases.size, 0);
});

test('missing/bad setup stays usable OFF without module import and ON rejects bad metadata/API', async t => {
  const f = fixture(t, { enabled: false, moduleSource: "throw new Error('DO_NOT_IMPORT_ON_STATUS_OR_OFF')" });
  const control = f.make('off');
  assert.equal(control.status().enabled, false); assert.equal(control.status().error, undefined);
  assert.equal((await control.set({ enabled: false, expectedGeneration: 0 })).generation, 1);
  await assert.rejects(control.set({ enabled: true, expectedGeneration: 1 }), /AGENT_ROUTER_MODULE_INVALID/);
  assert.equal(control.status().generation, 1);
  const badApi = join(f.root, 'bad-api.mjs'); writeFileSync(badApi, 'export const route = () => {};');
  save(f.configPath, { ...f.template, modulePath: badApi });
  await assert.rejects(f.make('bad-api').set({ enabled: true, expectedGeneration: 0 }), /AGENT_ROUTER_MODULE_INVALID/);
  save(f.configPath, { ...f.template, enabled: true, stateDir: 'relative' });
  const invalid = f.make('bad-config'); assert.equal(invalid.status().enabled, true); assert.equal(invalid.status().error, 'AGENT_ROUTER_CONFIG_INVALID');
  await assert.rejects(invalid.set({ enabled: true, expectedGeneration: 0 }), /AGENT_ROUTER_CONFIG_INVALID/);
  await invalid.set({ enabled: false, expectedGeneration: 0 });
  assert.equal(invalid.status().error, undefined, 'broken router setup must not fence manual OFF launches');
  assert.equal((await createRoutedExecutionPort(port().value, { control: () => invalid }).prepare({ prompt: 'manual' }, '/source')).routing, undefined);
  rmSync(f.configPath); const missing = f.make('missing'); assert.equal(missing.status().enabled, false);
  await assert.rejects(missing.set({ enabled: true, expectedGeneration: 0 }), /AGENT_ROUTER_CONFIG_INVALID/);
});

test('controls reject malformed metadata, unsafe paths, changed snapshots, session mismatch and generation replay', async t => {
  const f = fixture(t); const control = f.make('session');
  for (const value of [null, {}, { enabled: 'yes', expectedGeneration: 0 }, { enabled: true, expectedGeneration: -1 }, { enabled: true, expectedGeneration: 0.5 }, { enabled: true, expectedGeneration: Number.MAX_SAFE_INTEGER + 1 }, { enabled: false, expectedGeneration: 0, configPath: '/arbitrary' }]) {
    await assert.rejects(control.set(value), /AGENT_ROUTER_CONTROL_INVALID/);
  }
  const pendingOn = control.set({ enabled: true, expectedGeneration: 0 });
  await control.set({ enabled: false, expectedGeneration: 0 });
  await assert.rejects(pendingOn, /AGENT_ROUTER_GENERATION_CONFLICT/);
  await assert.rejects(control.set({ enabled: true, expectedGeneration: 0 }), /AGENT_ROUTER_GENERATION_CONFLICT/);
  assert.throws(() => f.make('foreign', { stateRoot: join(f.root, 'session') }), /BRIDGE_SESSION_MISMATCH/);
  assert.throws(() => f.make('bad', { stateRoot: join(f.cwd, 'control') }), /CONTROL_WORKSPACE_OVERLAP/);
  for (const value of [{ version: 2, enabled: true, configPath: null }, { version: 1, enabled: 'yes', configPath: null }, { version: 1, enabled: false, configPath: 'relative' }, { version: 1, enabled: false, configPath: null, modulePath: '/no' }]) {
    assert.throws(() => writeJevRouterDefaults(value, f.env), /AGENT_ROUTER_DEFAULTS_INVALID/);
  }
  writeJevRouterDefaults({ version: 1, enabled: false, configPath: f.configPath }, f.env);
  const defaults = join(f.env.PI_CODING_AGENT_DIR, 'jev-router.json'); chmodSync(defaults, 0o644);
  assert.throws(() => readJevRouterDefaults(f.env), /UNSAFE_FILE/); chmodSync(defaults, 0o600);
  const link = join(f.root, 'defaults-alias'); linkSync(defaults, link); assert.throws(() => readJevRouterDefaults(f.env), /UNSAFE_FILE/); rmSync(link);
  const snapshot = join(f.root, 'session', 'router-config.json'); save(snapshot, { ...f.template, stateDir: '/tampered' });
  assert.equal(control.capture().error, 'AGENT_ROUTER_CONFIG_INVALID');
  assert.equal(control.status().error, undefined, 'OFF remains usable without router setup');
  await assert.rejects(control.set({ enabled: true, expectedGeneration: 1 }), /AGENT_ROUTER_CONFIG_INVALID/);
  rmSync(snapshot); symlinkSync(f.configPath, snapshot); assert.equal(control.capture().error, 'AGENT_ROUTER_CONFIG_INVALID');
  const gate = join(f.root, 'session', 'router-control.json'); save(gate, { ...json(gate), arbitrary: true });
  assert.throws(() => f.make('session', { allowInitialize: false }), /AGENT_ROUTER_CONTROL_INVALID/);
});

test('host ACK authenticates exact session/principal and CAS; reconnect persists mode; old stores never retrofit', async t => {
  const f = fixture(t); const a = await f.host('a'); const initial = await a.request('router.status');
  assert.deepEqual(await a.request('connect', { identity: a.identity, cwd: f.cwd }), { ready: true, revision: null, router: initial });
  assert.deepEqual(Object.keys(initial).sort(), ['enabled', 'generation', 'sessionId', 'templatePath', 'version']);
  await assert.rejects(a.client.request('foreign', 'router.status', {}), /BRIDGE_SESSION_MISMATCH/);
  await assert.rejects(a.request('router.status', { enabled: true }), /EXTRA_FIELD/);
  await assert.rejects(a.request('router.set', { enabled: false, expectedGeneration: 0, sessionId: 'b' }), /EXTRA_FIELD/);
  await assert.rejects(a.request('router.set', { enabled: false, expectedGeneration: -1 }), /AGENT_ROUTER_CONTROL_INVALID/);
  const wrong = a.runtime.registerPrincipal({ id: 'wrong', kind: 'advisor', scopes: [{ workstream: 'none', run: 'none', node: 'root' }], operations: ['progress'] });
  const request = { v: 1, op: 'pi.detach', sessionId: 'a', action: 'router.set', payload: { enabled: false, expectedGeneration: 0 } };
  assert.equal((await a.runtime.piDetachRequest('0'.repeat(64), request, 'model')).ok, false);
  assert.equal((await a.runtime.piDetachRequest(wrong, request, 'model')).ok, false);
  const ack = await a.request('router.set', { enabled: false, expectedGeneration: 0 });
  assert.equal(ack.generation, 1); assert.equal(ack.enabled, false);
  await assert.rejects(a.request('router.set', { enabled: true, expectedGeneration: 0 }), /AGENT_ROUTER_GENERATION_CONFLICT/);
  assert.deepEqual(await a.request('router.status'), ack);
  assert.deepEqual(json(join(a.stateRoot, 'router-control.json')).generation, ack.generation);
  await a.service.close();
  const resumed = await f.host('a'); assert.deepEqual(await resumed.request('router.status'), ack);
  assert.throws(() => resumed.runtime.initializeRouterControl(), /AGENT_ROUTER_CONTROL_ALREADY_INITIALIZED/);
  const concurrent = await Promise.allSettled([resumed.request('router.set', { enabled: false, expectedGeneration: 1 }), resumed.request('router.set', { enabled: false, expectedGeneration: 1 })]);
  assert.equal(concurrent.filter(value => value.status === 'fulfilled').length, 1);
  assert.match(concurrent.find(value => value.status === 'rejected').reason.message, /AGENT_ROUTER_GENERATION_CONFLICT/);
  assert.equal((await resumed.request('router.status')).generation, 2);
  const legacy = await f.host('legacy', { routerControl: false });
  assert.equal((await legacy.request('connect', { identity: legacy.identity, cwd: f.cwd })).router, undefined);
  await assert.rejects(legacy.request('router.status'), /AGENT_ROUTER_CONTROL_UNSUPPORTED/);
  await legacy.service.close();
  const old = await f.host('legacy'); await assert.rejects(old.request('router.set', { enabled: false, expectedGeneration: 0 }), /AGENT_ROUTER_CONTROL_UNSUPPORTED/);
  assert.equal(existsSync(join(old.stateRoot, 'router-config.json')), false);
  const low = await f.host('low', { managedIdentity: null }); await assert.rejects(low.request('router.status'), /AGENT_ROUTER_CONTROL_UNSUPPORTED/);
  const native = await f.host('native', { managedIdentity: { rootHost: 'codex' } }); await assert.rejects(native.request('router.status'), /AGENT_ROUTER_CONTROL_UNSUPPORTED/);
});

test('approved child and grandchild hosts bind independent inherited gates; unapproved/forged seeds fail', async t => {
  const f = fixture(t); const root = await f.host('root');
  const runId = await root.launch('child-before', { delegate: true });
  const childState = (await root.request('get', { runId })).childService.stateRoot;
  assert.equal(json(join(childState, 'router-seed.json')).enabled, true);
  await root.request('router.set', { enabled: false, expectedGeneration: 0 });
  writeJevRouterDefaults({ version: 1, enabled: false, configPath: null }, f.env);
  const child = await f.host('child', { stateRoot: childState });
  assert.equal((await child.request('router.status')).enabled, true, 'parent/default changes do not affect reserved child');
  assert.notEqual(join(childState, 'router-config.json'), join(root.stateRoot, 'router-config.json'));
  const secondRun = await root.launch('child-after', { delegate: true });
  const secondState = (await root.request('get', { runId: secondRun })).childService.stateRoot;
  const second = await f.host('second', { stateRoot: secondState }); assert.equal((await second.request('router.status')).enabled, false);
  await child.request('router.set', { enabled: false, expectedGeneration: 0 });
  const grandRun = await child.launch('grand', { delegate: true });
  const grandState = (await child.request('get', { runId: grandRun })).childService.stateRoot;
  const grand = await f.host('grand', { stateRoot: grandState }); assert.equal((await grand.request('router.status')).enabled, false);
  await root.request('router.set', { enabled: true, expectedGeneration: 1 });
  assert.equal((await child.request('router.status')).enabled, false); assert.equal((await grand.request('router.status')).enabled, false);
  await assert.rejects(child.client.request('root', 'router.set', { enabled: true, expectedGeneration: 1 }), /BRIDGE_SESSION_MISMATCH/);
  const controller = f.make('isolated'); const prepared = port(); const wrapped = createRoutedExecutionPort(prepared.value, { control: () => controller });
  const scope = { childState: childStatePath(join(f.root, 'isolated'), join(f.root, 'isolated'), 'leaf') };
  const leaf = await wrapped.prepare({ prompt: 'leaf' }, '/source', scope); assert.equal(existsSync(scope.childState), false); await wrapped.release(leaf);
  assert.throws(() => controller.seedChild(controller.capture(), { environment: { ADVISOR_BRIDGE_CHILD_STATE: childState } }, scope), /AGENT_ROUTER_SEED_MISMATCH/);
  const seed = join(secondState, 'router-seed.json'); const gate = join(secondState, 'router-control.json');
  await second.service.close(); rmSync(gate); save(seed, { ...json(seed), parentSessionId: 'forged' });
  assert.throws(() => createAgentRouterControl({ stateRoot: secondState, sessionId: 'second', allowedRoots: [f.cwd], allowInitialize: true, childGrant: { v: 2, parent: { stateRoot: root.stateRoot, sessionId: 'root' } } }), /AGENT_ROUTER_SEED_MISMATCH/);
  await grand.service.close(); await child.settle(grandRun); await child.service.close();
  await root.settle(runId); await root.settle(secondRun);
});

test('owner fence, write failure, exhausted generations and lost ACK never grant blind replay', async t => {
  const f = fixture(t); let owned = true;
  const control = f.make('owner', { assertOwner() { assert.ok(owned, 'OWNER_FENCE'); } });
  const pending = control.set({ enabled: true, expectedGeneration: 0 }); owned = false;
  await assert.rejects(pending, /OWNER_FENCE/); owned = true;
  assert.equal(control.status().generation, 0);
  const gate = join(f.root, 'owner', 'router-control.json'); chmodSync(gate, 0o644);
  await assert.rejects(control.set({ enabled: false, expectedGeneration: 0 }), /UNSAFE_FILE/);
  assert.equal(control.status().enabled, true); chmodSync(gate, 0o600);
  save(gate, { ...json(gate), generation: Number.MAX_SAFE_INTEGER });
  const exhausted = f.make('owner', { allowInitialize: false });
  await assert.rejects(exhausted.set({ enabled: false, expectedGeneration: Number.MAX_SAFE_INTEGER }), /AGENT_ROUTER_GENERATION_EXHAUSTED/);
  let checks = 0; let loseAck = false;
  const lost = f.make('lost', { assertOwner() { if (loseAck && ++checks === 3) throw new Error('ACK_LOST'); } });
  loseAck = true;
  await assert.rejects(lost.set({ enabled: false, expectedGeneration: 0 }), /ACK_LOST/); loseAck = false;
  assert.equal(lost.status().generation, 1); assert.equal(lost.status().enabled, false);
  await assert.rejects(lost.set({ enabled: true, expectedGeneration: 0 }), /AGENT_ROUTER_GENERATION_CONFLICT/);
  assert.deepEqual(f.make('lost', { allowInitialize: false }).status(), lost.status());
});

test('malformed defaults and explicit templates fail closed until an acknowledged explicit OFF', async t => {
  const f = fixture(t);
  mkdirSync(f.env.PI_CODING_AGENT_DIR, { mode: 0o700 });
  const defaultsPath = join(f.env.PI_CODING_AGENT_DIR, 'jev-router.json');
  writeFileSync(defaultsPath, '{broken', { mode: 0o600 });
  const defaults = f.make('invalid-defaults');
  assert.equal(defaults.status().enabled, true); assert.equal(defaults.status().error, 'AGENT_ROUTER_DEFAULTS_INVALID');
  const wrapped = createRoutedExecutionPort(port().value, { control: () => defaults });
  await assert.rejects(wrapped.prepare({ prompt: 'must not bypass' }, '/source', {}), /AGENT_ROUTER_DEFAULTS_INVALID/);
  await defaults.set({ enabled: false, expectedGeneration: 0 });
  assert.equal(defaults.status().error, undefined);
  assert.equal((await wrapped.prepare({ prompt: 'explicit manual' }, '/source', {})).routing, undefined);
  writeFileSync(f.configPath, '{broken');
  const explicit = f.make('invalid-explicit', { env: { ...f.env, AGENT_ROUTER_CONFIG: f.configPath } });
  assert.equal(explicit.status().enabled, true); assert.equal(explicit.status().error, 'AGENT_ROUTER_DEFAULTS_INVALID');
  await assert.rejects(explicit.set({ enabled: true, expectedGeneration: 0 }), /AGENT_ROUTER_DEFAULTS_INVALID/);
  assert.equal((await explicit.set({ enabled: false, expectedGeneration: 0 })).enabled, false);
  save(defaultsPath, { version: 1, enabled: 'bad', configPath: f.configPath });
  assert.equal(f.make('invalid-shape').status().error, 'AGENT_ROUTER_DEFAULTS_INVALID');
  rmSync(defaultsPath); rmSync(f.configPath);
  const missing = f.make('legitimately-unconfigured');
  assert.equal(missing.status().enabled, false); assert.equal(missing.status().error, undefined);
});

for (const failAt of [1, 2]) test(`fsync failure ${failAt === 1 ? 'before' : 'after'} rename preserves the actual CAS generation`, async t => {
  const f = fixture(t); const control = f.make('session');
  const original = fs.fsyncSync; let syncs = 0;
  try {
    fs.fsyncSync = (...args) => { if (++syncs === failAt) throw new Error('fixture fsync failure'); return original(...args); };
    syncBuiltinESMExports();
    await assert.rejects(control.set({ enabled: false, expectedGeneration: 0 }), /AGENT_ROUTER_CONTROL_WRITE_UNCONFIRMED/);
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert.equal(control.status().generation, failAt === 2 ? 1 : 0);
  assert.equal(control.status().enabled, failAt === 1);
  assert.equal(json(join(f.root, 'session', 'router-control.json')).generation, control.status().generation);
  if (failAt === 2) await assert.rejects(control.set({ enabled: true, expectedGeneration: 0 }), /AGENT_ROUTER_GENERATION_CONFLICT/);
});
