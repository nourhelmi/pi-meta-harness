import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostPiDetach } from '../scripts/advisor-runtime/pi-detach-host.mjs';
import { createPiDetachClient } from '../scripts/advisor-runtime/pi-detach-client.mjs';
import { closeChildService, closeChildServices, installedRevision } from '../scripts/advisor-runtime/pi-detach-bootstrap.mjs';

function temporary(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lc-')));
  mkdirSync(join(base, 'work'), { mode: 0o700 });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

/** Execution port stub: records launches, binds a handle, and lets the test settle the worker itself. */
function stubPort() {
  const launches = [];
  const port = {
    version: 1,
    async prepare(params, sourceDirectory) {
      return { v: 1, command: 'pi --stub', prompt: params.prompt, role: 'builder', runtime: 'pi', model: 'fixture', thinking: 'none', maxTurns: null, requiredSkills: [], harness: 'pi', keepAlive: false, label: 'stub', resultDiscovery: null, resultPolicy: 'runtime-capture', sourceDirectory,
        environment: { ADVISOR_RUNTIME_DESCRIPTOR: '', PI_DETACH_RUNTIME_BRIDGE: '', ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_RUNTIME_CANONICAL_OWNER: '1' } };
    },
    async launch({ hooks, intent }) {
      launches.push({ hooks, intent });
      hooks.recordHandle({ id: `stub-${launches.length}`, session: 'stub-session' });
      return { async interrupt() {}, async readLive() { return 'live'; } };
    },
  };
  return { port, launches };
}

async function service(t, base, stateRoot, sessionId, extra = {}) {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const { port, launches } = stubPort();
  const host = await hostPiDetach({ stateRoot, cwd: join(base, 'work'), sessionId, credentialPath: join(stateRoot, 'pi.json'), port, slots: 2, keepAlive: false, ...extra });
  const client = createPiDetachClient(join(stateRoot, 'pi.json'));
  const request = (action, payload = {}) => client.request(sessionId, action, payload);
  t.after(async () => { try { await host.service.close(); } catch { /* closed or refused by design */ } });
  return { stateRoot, host, launches, request };
}

/** Reserved child services record the identity their parent supervisor reads. */
async function child(t, base, parentRoot, name, sessionId) {
  const stateRoot = join(parentRoot, 'children', name);
  const started = await service(t, base, stateRoot, sessionId);
  writeFileSync(join(stateRoot, 'startup.json'), JSON.stringify({ identity: { sessionId }, roots: [] }), { mode: 0o600 });
  return started;
}

async function launch(started, base, toolCallId) {
  const admitted = await started.request('call', { tool: 'bg_agent', toolCallId, cwd: join(base, 'work'), params: { prompt: 'Bounded fixture task' } });
  await started.host.runtime.dispatch();
  for (let i = 0; i < 100 && started.launches.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(started.launches.length, 1);
  return admitted.runId;
}

async function settleAndAck(started, runId) {
  const { hooks, intent } = started.launches.at(-1);
  writeFileSync(join(intent.sourceDirectory, 'result.md'), '# Status\nPASS\n# Claims\nFixture.', { mode: 0o600 });
  hooks.settled('done', 'fixture output', 2);
  assert.equal((await started.request('get', { runId })).snapshot.state, 'terminal');
  for (const delivery of await started.request('wait', { runId, timeoutMs: 0 })) await started.request('ack', { runId, deliveryId: delivery.id });
}

const alive = stateRoot => existsSync(join(stateRoot, 'service.lock', 'owner.json'));

test('installed revision hashes detach sources plus runtime and core helpers deterministically', t => {
  const base = temporary(t);
  const detach = join(base, 'detach'); const host = join(base, 'agent', 'scripts', 'advisor-runtime', 'pi-detach-host.mjs');
  mkdirSync(join(detach, 'src', 'herdr'), { recursive: true }); mkdirSync(join(base, 'agent', 'scripts', 'advisor-core'), { recursive: true }); mkdirSync(join(base, 'agent', 'scripts', 'advisor-runtime'));
  writeFileSync(join(detach, 'src', 'herdr', 'driver.ts'), 'export const a = 1;'); writeFileSync(host, '// host'); writeFileSync(join(base, 'agent', 'scripts', 'advisor-core', 'x.mjs'), 'export const x = 1;');
  const first = installedRevision(detach, host);
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(installedRevision(detach, host), first, 'same bytes, same revision');
  writeFileSync(join(detach, 'src', '.hidden'), 'ignored');
  assert.equal(installedRevision(detach, host), first, 'dotfiles are not code');
  mkdirSync(join(detach, 'src', '.cache')); writeFileSync(join(detach, 'src', '.cache', 'generated.ts'), 'export const generated = true;');
  assert.equal(installedRevision(detach, host), first, 'hidden directories are not code either');
  writeFileSync(join(detach, 'src', 'herdr', 'driver.ts'), 'export const a = 2;');
  const changed = installedRevision(detach, host);
  assert.notEqual(changed, first, 'a driver edit changes the revision');
  writeFileSync(join(base, 'agent', 'scripts', 'advisor-core', 'x.mjs'), 'export const x = 2;');
  assert.notEqual(installedRevision(detach, host), changed, 'a core helper edit changes the revision');
});

test('connect and supervision report the revision the service started with; malformed revisions are refused', async t => {
  const base = temporary(t);
  const revision = 'ab'.repeat(16);
  const started = await service(t, base, join(base, 'state'), 'rev-session', { managedIdentity: { fixture: true }, revision });
  const ready = await started.request('connect', { identity: { fixture: true }, cwd: join(base, 'work') });
  assert.deepEqual(ready, { ready: true, revision });
  assert.deepEqual(await started.request('supervision'), { settled: true, revision });
  const plain = await service(t, base, join(base, 'plain'), 'plain-session');
  assert.deepEqual(await plain.request('supervision'), { settled: true, revision: null });
  await assert.rejects(hostPiDetach({ stateRoot: join(base, 'bad'), cwd: join(base, 'work'), sessionId: 'bad', credentialPath: join(base, 'bad', 'pi.json'), port: stubPort().port, revision: 'not-a-revision' }), /BRIDGE_REVISION/);
});

test('child services close only by typed shutdown after their work settles and is acknowledged', async t => {
  const base = temporary(t); const parentRoot = join(base, 'parent');
  mkdirSync(join(parentRoot, 'children', 'never-started'), { recursive: true, mode: 0o700 });
  assert.equal(await closeChildService(join(parentRoot, 'children', 'never-started')), 'absent');
  const a = await child(t, base, parentRoot, 'a', 'child-a');
  const runId = await launch(a, base, 'launch-a');
  await assert.rejects(closeChildService(a.stateRoot), /SHUTDOWN_CHILD_ACTIVE/);
  await assert.rejects(closeChildServices(parentRoot), /SHUTDOWN_CHILD_ACTIVE/);
  assert.equal(alive(a.stateRoot), true, 'a refused child keeps running');
  assert.equal((await a.request('supervision')).settled, false);
  const { hooks, intent } = a.launches[0];
  writeFileSync(join(intent.sourceDirectory, 'result.md'), '# Status\nPASS\n# Claims\nFixture.', { mode: 0o600 });
  hooks.settled('done', 'fixture output', 2);
  await assert.rejects(closeChildService(a.stateRoot), /SHUTDOWN_CHILD_ACTIVE/, 'unacknowledged deliveries keep the child alive');
  for (const delivery of await a.request('wait', { runId, timeoutMs: 0 })) await a.request('ack', { runId, deliveryId: delivery.id });
  assert.deepEqual(await closeChildServices(parentRoot), [a.stateRoot]);
  assert.equal(alive(a.stateRoot), false);
  assert.equal(await closeChildService(a.stateRoot), 'absent', 'a closed child is not closed twice');
  assert.deepEqual(await closeChildServices(parentRoot), []);
});

test('a live owner without control files is uncertain; a dead owner is absent', async t => {
  const base = temporary(t); const parentRoot = join(base, 'parent');
  const booting = join(parentRoot, 'children', 'booting');
  mkdirSync(join(booting, 'service.lock'), { recursive: true, mode: 0o700 });
  writeFileSync(join(booting, 'service.lock', 'owner.json'), JSON.stringify({ pid: process.pid, nonce: 'fixture' }), { mode: 0o600 });
  writeFileSync(join(booting, 'startup.json'), JSON.stringify({ identity: { sessionId: 'booting' } }), { mode: 0o600 });
  await assert.rejects(closeChildService(booting), /SHUTDOWN_CHILD_UNCERTAIN/, 'descriptor not yet published while the owner lives');
  await assert.rejects(closeChildServices(parentRoot), /SHUTDOWN_CHILD_UNCERTAIN/);
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  writeFileSync(join(booting, 'service.lock', 'owner.json'), JSON.stringify({ pid: dead, nonce: 'fixture' }), { mode: 0o600 });
  assert.equal(await closeChildService(booting), 'absent', 'a dead owner is absent whatever files remain');
  assert.deepEqual(await closeChildServices(parentRoot), []);
});

test('parent shutdown checks its own work first, then closes reachable children, and refuses for an active child', async t => {
  const base = temporary(t); const parentRoot = join(base, 'parent');
  const parent = await service(t, base, parentRoot, 'parent-session');
  const b = await child(t, base, parentRoot, 'b', 'child-b');
  const childRun = await launch(b, base, 'launch-b');
  const ownRun = await launch(parent, base, 'launch-parent');
  await assert.rejects(parent.host.service.close(), /SHUTDOWN_ACTIVE/, 'own active work refuses before any child is touched');
  assert.equal(alive(b.stateRoot), true);
  await settleAndAck(parent, ownRun);
  await assert.rejects(parent.host.service.close(), /SHUTDOWN_CHILD_ACTIVE/);
  assert.equal(alive(parentRoot), true, 'a refused parent keeps serving');
  assert.equal((await parent.request('list')).length, 1);
  await settleAndAck(b, childRun);
  await parent.host.service.close();
  assert.equal(alive(b.stateRoot), false, 'parent close closed its settled child');
  assert.equal(alive(parentRoot), false);
});

for (const kind of ['directories', 'files', 'depth', 'hidden']) {
  test(`revision traversal bounds ${kind} before recursive enumeration`, t => {
    const base = temporary(t); const detach = join(base, 'detach');
    const runtimeDir = join(base, 'advisor-runtime'); const host = join(runtimeDir, 'host.mjs');
    const source = join(detach, 'src');
    for (const dir of [source, runtimeDir, join(base, 'advisor-core')]) mkdirSync(dir, { recursive: true });
    writeFileSync(host, '// host');
    const initial = installedRevision(detach, host);
    let target = source;
    if (kind === 'hidden') { target = join(source, '.cache'); mkdirSync(target); }
    if (kind === 'depth') {
      for (let i = 0; i < 65; i++) { target = join(target, 'd'); mkdirSync(target); }
    } else {
      for (let i = 0; i < 2501; i++) {
        const path = join(target, String(i));
        if (kind === 'files') writeFileSync(path, '// file'); else mkdirSync(path);
      }
    }
    if (kind === 'hidden') assert.equal(installedRevision(detach, host), initial, 'hidden descendants are not traversed');
    else assert.throws(() => installedRevision(detach, host), { code: 'PI_DETACH_REVISION_BOUND' });
  });
}

test('damaged live child control is typed uncertainty and the parent stays available', async t => {
  const base = temporary(t); const parent = await service(t, base, join(base, 'p'), 'parent');
  const owned = await child(t, base, parent.stateRoot, 'c', 'child');
  const marker = join(owned.stateRoot, 'startup.json'); const descriptor = join(owned.stateRoot, 'pi.json');
  const markerBytes = readFileSync(marker); const descriptorBytes = readFileSync(descriptor);
  const mutations = [
    () => writeFileSync(marker, '{'),
    () => writeFileSync(marker, 'null'),
    () => writeFileSync(marker, JSON.stringify({ identity: null })),
    () => writeFileSync(marker, JSON.stringify({ identity: [] })),
    () => writeFileSync(marker, JSON.stringify({ identity: { sessionId: '' } })),
    () => writeFileSync(marker, JSON.stringify({ identity: { sessionId: 42 } })),
    () => writeFileSync(marker, JSON.stringify({ identity: { sessionId: 'x'.repeat(257) } })),
    () => writeFileSync(marker, JSON.stringify({ identity: { sessionId: 'wrong-session' } })),
    () => writeFileSync(marker, ' '.repeat(65537)),
    () => chmodSync(marker, 0o644),
    () => writeFileSync(descriptor, '{'),
    () => { const value = JSON.parse(descriptorBytes); value.token = '0'.repeat(64); writeFileSync(descriptor, JSON.stringify(value)); },
    () => { const value = JSON.parse(descriptorBytes); value.socketPath = join(base, 'missing.sock'); writeFileSync(descriptor, JSON.stringify(value)); },
  ];
  for (const mutate of mutations) {
    try {
      mutate();
      await assert.rejects(closeChildService(owned.stateRoot), { code: 'SHUTDOWN_CHILD_UNCERTAIN' });
      await assert.rejects(parent.request('shutdown'), /^Error: SHUTDOWN_CHILD_UNCERTAIN$/);
      assert.equal(alive(parent.stateRoot), true); assert.equal(alive(owned.stateRoot), true);
      assert.deepEqual(await parent.request('list'), [], 'refusal leaves the parent serving');
    } finally {
      chmodSync(marker, 0o600); writeFileSync(marker, markerBytes); writeFileSync(descriptor, descriptorBytes);
    }
  }
  await parent.request('shutdown');
  assert.equal(alive(parent.stateRoot), false); assert.equal(alive(owned.stateRoot), false);
});

test('a superseded terminal cancellation never advertises a new task as reusable', async t => {
  const base = temporary(t); const { port } = stubPort(); const prepare = port.prepare;
  port.prepare = async (...args) => ({ ...await prepare(...args), keepAlive: true });
  port.launch = async ({ hooks, intent }) => {
    hooks.recordHandle({ id: 'same-worker', session: 'same-session' });
    return { async readLive() { return 'live'; }, async interrupt(observer) {
      writeFileSync(join(intent.sourceDirectory, 'result.md'), '# Status\nPASS\nNatural settlement won.');
      assert.deepEqual(hooks.settled('done', 'natural output', 2), { terminal: true, close: true });
      observer.superseded();
    } };
  };
  const started = await service(t, base, join(base, 'state'), 'race', { port });
  const admitted = await started.request('call', { tool: 'bg_agent', toolCallId: 'launch', cwd: join(base, 'work'), params: { prompt: 'finish', keepAlive: true } });
  await started.host.runtime.dispatch();
  await started.request('call', { tool: 'bg_stop', toolCallId: 'stop', cwd: join(base, 'work'), params: { runId: admitted.runId } });
  await started.host.runtime.dispatch();
  const node = await started.request('get', { runId: admitted.runId });
  const sealed = await started.request('result', { toolCallId: 'launch', seal: true });
  assert.equal(node.snapshot.state, 'terminal'); assert.equal(node.status, 'done'); assert.ok(node.snapshot.cancel);
  assert.equal(sealed.status, 'done'); assert.equal(sealed.keepAlive, true); assert.equal(sealed.reusable, false);
  await assert.rejects(started.request('call', { tool: 'bg_agent', toolCallId: 'task', cwd: join(base, 'work'), params: { name: admitted.runId, prompt: 'next' } }), /TASK_TARGET_UNAVAILABLE/);
  for (const delivery of await started.request('wait', { runId: admitted.runId })) await started.request('ack', { runId: admitted.runId, deliveryId: delivery.id });
  await started.host.service.close();
});

for (const [status, reusable, close] of [['PASS', true, true], ['FAIL', true, false], ['IN PROGRESS', false, false]]) {
  test(`sealed ${status} result separates task eligibility from pane closing`, async t => {
    const base = temporary(t); const { port, launches } = stubPort(); const prepare = port.prepare;
    port.prepare = async (...args) => ({ ...await prepare(...args), keepAlive: true });
    const started = await service(t, base, join(base, 'state'), 'eligibility', { port });
    const admitted = await started.request('call', { tool: 'bg_agent', toolCallId: 'launch', cwd: join(base, 'work'), params: { prompt: 'finish', keepAlive: true } });
    await started.host.runtime.dispatch();
    const { hooks, intent } = launches[0];
    writeFileSync(join(intent.sourceDirectory, 'result.md'), `# Status\n${status}\nFixture.`);
    assert.deepEqual(hooks.settled('done', 'output', 2), { terminal: true, close });
    const sealed = await started.request('result', { toolCallId: 'launch', seal: true });
    assert.equal(sealed.keepAlive, true); assert.equal(sealed.reusable, reusable);
    for (const delivery of await started.request('wait', { runId: admitted.runId })) await started.request('ack', { runId: admitted.runId, deliveryId: delivery.id });
    await started.host.service.close();
  });
}
