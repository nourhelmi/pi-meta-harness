import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRoutedExecutionPort, readAgentRouterConfig } from '../scripts/advisor-runtime/agent-router.mjs';
import { validatePacket } from '../scripts/advisor-runtime/contract.mjs';
import { createPiDetachClient } from '../scripts/advisor-runtime/pi-detach-client.mjs';
import { hostPiDetach } from '../scripts/advisor-runtime/pi-detach-host.mjs';

function fixture(t, { enabled = true, moduleSource } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-router-')));
  const modulePath = join(root, 'router.mjs');
  const configPath = join(root, 'config.json');
  writeFileSync(modulePath, moduleSource ?? `
export const events = [];
export const leases = new Set();
export const control = { failRenew: false, delayRenew: 0, renewing: 0, maxRenewing: 0, capacity: Infinity };
let next = 0;
export async function route(request, options) {
  events.push({ kind: 'route', request, options });
  if (leases.size >= control.capacity) { const error = new Error('capacity'); error.code = 'AGENT_ROUTER_NO_FEASIBLE_ROUTE'; throw error; }
  if (request.task === 'no route') { const error = new Error('quota detail must stay private'); error.code = 'AGENT_ROUTER_NO_FEASIBLE_ROUTE'; throw error; }
  if (request.task === 'invalid decision') return { version: 1, id: \`decision-\${++next}\`, selected: {}, strategy: 'fallback', at: new Date().toISOString() };
  const model = request.task === 'pin mismatch' ? 'openai-codex/wrong' : request.pin?.model ?? (request.task === 'bad transport' ? 'unsupported/router-model' : \`openai-codex/routed-\${request.harness}\`);
  const thinking = request.pin?.thinking ?? 'xhigh';
  const id = \`decision-\${++next}\`; leases.add(id);
  return { version: 1, id, selected: { model, thinking }, strategy: request.pin ? 'pinned' : 'fallback', at: new Date().toISOString() };
}
export async function renew(id, options) {
  events.push({ kind: 'renew', id, options });
  control.renewing++; control.maxRenewing = Math.max(control.maxRenewing, control.renewing);
  try {
    if (control.delayRenew) await new Promise(resolve => setTimeout(resolve, control.delayRenew));
    if (control.failRenew || !leases.has(id)) throw new Error('AGENT_ROUTER_LEASE_EXPIRED');
  } finally { control.renewing--; }
}
export async function release(id, options) { events.push({ kind: 'release', id, options }); leases.delete(id); }
`);
  writeFileSync(configPath, JSON.stringify(enabled ? { version: 1, enabled: true, modulePath } : { version: 1, enabled: false }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, modulePath, configPath };
}

function bridgeError(code) { const error = new Error(code); error.code = code; return error; }

function executionPort() {
  const calls = { prepare: [], launch: [] };
  const port = {
    version: 1,
    async prepare(params, sourceDirectory, scope = {}) {
      calls.prepare.push({ params, sourceDirectory, scope });
      if (!params || typeof params !== 'object') throw bridgeError('BRIDGE_INVALID_INPUT');
      if (!params.prompt) throw bridgeError('BRIDGE_EMPTY_PROMPT');
      if (params.role === 'unknown') throw bridgeError('BRIDGE_UNKNOWN_ROLE');
      if (params.thinking !== undefined && params.model === undefined) throw bridgeError('BRIDGE_INVALID_INPUT');
      const role = params.role ?? 'freeform';
      const harness = role === 'freeform' ? 'pi' : params.harness ?? scope.workerHarness ?? 'pi';
      const model = params.model ?? 'legacy/default';
      if (params.prompt === 'bad transport' && model === 'unsupported/router-model') throw bridgeError('BRIDGE_INVALID_INPUT');
      if (params.prompt === 'post-route failure' && model.startsWith('openai-codex/routed-')) throw bridgeError('BRIDGE_EMPTY_PROMPT');
      return {
        v: 1, command: 'pi', prompt: params.prompt, role, runtime: 'pi', model,
        thinking: params.thinking ?? 'default', maxTurns: null, requiredSkills: [], harness,
        keepAlive: Boolean(params.keepAlive), label: 'fixture', resultDiscovery: null,
        resultPolicy: 'runtime-capture', sourceDirectory,
        environment: {
          ADVISOR_RUNTIME_DESCRIPTOR: '', PI_DETACH_RUNTIME_BRIDGE: '',
          ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_RUNTIME_CANONICAL_OWNER: '1',
        },
      };
    },
    async launch(input) {
      calls.launch.push(input);
      if (input.intent.prompt === 'definitive launch failure') throw bridgeError('agent command is empty');
      if (input.intent.prompt === 'uncertain launch failure') throw bridgeError('BRIDGE_PROMPT_AMBIGUOUS');
      input.hooks.assertActive?.();
      input.hooks.recordHandle?.(input.hooks.expectedHandle ?? { id: `router-fixture-${calls.launch.length}`, session: 'router-fixture-session' });
      return {
        hooks: input.hooks, intent: input.intent,
        async runtimeObservation() { input.hooks.assertActive?.(); return { session: 'router-fixture-session', generation: 1, state: input.intent.prompt === 'reconcile done' ? 'done' : 'working' }; },
        async interrupt(observer) { input.hooks.assertActive?.(); await observer?.beforeInterrupt?.(); await observer?.settled?.('idle', '', 2); },
      };
    },
  };
  return { port, calls };
}

const hooks = overrides => ({
  expectedHandle: null,
  observeOnly: false,
  completed: false,
  async settled(outcome) { return outcome; },
  ...overrides,
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function routerEvents(modulePath) {
  return (await import(modulePath)).events;
}

test('test preload overrides enabled ambient/global router config before any reservation', t => {
  const { root, configPath } = fixture(t, { moduleSource: "throw new Error('INSTALLED_ROUTER_MUST_NOT_LOAD');" });
  const script = `
    import assert from 'node:assert/strict';
    import { createRoutedExecutionPort, readAgentRouterConfig } from ${JSON.stringify(new URL('../scripts/advisor-runtime/agent-router.mjs', import.meta.url).href)};
    assert.equal(readAgentRouterConfig().enabled, false);
    const port = createRoutedExecutionPort({version:1,prepare:async()=>({model:'isolated'})});
    assert.equal((await port.prepare({prompt:'fixture'},'/source',{})).model,'isolated');
  `;
  const globalConfig = join(root, '.config', 'agent-router'); mkdirSync(globalConfig, { recursive: true });
  writeFileSync(join(globalConfig, 'config.json'), JSON.stringify({ version: 1, enabled: true, modulePath: join(root, 'router.mjs') }));
  for (const override of [configPath, undefined]) {
    const env = { ...process.env, HOME: root, AGENT_ROUTER_CONFIG: override };
    const child = spawnSync(process.execPath, ['--import', new URL('./fixtures/disable-agent-router.mjs', import.meta.url).href, '--input-type=module', '-e', script], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  }
});

test('expired preparation fails closed and live prelaunch renewals are awaited', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port, calls } = executionPort();
  const router = await import(modulePath);
  const wrapped = createRoutedExecutionPort(port, { configPath });
  const intent = await wrapped.prepare({ role: 'builder', prompt: 'delayed admission' }, '/source', {});
  router.leases.delete(intent.routing.id); // Expired while preparation/admission was delayed.
  const recovery = [];
  await assert.rejects(wrapped.launch({ intent, hooks: hooks({ recoveryRequired: cause => recovery.push(cause) }) }), /BRIDGE_ROUTER_LEASE_LOST/);
  assert.equal(calls.launch.length, 0);
  assert.deepEqual(recovery, ['BRIDGE_ROUTER_LEASE_LOST']);

  const valid = await wrapped.prepare({ role: 'builder', prompt: 'slow renewal' }, '/source', {});
  t.after(() => wrapped.release(valid));
  router.control.delayRenew = 25;
  const launching = wrapped.launch({ intent: valid, hooks: hooks() });
  await wait(5);
  assert.equal(calls.launch.length, 0, 'a pending renewal is not a lease acknowledgement');
  await launching;
  assert.equal(calls.launch.length, 1);
});

test('slow timer renewals never overlap and release drains the in-flight renewal', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port } = executionPort();
  const router = await import(modulePath);
  router.control.delayRenew = 20;
  const wrapped = createRoutedExecutionPort(port, { configPath, renewIntervalMs: 1 });
  const intent = await wrapped.prepare({ role: 'builder', prompt: 'slow timer', keepAlive: true }, '/source', {});
  t.after(() => wrapped.release(intent));
  await wrapped.launch({ intent, hooks: hooks() });
  await wait(55);
  await wrapped.release(intent);
  assert.equal(router.control.maxRenewing, 1);
  assert.equal(router.control.renewing, 0);
  assert.equal(router.events.at(-1).kind, 'release');
  const count = router.events.length;
  await wait(25);
  assert.equal(router.events.length, count, 'no renewal after release');
});

test('timer lease loss safely interrupts before recovery fences ownership, without semantic cancellation', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port } = executionPort();
  const router = await import(modulePath);
  const order = []; let active = true; let settlements = 0;
  const recovered = Promise.withResolvers();
  const baseLaunch = port.launch;
  port.launch = async input => {
    const driver = await baseLaunch(input);
    return { ...driver, async interrupt(observer) {
      input.hooks.assertActive();
      await observer.beforeInterrupt?.();
      input.hooks.assertActive();
      order.push('escape');
      // Actual DriverHandle does not await observer.settled.
      observer.settled('idle', '', 2);
    } };
  };
  const wrapped = createRoutedExecutionPort(port, { configPath, renewIntervalMs: 2 });
  const intent = await wrapped.prepare({ role: 'builder', prompt: 'lose lease', keepAlive: true }, '/source', {});
  t.after(() => wrapped.release(intent));
  const driver = await wrapped.launch({ intent, hooks: hooks({
    assertActive() { assert.ok(active, 'OWNER_FENCE'); },
    beforeInterrupt: async () => { order.push('children'); },
    settled() { settlements++; return { terminal: true }; },
    recoveryRequired(cause) { order.push(cause); active = false; recovered.resolve(); },
  }) });
  router.control.failRenew = true;
  await Promise.race([recovered.promise, wait(1000).then(() => { throw new Error('missing recovery'); })]);
  assert.deepEqual(order.slice(0, 3), ['children', 'escape', 'BRIDGE_ROUTER_LEASE_LOST']);
  assert.equal(settlements, 0, 'lease recovery cannot manufacture a result/cancel event');
  assert.deepEqual(await driver.hooks.settled('done', '', 3), { terminal: false, close: false });
  assert.equal(router.events.filter(event => event.kind === 'release').length, 1, 'only observed stop releases');
});

test('ambiguous lease-loss interruption retains capacity and is observable even for synchronous renew throws', async t => {
  const { configPath } = fixture(t, { moduleSource: `
export const events=[]; let renewals=0;
export async function route(){return {version:1,id:'lease',selected:{model:'openai-codex/routed-pi',thinking:'high'},strategy:'fallback',at:new Date().toISOString()}}
export function renew(){ if (++renewals > 1) throw new Error('private quota failure'); }
export function release(){events.push('release')}
` });
  const { port } = executionPort();
  const baseLaunch = port.launch;
  port.launch = async input => ({ ...await baseLaunch(input), async interrupt() { throw new Error('BRIDGE_CANCEL_AMBIGUOUS'); } });
  const recovered = Promise.withResolvers();
  const wrapped = createRoutedExecutionPort(port, { configPath, renewIntervalMs: 2 });
  const intent = await wrapped.prepare({ role: 'builder', prompt: 'uncertain stop' }, '/source', {});
  t.after(() => wrapped.release(intent));
  await wrapped.launch({ intent, hooks: hooks({ recoveryRequired: cause => recovered.resolve(cause) }) });
  assert.equal(await Promise.race([recovered.promise, wait(1000)]), 'BRIDGE_ROUTER_LEASE_LOST');
  const { modulePath } = readAgentRouterConfig({ configPath });
  assert.deepEqual((await import(modulePath)).events, []);
});

test('lost followup lease only rebinds for observation and never reroutes or submits fresh input', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port, calls } = executionPort();
  const router = await import(modulePath);
  const wrapped = createRoutedExecutionPort(port, { configPath });
  const intent = await wrapped.prepare({ role: 'builder', prompt: 'kept', keepAlive: true }, '/source', {});
  t.after(() => wrapped.release(intent));
  const old = await wrapped.launch({ intent, hooks: hooks({ recoveryRequired() { assert.fail('stale recovery hook'); } }) });
  await old.hooks.settled({ terminal: true });
  router.leases.delete(intent.routing.id);
  const recovery = [];
  await assert.rejects(wrapped.launch({ intent, reply: 'must not submit', hooks: hooks({ expectedHandle: { id: 'same-worker' }, recoveryRequired: cause => recovery.push(cause) }) }), /BRIDGE_ROUTER_LEASE_LOST/);
  assert.equal(calls.launch.filter(input => !input.hooks.observeOnly).length, 1);
  assert.equal(calls.launch.at(-1).reply, undefined);
  assert.equal(router.events.filter(event => event.kind === 'route').length, 1);
  assert.deepEqual(recovery, ['BRIDGE_ROUTER_LEASE_LOST']);
});

test('lease loss during launch fences actual submission and reports the uncertain owned effect', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port } = executionPort();
  const router = await import(modulePath);
  const bound = Promise.withResolvers(); const continueLaunch = Promise.withResolvers(); const recovered = Promise.withResolvers();
  let submitted = false;
  const baseLaunch = port.launch;
  port.launch = async input => {
    if (input.hooks.observeOnly) return baseLaunch(input);
    input.hooks.recordHandle({ id: 'delayed-owned-worker' });
    bound.resolve(); await continueLaunch.promise;
    input.hooks.assertActive(); submitted = true;
    return baseLaunch(input);
  };
  const wrapped = createRoutedExecutionPort(port, { configPath, renewIntervalMs: 2 });
  const intent = await wrapped.prepare({ role: 'builder', prompt: 'launch delay' }, '/source', {});
  t.after(() => wrapped.release(intent));
  const launching = wrapped.launch({ intent, hooks: hooks({ recoveryRequired: cause => recovered.resolve(cause) }) });
  const rejected = assert.rejects(launching, /BRIDGE_ROUTER_LEASE_LOST/);
  await bound.promise; router.control.failRenew = true; await wait(15); continueLaunch.resolve();
  await rejected;
  assert.equal(await Promise.race([recovered.promise, wait(1000)]), 'BRIDGE_ROUTER_LEASE_LOST');
  assert.equal(submitted, false);
});

test('kept idle manual closure releases, but mismatched ownership and superseded stops do not', async t => {
  for (const observationError of ['BRIDGE_SESSION_UNAVAILABLE', 'BRIDGE_HANDLE_MISMATCH']) {
    const { modulePath, configPath } = fixture(t);
    const { port } = executionPort();
    const baseLaunch = port.launch; let closed = false;
    port.launch = async input => ({ ...await baseLaunch(input),
      async runtimeObservation() { if (closed) throw bridgeError(observationError); return { state: 'idle' }; },
      async interrupt(observer) { observer.superseded(); },
    });
    const wrapped = createRoutedExecutionPort(port, { configPath, renewIntervalMs: 2 });
    const intent = await wrapped.prepare({ role: 'builder', prompt: 'idle close', keepAlive: true }, '/source', {});
    t.after(() => wrapped.release(intent));
    const recovered = Promise.withResolvers();
    const driver = await wrapped.launch({ intent, hooks: hooks({ recoveryRequired: cause => recovered.resolve(cause) }) });
    await driver.hooks.settled({ terminal: true });
    await driver.interrupt({ settled() { assert.fail('no stop occurred'); }, superseded() {}, recoveryRequired() {} });
    assert.equal((await routerEvents(modulePath)).some(event => event.kind === 'release'), false);
    closed = true;
    await Promise.race([recovered.promise, wait(1000)]);
    assert.equal((await routerEvents(modulePath)).filter(event => event.kind === 'release').length, observationError === 'BRIDGE_SESSION_UNAVAILABLE' ? 1 : 0);
  }
});

test('missing and disabled config preserve the legacy execution port', async t => {
  const disabled = fixture(t, { enabled: false });
  const { port, calls } = executionPort();
  const wrapped = createRoutedExecutionPort(port, { configPath: disabled.configPath });
  const intent = await wrapped.prepare({ prompt: 'legacy' }, '/source', { workerHarness: 'native' });
  assert.equal(intent.model, 'legacy/default');
  assert.equal(intent.harness, 'pi');
  assert.equal(calls.prepare.length, 1);
  assert.deepEqual(await routerEvents(disabled.modulePath), []);

  const missing = createRoutedExecutionPort(port, { configPath: join(disabled.root, 'missing.json') });
  assert.equal((await missing.prepare({ prompt: 'missing' }, '/source', {})).model, 'legacy/default');
  assert.equal(readAgentRouterConfig({ configPath: join(disabled.root, 'missing.json') }).enabled, false);
});

test('keepAlive reserves capacity through terminal idle and followup turns until observed stop', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port, calls } = executionPort();
  const wrapped = createRoutedExecutionPort(port, { configPath, renewIntervalMs: 5 });
  const intent = await wrapped.prepare({ role: 'builder', harness: 'native', prompt: 'build it', keepAlive: true }, '/source', {});
  t.after(() => wrapped.release(intent));
  assert.equal(calls.launch.length, 0, 'prepare never launches');
  assert.deepEqual(intent.routing.selected, { model: 'openai-codex/routed-native', thinking: 'xhigh' });
  const { events, control } = await import(modulePath);
  control.capacity = 1;
  const first = await wrapped.launch({ intent, hooks: hooks() });
  assert.equal(events[1].kind, 'renew', 'renewal is awaited before any launch');
  assert.deepEqual(await first.hooks.settled({ terminal: false }), { terminal: false });
  assert.equal(events.some(event => event.kind === 'release'), false, 'blocked/in-progress retains reservation');
  await first.hooks.settled({ terminal: true });
  const renewals = events.length;
  await wait(16);
  assert.ok(events.length > renewals, 'terminal idle keeps renewing');
  await assert.rejects(wrapped.prepare({ role: 'builder', prompt: 'capacity probe' }, '/source', {}), /AGENT_ROUTER_NO_FEASIBLE_ROUTE/);
  const reply = await wrapped.launch({ intent, hooks: hooks({ expectedHandle: { id: 'same-worker' } }) });
  assert.deepEqual(reply.intent.routing, intent.routing);
  assert.equal(events.filter(event => event.kind === 'route').length, 2, 'only the explicit new capacity probe routes');
  await reply.hooks.settled({ terminal: true });
  assert.equal(events.some(event => event.kind === 'release'), false);
  await reply.interrupt({ settled() {}, recoveryRequired() {}, superseded() {} });
  assert.equal(events.filter(event => event.kind === 'release').length, 1);
});

test('non-keepAlive terminal releases once and refuses unreserved followups', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port, calls } = executionPort();
  const wrapped = createRoutedExecutionPort(port, { configPath });
  const intent = await wrapped.prepare({ role: 'builder', prompt: 'one turn' }, '/source', {});
  const first = await wrapped.launch({ intent, hooks: hooks() });
  await first.hooks.settled({ terminal: true });
  await first.hooks.settled({ terminal: true });
  await assert.rejects(wrapped.launch({ intent, hooks: hooks({ expectedHandle: { id: 'same-worker' } }) }), /BRIDGE_ROUTER_LEASE_LOST/);
  assert.equal(calls.launch.filter(input => !input.hooks.observeOnly).length, 1, 'no fresh input after release');
  const events = await routerEvents(modulePath);
  assert.equal(events.filter(event => event.kind === 'release').length, 1);
  assert.equal(events.filter(event => event.kind === 'route').length, 1);
});

test('unawaited cancellation observer failures do not release or become unhandled rejections', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port } = executionPort();
  const baseLaunch = port.launch;
  port.launch = async input => ({ ...await baseLaunch(input), async interrupt(observer) { observer.settled('idle', '', 2); } });
  const wrapped = createRoutedExecutionPort(port, { configPath });
  const intent = await wrapped.prepare({ role: 'builder', prompt: 'cancel observer fails', keepAlive: true }, '/source', {});
  t.after(() => wrapped.release(intent));
  const recovered = Promise.withResolvers();
  const driver = await wrapped.launch({ intent, hooks: hooks({ recoveryRequired: recovered.resolve }) });
  await driver.interrupt({ async settled() { throw new Error('OWNER_FENCE'); } });
  assert.equal(await Promise.race([recovered.promise, wait(1000)]), 'BRIDGE_ROUTER_LEASE_LOST');
  assert.equal((await routerEvents(modulePath)).some(event => event.kind === 'release'), false);
});

test('restart reconciliation keeps the routed identity and releases a completed reservation without rerouting', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port } = executionPort();
  const original = createRoutedExecutionPort(port, { configPath });
  const intent = await original.prepare({ role: 'builder', prompt: 'reconcile done' }, '/source', {});
  const restarted = createRoutedExecutionPort(port, { configPath });
  const driver = await restarted.launch({ intent, hooks: hooks({ expectedHandle: { id: 'recorded-worker' }, observeOnly: true, completed: true }) });
  assert.equal((await driver.runtimeObservation()).state, 'done');
  const events = await routerEvents(modulePath);
  assert.equal(events.filter(event => event.kind === 'route').length, 1);
  assert.equal(events.filter(event => event.kind === 'release' && event.id === intent.routing.id).length, 1);
});

test('freeform routing stays Pi-hosted and explicit model/thinking are authoritative pins', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port } = executionPort();
  const wrapped = createRoutedExecutionPort(port, { configPath });
  const freeform = await wrapped.prepare({ prompt: 'freeform' }, '/source', { workerHarness: 'native' });
  assert.equal(freeform.role, 'freeform');
  assert.equal(freeform.harness, 'pi');
  await assert.rejects(wrapped.prepare({ prompt: 'freeform native', harness: 'native' }, '/source', {}), /BRIDGE_INVALID_INPUT/);

  const modelPin = await wrapped.prepare({ role: 'builder', prompt: 'model pin', model: 'openai-codex/pinned' }, '/source', {});
  assert.equal(modelPin.model, 'openai-codex/pinned');
  assert.equal(modelPin.thinking, 'xhigh');
  const fullPin = await wrapped.prepare({ role: 'builder', prompt: 'full pin', model: 'openai-codex/pinned', thinking: 'low' }, '/source', {});
  assert.equal(fullPin.thinking, 'low');
  const routes = (await routerEvents(modulePath)).filter(event => event.kind === 'route');
  assert.equal(routes[0].request.harness, 'pi');
  assert.deepEqual(routes[1].request.pin, { model: 'openai-codex/pinned' });
  assert.deepEqual(routes[2].request.pin, { model: 'openai-codex/pinned', thinking: 'low' });
});

test('a duplicate router decision cannot release the original active reservation', async t => {
  const { modulePath, configPath } = fixture(t, { moduleSource: `
export const events=[];
export async function route(){events.push({kind:'route'});return {version:1,id:'same-decision',selected:{model:'openai-codex/routed-pi',thinking:'high'},strategy:'fallback',at:new Date().toISOString()}}
export async function renew(id){events.push({kind:'renew',id})}
export async function release(id){events.push({kind:'release',id})}
` });
  const { port } = executionPort();
  const wrapped = createRoutedExecutionPort(port, { configPath });
  const original = await wrapped.prepare({ role: 'builder', harness: 'pi', prompt: 'first' }, '/source', {});
  await assert.rejects(wrapped.prepare({ role: 'builder', harness: 'pi', prompt: 'second' }, '/source', {}), /AGENT_ROUTER_DECISION_INVALID/);
  const events = await routerEvents(modulePath);
  assert.equal(events.filter(event => event.kind === 'release').length, 0);
  await wrapped.release(original);
  assert.equal(events.filter(event => event.kind === 'release').length, 1);
});

test('invalid decisions and violated pins release reservations and fail closed', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port } = executionPort();
  const wrapped = createRoutedExecutionPort(port, { configPath });
  await assert.rejects(wrapped.prepare({ role: 'builder', prompt: 'invalid decision' }, '/source', {}), /AGENT_ROUTER_DECISION_INVALID/);
  await assert.rejects(wrapped.prepare({ role: 'builder', prompt: 'pin mismatch', model: 'openai-codex/pinned' }, '/source', {}), /AGENT_ROUTER_PIN_MISMATCH/);
  const events = await routerEvents(modulePath);
  assert.equal(events.filter(event => event.kind === 'release').length, 2);
});

test('normal validation remains ahead of routing and post-route validation releases without hiding the error', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port } = executionPort();
  const wrapped = createRoutedExecutionPort(port, { configPath });
  await assert.rejects(wrapped.prepare({ role: 'unknown', prompt: 'bad role' }, '/source', {}), /BRIDGE_UNKNOWN_ROLE/);
  await assert.rejects(wrapped.prepare({ role: 'builder', prompt: 'thinking only', thinking: 'high' }, '/source', {}), /BRIDGE_INVALID_INPUT/);
  assert.equal((await routerEvents(modulePath)).filter(event => event.kind === 'route').length, 0);

  await assert.rejects(wrapped.prepare({ role: 'builder', prompt: 'post-route failure' }, '/source', {}), /BRIDGE_EMPTY_PROMPT/);
  const events = await routerEvents(modulePath);
  assert.equal(events.filter(event => event.kind === 'route').length, 1);
  assert.equal(events.filter(event => event.kind === 'release').length, 1);
});

test('router and definitive launch failures reject without fallback; uncertain launch retains until explicit release', async t => {
  const { modulePath, configPath } = fixture(t);
  const { port, calls } = executionPort();
  const wrapped = createRoutedExecutionPort(port, { configPath, renewIntervalMs: 5 });
  await assert.rejects(wrapped.prepare({ role: 'builder', prompt: 'no route' }, '/source', {}), /AGENT_ROUTER_NO_FEASIBLE_ROUTE/);
  assert.equal(calls.launch.length, 0);

  const definitive = await wrapped.prepare({ role: 'builder', prompt: 'definitive launch failure' }, '/source', {});
  await assert.rejects(wrapped.launch({ intent: definitive, hooks: hooks() }), /agent command is empty/);
  let events = await routerEvents(modulePath);
  assert.equal(events.filter(event => event.kind === 'release' && event.id === definitive.routing.id).length, 1);

  const uncertain = await wrapped.prepare({ role: 'builder', prompt: 'uncertain launch failure' }, '/source', {});
  await assert.rejects(wrapped.launch({ intent: uncertain, hooks: hooks() }), /BRIDGE_PROMPT_AMBIGUOUS/);
  await wait(12);
  events = await routerEvents(modulePath);
  assert.ok(events.some(event => event.kind === 'renew' && event.id === uncertain.routing.id));
  assert.equal(events.some(event => event.kind === 'release' && event.id === uncertain.routing.id), false);
  await wrapped.release(uncertain);
});

test('invalid trusted config/module fail closed', async t => {
  const invalid = fixture(t);
  writeFileSync(invalid.configPath, JSON.stringify({ version: 1, enabled: true, modulePath: './untrusted.mjs' }));
  const { port } = executionPort();
  await assert.rejects(createRoutedExecutionPort(port, { configPath: invalid.configPath }).prepare({ prompt: 'task' }, '/source', {}), /AGENT_ROUTER_CONFIG_INVALID/);

  const malformed = fixture(t, { moduleSource: 'export async function route() {}' });
  await assert.rejects(createRoutedExecutionPort(port, { configPath: malformed.configPath }).prepare({ prompt: 'task' }, '/source', {}), /AGENT_ROUTER_MODULE_INVALID/);
});

test('lost admission acknowledgement never releases an already committed worker lease', async t => {
  const { root, modulePath, configPath } = fixture(t);
  const cwd = join(root, 'work'); mkdirSync(cwd);
  const stateRoot = join(root, 'state'); mkdirSync(stateRoot, { mode: 0o700 });
  const credentialPath = join(root, 'pi.json');
  const { port, calls } = executionPort();
  const host = await hostPiDetach({ stateRoot, cwd, sessionId: 'router-ack-loss', credentialPath, port, routerConfigPath: configPath, keepAlive: false });
  t.after(async () => { try { await host.service.close(); } catch { /* assertion cleanup */ } });
  const request = host.runtime.request.bind(host.runtime);
  host.runtime.request = async (token, input, audience) => {
    const response = await request(token, input, audience);
    return input.op === 'node.launch' && response.ok ? { ok: false, error: 'TEST_ADMISSION_ACK_LOST' } : response;
  };
  const client = createPiDetachClient(credentialPath);
  await assert.rejects(client.request('router-ack-loss', 'call', { tool: 'bg_agent', toolCallId: 'lost-ack', cwd, params: { role: 'builder', prompt: 'uncertain admission' } }), /TEST_ADMISSION_ACK_LOST/);
  await host.runtime.dispatch();
  assert.equal(calls.launch.length, 1);
  const events = await routerEvents(modulePath);
  assert.equal(events.some(event => event.kind === 'release'), false, 'queued effect retains capacity despite failed admission response');
  writeFileSync(join(calls.launch[0].intent.sourceDirectory, 'result.md'), '# Status\nPASS\nAdmitted before ACK loss.');
  await calls.launch[0].hooks.settled('done', 'finished', 2);
  assert.equal(events.filter(event => event.kind === 'release').length, 1);
});

test('managed host persists and returns auditable router identity without duplicate launch', async t => {
  const { root, modulePath, configPath } = fixture(t);
  const cwd = join(root, 'work'); mkdirSync(cwd);
  const stateRoot = join(root, 'state'); mkdirSync(stateRoot, { mode: 0o700 });
  const credentialPath = join(root, 'pi.json');
  const { port, calls } = executionPort();
  const host = await hostPiDetach({ stateRoot, cwd, sessionId: 'router-host', credentialPath, port, routerConfigPath: configPath, keepAlive: false });
  t.after(async () => { try { await host.service.close(); } catch { /* assertion cleanup */ } });
  const client = createPiDetachClient(credentialPath);
  const admitted = await client.request('router-host', 'call', { tool: 'bg_agent', toolCallId: 'routed-launch', cwd, params: { role: 'builder', harness: 'pi', prompt: 'managed route' } });
  assert.deepEqual(admitted.routing.selected, { model: 'openai-codex/routed-pi', thinking: 'xhigh' });
  assert.ok(calls.launch.length <= 1, 'admission can dispatch only its one recorded effect');
  if (calls.launch.length === 0) await host.runtime.dispatch();
  for (let i = 0; i < 50 && calls.launch.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.launch.length, 1);
  assert.deepEqual(calls.launch[0].intent.routing, admitted.routing);

  const db = new DatabaseSync(join(stateRoot, 'runtime.sqlite'), { readOnly: true });
  try {
    const run = JSON.parse(db.prepare('SELECT data FROM runs').get().data);
    assert.deepEqual(run.nodes.worker.packet.execution.routing, admitted.routing);
    const launched = db.prepare('SELECT data FROM events').all().map(row => JSON.parse(row.data)).find(event => event.type === 'node.launched');
    assert.equal(launched.data.model, admitted.routing.selected.model);
    assert.equal(launched.data.thinking, admitted.routing.selected.thinking);
  } finally { db.close(); }
  const listed = await client.request('router-host', 'list', {});
  assert.deepEqual(listed[0].node.packet.execution.routing, admitted.routing);

  for (let i = 0; i < 50; i++) {
    const state = new DatabaseSync(join(stateRoot, 'runtime.sqlite'), { readOnly: true });
    const effectState = state.prepare('SELECT state FROM effects').get().state; state.close();
    if (effectState === 'done') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  writeFileSync(join(calls.launch[0].intent.sourceDirectory, 'result.md'), '# Status\nPASS\nRouted fixture.');
  await calls.launch[0].hooks.settled('done', 'routed fixture', 2);
  await assert.rejects(client.request('router-host', 'call', { tool: 'bg_agent', toolCallId: 'no-route', cwd, params: { role: 'builder', prompt: 'no route' } }), /AGENT_ROUTER_NO_FEASIBLE_ROUTE/);
  assert.equal(calls.launch.length, 1, 'router refusal creates no worker effect');
  const events = await routerEvents(modulePath);
  assert.equal(events.filter(event => event.kind === 'route').length, 2);
  assert.equal(events.filter(event => event.kind === 'release').length, 1);
});

test('packet validation binds routed identity to execution identity', () => {
  const { port } = executionPort();
  return port.prepare({ role: 'builder', prompt: 'packet', model: 'openai-codex/model', thinking: 'high' }, '/source', {}).then(execution => {
    execution.routing = { version: 1, id: 'decision', selected: { model: execution.model, thinking: execution.thinking }, strategy: 'fallback', at: new Date().toISOString() };
    const packet = { role: execution.role, task: execution.prompt, acceptance: ['done'], cwd: '/work', adapter: 'pi-detach', model: execution.model, thinking: execution.thinking, execution };
    assert.doesNotThrow(() => validatePacket(packet));
    execution.routing.selected.model = 'openai-codex/tampered';
    assert.throws(() => validatePacket(packet), /EXECUTION_ROUTING_MISMATCH/);
  });
});
