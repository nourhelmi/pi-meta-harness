import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostPiDetach } from '../scripts/advisor-runtime/pi-detach-host.mjs';
import { createPiDetachClient } from '../scripts/advisor-runtime/pi-detach-client.mjs';
import { callSocket } from '../scripts/advisor-runtime/service.mjs';
import { childWorkSettled, readChildScope } from '../scripts/advisor-runtime/pi-detach-bootstrap.mjs';
import { childStatePath, readChildGrant, familyCall } from '../scripts/advisor-runtime/child-scope.mjs';

function fixture(t) {
  const base = realpathSync(mkdtempSync('/tmp/fam-')); const cwd = join(base, 'work'); mkdirSync(cwd);
  const hosts = [];
  t.after(async () => { for (const host of hosts.reverse()) try { await host.service.close(); } catch {} rmSync(base, { recursive: true, force: true }); });
  async function start(name, options = {}) {
    const stateRoot = options.stateRoot ?? join(base, name); const launches = []; const messages = [];
    const port = { version: 1,
      async prepare(params, sourceDirectory, scope) { if (options.prepareGate) await options.prepareGate; return { v: 1, command: 'fixture', prompt: params.prompt, role: params.role ?? 'foreman', runtime: 'pi', model: 'fixture', thinking: 'none', maxTurns: null, requiredSkills: [], harness: 'pi', keepAlive: true, label: 'fixture', resultDiscovery: null, resultPolicy: 'runtime-capture', sourceDirectory,
        environment: { ADVISOR_RUNTIME_DESCRIPTOR: '', PI_DETACH_RUNTIME_BRIDGE: '', ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_RUNTIME_CANONICAL_OWNER: '1', ADVISOR_BRIDGE_CHILD_STATE: params.delegate ? scope.childState : '', ...(scope.teamMode && params.role === 'advisor' ? { ADVISOR_TEAM_MODE: '1' } : {}) } }; },
      async launch({ hooks, intent, reply }) {
        const generation = launches.length * 2 + 1; const handle = { id: `fixture-${intent.sourceDirectory}`, session: `fixture-session-${intent.sourceDirectory}` };
        const launch = { hooks, intent, reply, generation, handle }; launches.push(launch); hooks.recordHandle(handle);
        return { async interrupt(observer) { launch.observer = observer; }, async readLive() { return 'fixture'; },
          async runtimeObservation() { return { session: handle.session, generation, state: 'working', runtime: 'pi' }; },
          async message(input) { messages.push({ input, launch }); return { status: 'queued', session: handle.session, generation, state: 'working' }; } };
      },
    };
    const opts = { cwd, stateRoot, sessionId: name, credentialPath: join(stateRoot, 'pi.json'), port, maxLaunches: 4, keepAlive: false, managedIdentity: { fixture: true }, ...options };
    const host = await hostPiDetach(opts); hosts.push(host);
    writeFileSync(join(stateRoot, 'startup.json'), JSON.stringify({ identity: { sessionId: name } }), { mode: 0o600 });
    const client = createPiDetachClient(opts.credentialPath);
    const request = (action, payload = {}) => client.request(name, action, payload);
    const launch = async (key, params = {}) => { const result = await request('call', { toolCallId: key, tool: 'bg_agent', cwd, params: { prompt: 'task', ...params } }); await host.runtime.dispatch(); return result.runId; };
    const settle = (status = 'PASS') => { const { intent, hooks } = launches.at(-1); writeFileSync(join(intent.sourceDirectory, 'result.md'), `# Status\n${status}\n# Claims\nfixture`); hooks.settled('done', 'output', launches.length * 2); };
    const ack = async runId => { for (const d of await request('wait', { runId })) await request('ack', { runId, deliveryId: d.id }); };
    const rows = table => { const db = new DatabaseSync(join(stateRoot, 'runtime.sqlite'), { readOnly: true }); try { return db.prepare(`SELECT * FROM ${table}`).all(); } finally { db.close(); } };
    return { host, opts, launches, messages, stateRoot, request, launch, settle, ack, rows };
  }
  return { base, cwd, start };
}

test('root persistent family ledger counts launches, replies and tasks and survives a typed restart', async t => {
  const f = fixture(t); const root = await f.start('root');
  const runId = await root.launch('one'); root.settle('BLOCKED');
  await root.launch('reply', { name: runId, prompt: 'answer' }); root.settle();
  await root.launch('task', { name: runId, prompt: 'repair' }); root.settle();
  assert.equal((await root.request('family.budget')).used, 3);
  await root.launch('task', { name: runId, prompt: 'repair' });
  assert.equal((await root.request('family.budget')).used, 3);
  await root.ack(runId); await root.host.service.close();
  assert.equal(await childWorkSettled(root.stateRoot), true, 'typed close retains quiescence, not process-exit proof');
  const restarted = await f.start('root');
  assert.equal(await childWorkSettled(root.stateRoot), false, 'a new owner lock invalidates the old typed close proof');
  assert.equal((await restarted.request('get', { runId })).runtimeState, 'recovery-required');
  assert.equal((await restarted.request('family.budget')).used, 3);
  const next = await restarted.launch('new'); restarted.settle(); await restarted.ack(next);
  await assert.rejects(restarted.launch('over'), /BRIDGE_LAUNCH_LIMIT/);
  assert.equal((await restarted.request('family.budget')).used, 4);
  assert.deepEqual(restarted.rows('effects').filter(row => row.run === runId).map(row => JSON.parse(row.data).op), ['node.launch', 'node.reply', 'node.task']);
});

test('v1 grants are readable but never gain recursive or fresh budget authority; stored foreman evidence remains unchanged', async t => {
  const f = fixture(t); const stateRoot = join(f.base, 'legacy'); mkdirSync(stateRoot, { mode: 0o700 });
  const grant = { v: 1, stateRoot, cwd: f.cwd }; const bytes = JSON.stringify(grant); const path = join(stateRoot, 'child-grant.json');
  writeFileSync(path, bytes, { mode: 0o600 });
  const legacy = await f.start('legacy', { stateRoot });
  assert.deepEqual(readChildGrant(stateRoot, f.cwd), grant);
  assert.deepEqual(await legacy.request('list'), []);
  await assert.rejects(legacy.launch('new-delegation', { delegate: true }), /PI_DETACH_LEGACY_CHILD_REQUIRES_REISSUE/);
  await assert.rejects(readChildScope({ cwd: f.cwd, env: { ADVISOR_BRIDGE_CHILD_STATE: stateRoot } }), /PI_DETACH_LEGACY_CHILD_REQUIRES_REISSUE/);
  assert.equal(readFileSync(path, 'utf8'), bytes); assert.equal(legacy.rows('family_state').length, 0);
  assert.equal(legacy.rows('effects').length, 0);
  await legacy.host.service.close();
  const root = await f.start('recorded'); const runId = await root.launch('foreman'); root.settle();
  const old = await root.request('get', { runId }); const result = readFileSync(old.result.path);
  await root.launch('foreman-followup', { name: runId, prompt: 'bounded continuation' }); root.settle();
  assert.equal((await root.request('get', { runId })).packet.role, 'foreman');
  assert.deepEqual(readFileSync(old.result.path), result); await root.ack(runId);
});

test('unmetered historical control remains readable and fails admission without silently initializing an allowance', async t => {
  const f = fixture(t); const root = await f.start('old-root'); const runId = await root.launch('recorded'); root.settle(); await root.ack(runId); await root.host.service.close();
  // Disposable pre-upgrade fixture: the historical schema has no family tables.
  const db = new DatabaseSync(join(root.stateRoot, 'runtime.sqlite')); db.exec('DROP TABLE family_state; DROP TABLE family_admissions;'); db.close();
  const before = root.rows('pi_bindings'); const restored = await f.start('old-root');
  assert.equal((await restored.request('get', { runId })).packet.role, 'foreman');
  assert.deepEqual(restored.rows('pi_bindings'), before);
  await assert.rejects(restored.launch('fresh'), /FAMILY_LEGACY_ACCOUNTING_REQUIRED/);
  await assert.rejects(restored.request('advisor.bind', { workstream: 'new', workerHarness: 'pi' }), /FAMILY_LEGACY_ACCOUNTING_REQUIRED/);
  assert.equal(restored.rows('family_state').length, 0);
});

test('grant registration is exact, bound to one child session, workspace fenced, and cannot reuse foreign authority', async t => {
  const f = fixture(t); const root = await f.start('root'); const runId = await root.launch('delegating', { delegate: true });
  const node = await root.request('get', { runId }); const stateRoot = node.childService.stateRoot;
  const grant = readChildGrant(stateRoot, f.cwd); const bytes = readFileSync(join(stateRoot, 'child-grant.json'));
  const child = await f.start('child', { stateRoot });
  const otherRoot = await f.start('other');
  const capability = { socketPath: join(otherRoot.stateRoot, 'runtime.sock'), token: grant.authority.token };
  assert.equal((await callSocket(capability, { v: 1, op: 'family', action: 'budget', payload: {} }, 'model')).error, 'FAMILY_UNAUTHORIZED');
  await assert.rejects(f.start('foreign-session', { stateRoot }), /PI_DETACH_BINDING_MISMATCH/);
  await assert.rejects(familyCall(grant, 'register', { scope: { ...node.snapshot.scope, workstream: 'foreign' }, cwd: f.cwd, issuedAttempt: 1 }), /FAMILY_SCOPE_FORBIDDEN/);
  const owned = { ...(await child.launch('leaf').then(runId => child.request('get', { runId }))).snapshot.scope };
  await assert.rejects(familyCall(grant, 'register', { scope: owned, cwd: f.base, issuedAttempt: 1 }), /FAMILY_CWD_FORBIDDEN/);
  const source = join(stateRoot, 'child-grant.json'); chmodSync(source, 0o644); assert.throws(() => readChildGrant(stateRoot, f.cwd), /UNSAFE_FILE/); chmodSync(source, 0o600);
  const alias = join(f.base, 'alias'); symlinkSync(stateRoot, alias); assert.throws(() => readChildGrant(alias, f.cwd), /SYMLINK/);
  const copied = join(f.base, 'copied'); mkdirSync(copied, { mode: 0o700 }); writeFileSync(join(copied, 'child-grant.json'), bytes, { mode: 0o600 });
  await assert.rejects(f.start('copied', { stateRoot: copied }), /PI_DETACH_CHILD_GRANT_MISMATCH/);
  assert.equal(existsSync(join(copied, 'runtime.sqlite')), false, 'grant failure precedes service ownership writes');
  assert.equal(child.rows('family_state').length, 0, 'no child-local allowance');
  child.settle();
});

test('a started v2 child with a dead owner remains shutdown uncertainty, never an absent subtree', async t => {
  const f = fixture(t); const root = await f.start('root'); const runId = await root.launch('advisor', { delegate: true });
  const node = await root.request('get', { runId }); const stateRoot = node.childService.stateRoot;
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  mkdirSync(join(stateRoot, 'service.lock'), { mode: 0o700 });
  writeFileSync(join(stateRoot, 'service.lock', 'owner.json'), JSON.stringify({ pid: dead, nonce: 'fixture' }), { mode: 0o600 });
  writeFileSync(join(stateRoot, 'startup.json'), JSON.stringify({ identity: { sessionId: 'dead-child' } }), { mode: 0o600 });
  root.settle(); await root.ack(runId);
  assert.equal((await root.request('supervision')).settled, false);
  await assert.rejects(root.host.service.close(), /SHUTDOWN_CHILD_UNCERTAIN/);
  assert.equal(existsSync(join(root.stateRoot, 'service.lock')), true);
  assert.equal(existsSync(join(stateRoot, 'service.lock')), true, 'no adoption or lock deletion');
});

test('missing or dead child runtime is not fabricated cancellation or settlement', async t => {
  const f = fixture(t); const root = await f.start('root'); const runId = await root.launch('unbootstrapped', { delegate: true });
  const node = await root.request('get', { runId });
  await root.request('call', { tool: 'bg_stop', toolCallId: 'cancel', cwd: f.cwd, params: { runId } }); await root.host.runtime.dispatch();
  const cancelled = await root.request('get', { runId });
  assert.equal(cancelled.runtimeState, 'recovery-required'); assert.notEqual(cancelled.status, 'cancelled'); assert.equal(cancelled.processExited, undefined);
  assert.equal((await root.request('supervision')).settled, false); assert.equal(await childWorkSettled(node.childService.stateRoot), false);
  assert.equal(root.launches[0].observer, undefined, 'unreachable child cannot certify parent Escape');
  await assert.rejects(root.host.service.close(), /SHUTDOWN/);
});

test('flat path remains bounded where recursive child directories would exceed the socket admission limit', () => {
  const root = '/tmp/' + 'r'.repeat(40);
  const first = childStatePath(root, root, 'first'); const second = childStatePath(root, first, 'second');
  assert.equal(first.length, second.length); assert.ok(Buffer.byteLength(join(second, 'runtime.sock')) <= 100);
  assert.ok(Buffer.byteLength(join(root, 'children', 'x'.repeat(20), 'children', 'y'.repeat(20), 'runtime.sock')) > 100);
});

test('cancellation seals in-flight preparation before it can commit a worker execution', async t => {
  const f = fixture(t); const root = await f.start('root'); const advisor = await root.launch('advisor', { delegate: true });
  const parent = await root.request('get', { runId: advisor });
  let release;
  const prepareGate = new Promise(resolve => { release = resolve; });
  const child = await f.start('child', { stateRoot: parent.childService.stateRoot, prepareGate });
  const pending = child.launch('preparing');
  const rejected = assert.rejects(pending, /FAMILY_ADMISSION_SEALED/);
  for (let i = 0; i < 100 && !child.rows('pi_bindings').length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(child.rows('pi_bindings').length, 1);
  await assert.rejects(child.host.service.close(), /SHUTDOWN_PENDING/, 'typed close cannot race unfinished preparation');
  const cancelled = await child.request('cancel'); assert.equal(cancelled.uncertain, true);
  release(); await rejected;
  assert.equal(child.launches.length, 0); assert.equal(child.rows('effects').length, 0);
  assert.equal((await child.request('supervision')).settled, true, 'durable rejection resolves the pending binding without fabricating a worker');
  assert.equal((await root.request('family.budget')).used, 1);
});

test('root and child concurrent admissions share the same final allowance, with exact replay and no refunds', async t => {
  const f = fixture(t); const root = await f.start('root', { maxLaunches: 3 }); const advisor = await root.launch('advisor', { delegate: true });
  const parent = await root.request('get', { runId: advisor }); const child = await f.start('child', { stateRoot: parent.childService.stateRoot, maxLaunches: 1 });
  const results = await Promise.allSettled([root.launch('root-leaf'), child.launch('child-one'), child.launch('child-two')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await root.request('family.budget')).used, 3); assert.equal((await child.request('family.budget')).remaining, 0);
  const accepted = results.findIndex((result, index) => index > 0 && result.status === 'fulfilled');
  await child.launch(accepted === 1 ? 'child-one' : 'child-two');
  assert.equal((await root.request('family.budget')).used, 3);
  const command = JSON.parse(child.rows('effects')[0].data);
  const forged = { v: 1, op: 'node.task', scope: { ...command.scope, ownerEpoch: 99 }, commandId: 'foreign-epoch', expectedRevision: 0, payload: { attempt: 1, handleId: 'wrong', generation: 1, text: 'invalid' } };
  const credential = JSON.parse(readFileSync(join(child.stateRoot, 'pi.json')));
  assert.equal((await callSocket(credential, forged, 'model')).error, 'OWNER_EPOCH_MISMATCH');
  assert.equal((await root.request('family.budget')).used, 3, 'authority rejection does not charge');
});

test('typed recursive shutdown refuses new admissions during its asynchronous child-close window', async t => {
  const f = fixture(t); const root = await f.start('root');
  let entered; let release;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const operation = root.host.runtime.familyOperation.bind(root.host.runtime);
  root.host.runtime.familyOperation = async (action, payload) => { if (action === 'children') { entered(); await gate; } return operation(action, payload); };
  const closing = root.host.service.close(); await began;
  await assert.rejects(root.launch('during-close'), /SHUTDOWN_BUSY/);
  assert.equal(root.rows('effects').length, 0); assert.equal(root.rows('pi_bindings').length, 0);
  release(); await closing;
  assert.equal(await childWorkSettled(root.stateRoot), true);
});

test('advisor binding preserves authority, freezes metadata and replays exactly after use/restart', async t => {
  const f = fixture(t); const root = await f.start('root');
  const ledger = () => JSON.parse(root.rows('family_state')[0].data);
  const before = ledger(); const binding = { workstream: 'chosen-outcome', workerHarness: 'native' };
  await root.request('advisor.bind', binding);
  assert.equal(ledger().family.id, before.family.id);
  assert.equal(ledger().maxLaunches, before.maxLaunches);
  assert.deepEqual(ledger().services, before.services, 'binding changes no credential or runtime scope');
  const runId = await root.launch('work'); root.settle(); await root.ack(runId);
  const used = ledger(); await root.request('advisor.bind', binding); assert.deepEqual(ledger(), used);
  await root.request('advisor.bind', { ...binding, teamMode: true });
  assert.deepEqual(ledger().services, used.services, 'opting in does not mutate earlier worker capabilities');
  assert.equal(ledger().used, used.used);
  used.family.teamMode = true; used.advisorBinding.teamMode = true;
  for (const altered of [{ ...binding, workstream: 'foreign' }, { ...binding, workerHarness: 'pi' }]) await assert.rejects(root.request('advisor.bind', altered), /FAMILY_BINDING_MISMATCH/);
  await root.host.service.close();
  const resumed = await f.start('root'); await resumed.request('advisor.bind', binding);
  assert.deepEqual(JSON.parse(resumed.rows('family_state')[0].data), used);
});

test('first binding freezes a matching synthetic workstream with harness-only startup', async t => {
  const f = fixture(t); const options = { managedIdentity: { workerHarness: 'native' } };
  const root = await f.start('partial', options);
  const before = JSON.parse(root.rows('family_state')[0].data);
  const binding = { workstream: before.family.workstream, workerHarness: 'native' };
  await root.request('advisor.bind', binding);
  const bound = JSON.parse(root.rows('family_state')[0].data);
  assert.deepEqual(bound.advisorBinding, binding, 'matching provisional values must persist a full binding');
  assert.deepEqual({ ...bound, advisorBinding: before.advisorBinding }, before, 'binding changes no family identity or accounting');
  await assert.rejects(root.request('advisor.bind', { ...binding, workstream: 'changed-after-binding' }), /FAMILY_BINDING_MISMATCH/);
  const runId = await root.launch('work'); root.settle(); await root.ack(runId);
  await root.request('advisor.bind', binding);
  const used = root.rows('family_state'); await root.host.service.close();
  const restarted = await f.start('partial', options); await restarted.request('advisor.bind', binding);
  assert.deepEqual(restarted.rows('family_state'), used);
});

test('first exact partial binding after execution is too late and leaves the ledger unchanged', async t => {
  const f = fixture(t); const root = await f.start('used-partial', { managedIdentity: { workerHarness: 'native' } });
  const runId = await root.launch('work'); root.settle(); await root.ack(runId);
  const before = root.rows('family_state'); const ledger = JSON.parse(before[0].data);
  await assert.rejects(root.request('advisor.bind', { workstream: ledger.family.workstream, workerHarness: 'native' }), /FAMILY_BINDING_TOO_LATE/);
  assert.deepEqual(root.rows('family_state'), before);
  assert.equal((await root.request('family.budget')).used, 1);
});

test('fully supplied metadata replays after execution and restart even without a binding marker', async t => {
  const f = fixture(t); const binding = { workstream: 'supplied-outcome', workerHarness: 'native' };
  const options = { managedIdentity: binding }; const root = await f.start('full', options);
  const runId = await root.launch('work'); root.settle(); await root.ack(runId);
  const used = root.rows('family_state'); await root.request('advisor.bind', binding);
  assert.deepEqual(root.rows('family_state'), used);
  await root.host.service.close();
  // Disposable pre-marker fixture, retaining the complete original startup metadata.
  const db = new DatabaseSync(join(root.stateRoot, 'runtime.sqlite'));
  const ledger = JSON.parse(used[0].data); delete ledger.advisorBinding;
  db.prepare('UPDATE family_state SET data=?').run(JSON.stringify(ledger)); db.close();
  const before = root.rows('family_state'); const restarted = await f.start('full', options);
  await restarted.request('advisor.bind', binding);
  assert.deepEqual(restarted.rows('family_state'), before, 'established exact replay never rewrites accounting');
  await assert.rejects(restarted.request('advisor.bind', { ...binding, workstream: 'changed' }), /FAMILY_BINDING_MISMATCH/);
});

test('first advisor binding rejects used, child, legacy, and pre-supplied conflicting identities', async t => {
  const f = fixture(t); const binding = { workstream: 'chosen-outcome', workerHarness: 'native' };
  const root = await f.start('root'); const id = await root.launch('advisor', { delegate: true });
  await assert.rejects(root.request('advisor.bind', binding), /FAMILY_BINDING_TOO_LATE/);
  const node = await root.request('get', { runId: id }); const child = await f.start('child', { stateRoot: node.childService.stateRoot });
  await assert.rejects(child.request('advisor.bind', binding), /FAMILY_SCOPE_FORBIDDEN/);
  const supplied = await f.start('supplied', { managedIdentity: binding });
  await supplied.request('advisor.bind', binding);
  await assert.rejects(supplied.request('advisor.bind', { ...binding, workstream: 'changed' }), /FAMILY_BINDING_MISMATCH/);
  await assert.rejects(supplied.request('advisor.bind', { ...binding, workerHarness: 'pi' }), /FAMILY_BINDING_MISMATCH/);
  await supplied.host.service.close();
  // Even a pre-marker family cannot reinterpret its startup metadata as unspecified.
  const db = new DatabaseSync(join(supplied.stateRoot, 'runtime.sqlite'));
  const old = JSON.parse(db.prepare('SELECT data FROM family_state').get().data); delete old.advisorBinding;
  db.prepare('UPDATE family_state SET data=?').run(JSON.stringify(old)); db.close();
  const restarted = await f.start('supplied', { managedIdentity: binding });
  await assert.rejects(restarted.request('advisor.bind', { ...binding, workstream: 'changed' }), /FAMILY_BINDING_MISMATCH/);
  await restarted.request('advisor.bind', binding);
  const legacyRoot = join(f.base, 'legacy-bind'); mkdirSync(legacyRoot, { mode: 0o700 });
  writeFileSync(join(legacyRoot, 'child-grant.json'), JSON.stringify({ v: 1, stateRoot: legacyRoot, cwd: f.cwd }), { mode: 0o600 });
  const legacy = await f.start('legacy', { stateRoot: legacyRoot });
  await assert.rejects(legacy.request('advisor.bind', binding), /FAMILY_SCOPE_FORBIDDEN/);
});

test('advisor metadata binding cannot race admitted preparation or root family reservation', async t => {
  const f = fixture(t); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const root = await f.start('root', { prepareGate: gate });
  const pending = root.launch('preparing');
  for (let i = 0; i < 100 && !root.rows('pi_bindings').length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(root.rows('pi_bindings').length, 1);
  await assert.rejects(root.request('advisor.bind', { workstream: 'too-late', workerHarness: 'native' }), /FAMILY_BINDING_TOO_LATE/);
  release(); await pending;
  assert.equal((await root.request('family.budget')).used, 1);
  assert.equal(JSON.parse(root.rows('family_state')[0].data).family.workerHarness, undefined);
  const bound = await f.start('bound'); await bound.request('advisor.bind', { workstream: 'first', workerHarness: 'native' });
  const id = await bound.launch('advisor', { delegate: true });
  assert.equal((await bound.request('get', { runId: id })).childService.family.workerHarness, 'native');
});

test('managed roster keeps immutable identity and history while public peer transport stays fenced', async t => {
  const f = fixture(t); const root = await f.start('root', { maxLaunches: 12 });
  await root.request('advisor.bind', { workstream: 'managed-workstream', workerHarness: 'pi' });
  assert.deepEqual({ active: (await root.request('team.status')).active, mode: (await root.request('team.status')).mode }, { active: false, mode: 'ordinary' });
  const settleLaunch = (entry, status = 'PASS') => {
    writeFileSync(join(entry.intent.sourceDirectory, 'result.md'), `# Status\n${status}\n# Claims\nfixture`);
    entry.hooks.settled('done', 'output', entry.generation + 1);
  };

  const temporaries = await Promise.all(['scout-one', 'scout-two', 'scout-three'].map(key => root.launch(key, { role: 'scout' })));
  const temporary = temporaries[0];
  assert.ok(temporaries.every(runId => root.launches.find(entry => entry.intent.sourceDirectory.includes(runId)).intent.environment.ADVISOR_TEAM_MODE === undefined));
  assert.equal((await root.request('advisor.bind', { workstream: 'managed-workstream', workerHarness: 'pi', teamMode: true })).teamMode, true);
  assert.deepEqual({ active: (await root.request('team.status')).active, mode: (await root.request('team.status')).mode }, { active: false, mode: 'managed-team' });
  await assert.rejects(root.request('advisor.bind', { workstream: 'managed-workstream', workerHarness: 'pi', teamMode: false }), /FAMILY_BINDING_MISMATCH/);
  await assert.rejects(root.request('team.enlist', { toolCallId: 'bad-enlist', runId: temporary, name: 'temporary' }), /TEAM_MEMBER_INELIGIBLE/);
  for (const runId of temporaries) settleLaunch(root.launches.find(entry => entry.intent.sourceDirectory.includes(runId)));

  const alpha = await root.launch('alpha-launch', { role: 'advisor', delegate: true });
  const beta = await root.launch('beta-launch', { role: 'advisor', delegate: true });
  const alphaLaunch = root.launches.find(entry => entry.intent.sourceDirectory.includes(alpha));
  const betaLaunch = root.launches.find(entry => entry.intent.sourceDirectory.includes(beta));
  assert.equal(alphaLaunch.intent.environment.ADVISOR_TEAM_MODE, '1'); assert.equal(betaLaunch.intent.environment.ADVISOR_TEAM_MODE, '1');
  await root.request('team.enlist', { toolCallId: 'enlist-alpha', runId: alpha, name: 'alpha' });
  await root.request('team.enlist', { toolCallId: 'enlist-beta', runId: beta, name: 'beta' });
  await assert.rejects(root.request('team.rename', { toolCallId: 'reserved-root-name', to: 'beta', name: 'root' }), /TEAM_NAME_CONFLICT/);
  await assert.rejects(root.request('team.rename', { toolCallId: 'member-id-name', to: 'beta', name: alpha }), /TEAM_NAME_CONFLICT/);
  const initial = await root.request('team.status');
  assert.equal(initial.mode, 'managed-team'); assert.equal(initial.scheduler, 'existing-advisor-runtime-and-herdr'); assert.equal(initial.teamQuota, null);
  assert.deepEqual(initial.storageLimits, { teamStateBytes: 16 * 1024 * 1024, commandEnvelopeBytes: 32768, responseEnvelopeBytes: 1048576, messageTextBytes: 16384 });
  assert.deepEqual(initial.projectionLimits, { statusMessages: 128, statusMessageTextBytes: 1024 });
  assert.equal(Object.hasOwn(initial.storageLimits, 'members'), false); assert.equal(Object.hasOwn(initial.storageLimits, 'messages'), false);
  assert.equal(initial.accounting.used, 5); assert.equal(initial.members.length, 2);
  const alphaIdentity = initial.members.find(member => member.id === alpha).immutable;
  assert.deepEqual({ role: alphaIdentity.role, model: alphaIdentity.model, effort: alphaIdentity.effort, rootSession: alphaIdentity.rootSession }, { role: 'advisor', model: 'fixture', effort: 'none', rootSession: 'root' });
  assert.equal(initial.members.find(member => member.id === alpha).observed.model, null);
  await root.request('team.rename', { toolCallId: 'rename-alpha', to: 'alpha', name: 'systems' });
  await root.request('team.context', { toolCallId: 'context-1', text: 'Keep the public API small and preserve old evidence.' });
  const renamed = await root.request('team.status');
  assert.deepEqual(renamed.members.find(member => member.id === alpha).immutable, alphaIdentity);
  assert.equal(renamed.context.revision, 1);

  const accepted = await root.request('team.message', { toolCallId: 'root-to-alpha', to: 'systems', text: 'Inspect the adapter boundary.' });
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.read, null); assert.equal(accepted.done, null);
  await root.host.runtime.dispatch();
  const replay = await root.request('team.message', { toolCallId: 'root-to-alpha', to: 'systems', text: 'Inspect the adapter boundary.' });
  assert.deepEqual(replay, accepted); assert.equal(root.messages.length, 1);
  await assert.rejects(root.request('team.message', { toolCallId: 'root-to-alpha', to: 'systems', text: 'changed retry' }), /COMMAND_ID_REUSE/);
  let status = await root.request('team.status'); let target = status.members.find(member => member.id === alpha);
  assert.equal(status.messages.at(-1).status, 'queued'); assert.equal(status.messages.at(-1).read, null); assert.equal(status.messages.at(-1).done, null);

  const credential = JSON.parse(readFileSync(join(root.stateRoot, 'pi.json')));
  const direct = (commandId, mutate) => callSocket(credential, { v: 1, op: 'team.message', scope: target.scope, commandId, expectedRevision: target.node.revision,
    payload: { to: target.id, target: mutate({ memberId: target.id, assignmentId: target.transport.assignmentId, session: target.transport.session, handleId: target.transport.handleId, generation: target.transport.generation }), text: 'forged' } }, 'model');
  assert.equal((await direct('stale-assignment', value => ({ ...value, assignmentId: 'old-assignment' }))).error, 'TEAM_TARGET_STALE');
  assert.equal((await direct('stale-session', value => ({ ...value, session: 'foreign-session' }))).error, 'TEAM_TARGET_STALE');
  assert.equal((await direct('stale-generation', value => ({ ...value, generation: value.generation + 1 }))).error, 'TEAM_TARGET_STALE');
  const { ownerEpoch: _ownerEpoch, ...outsiderScope } = target.scope;
  const outsider = root.host.runtime.registerPrincipal({ id: 'scoped-outsider', kind: 'advisor', scopes: [outsiderScope], operations: ['team.status', 'team.message'] });
  assert.equal(root.host.runtime.execute(outsider, { v: 1, op: 'team.message', scope: target.scope, commandId: 'outsider-message', expectedRevision: target.node.revision,
    payload: { to: target.id, target: { memberId: target.id, assignmentId: target.transport.assignmentId, session: target.transport.session, handleId: target.transport.handleId, generation: target.transport.generation }, text: 'not a teammate' } }, 'model').error, 'TEAM_SENDER_UNAUTHORIZED');
  assert.equal((await callSocket({ ...credential, token: '0'.repeat(64) }, { v: 1, op: 'team.status', scope: target.scope, payload: {} }, 'model')).error, 'UNAUTHORIZED');
  assert.equal((await callSocket(credential, { v: 1, op: 'team.status', scope: { ...target.scope, workstream: 'foreign' }, payload: {} }, 'model')).error, 'SCOPE_FORBIDDEN');
  assert.equal((await callSocket(credential, { v: 1, op: 'team.message', scope: { ...target.scope, workstream: 'foreign' }, commandId: 'foreign-workstream-message', expectedRevision: target.node.revision,
    payload: { to: target.id, target: { memberId: target.id, assignmentId: target.transport.assignmentId, session: target.transport.session, handleId: target.transport.handleId, generation: target.transport.generation }, text: 'foreign workstream' } }, 'model')).error, 'SCOPE_FORBIDDEN');

  const betaNode = await root.request('get', { runId: beta });
  const betaChild = await f.start('beta-child', { stateRoot: betaNode.childService.stateRoot });
  const peer = await betaChild.request('team.message', { toolCallId: 'beta-to-alpha', to: 'systems', text: 'Peer review note.' });
  assert.equal(peer.status, 'accepted'); await root.host.runtime.dispatch(); assert.equal(root.messages.length, 2);
  const rootward = await betaChild.request('team.message', { toolCallId: 'beta-to-root', to: 'root', text: 'Root-facing note.' });
  assert.equal(rootward.status, 'queued');
  const rootDeliveries = await root.request('wait', { runId: beta });
  assert.equal(rootDeliveries.filter(delivery => delivery.kind === 'team.message').length, 1);
  await root.ack(beta);

  settleLaunch(alphaLaunch); settleLaunch(betaLaunch);
  status = await root.request('team.status'); target = status.members.find(member => member.id === alpha);
  await root.request('team.assign', { toolCallId: 'assign-alpha-2', to: 'systems', assignmentId: 'alpha-contract-2', task: 'Second distinct contract', acceptance: ['second contract result'], riskTier: 'high' });
  await root.host.runtime.dispatch(); const secondLaunch = root.launches.at(-1); assert.match(secondLaunch.reply, /MANAGED TEAM NEW ASSIGNMENT alpha-contract-2/);
  assert.match(root.messages[0].input.text, /Advice\/context only/);
  settleLaunch(secondLaunch);
  await root.request('call', { toolCallId: 'repair-alpha-2', tool: 'bg_agent', cwd: f.cwd, params: { name: alpha, prompt: 'Repair the current outcome.' } });
  await root.host.runtime.dispatch(); settleLaunch(root.launches.at(-1));
  status = await root.request('team.status'); target = status.members.find(member => member.id === alpha);
  assert.equal(target.assignments.length, 2); assert.deepEqual(target.assignments.at(-1).attempts.map(attempt => attempt.kind), ['new', 'repair']);
  assert.equal(status.accounting.operations['team.assign'], 1); assert.equal(status.accounting.operations['node.task'], 1);

  for (const runId of temporaries) await root.ack(runId);
  await root.ack(alpha); await root.ack(beta);
  assert.equal((await root.request('team.retire', { toolCallId: 'retire-alpha', to: 'systems' })).status, 'retired');
  assert.equal((await root.request('team.retire', { toolCallId: 'retire-beta', to: 'beta' })).status, 'retired');
  const beforeRestart = await root.request('team.status'); await root.host.service.close();
  const restarted = await f.start('root', { maxLaunches: 12 }); const afterRestart = await restarted.request('team.status');
  assert.deepEqual(afterRestart.members.map(member => ({ id: member.id, name: member.name, immutable: member.immutable, assignments: member.assignments })),
    beforeRestart.members.map(member => ({ id: member.id, name: member.name, immutable: member.immutable, assignments: member.assignments })));
  assert.deepEqual(afterRestart.context, beforeRestart.context);
  assert.ok(afterRestart.members.every(member => member.status === 'retired'));
});

test('retained teammate keeps independent graph contracts, repair budgets, checks and consumed-input lineage per accepted outcome', async t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, 'check.mjs'), "import assert from 'node:assert/strict'; assert.equal(2 + 2, 4);\n");
  const git = args => { const result = spawnSync('git', ['-C', f.cwd, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  const root = await f.start('root', { maxLaunches: 16 });
  await root.request('advisor.bind', { workstream: 'contract-workstream', workerHarness: 'pi', teamMode: true });
  const graph = { graphId: 'assignment-contracts', advisorSessionId: 'root', maxRepairLoops: 1, nodes: [
    { id: 'source', task: 'Produce upstream evidence.', dependsOn: [] },
    { id: 'first-outcome', task: 'Own the first accepted outcome.', dependsOn: ['source'] },
    { id: 'second-outcome', task: 'Own the second accepted outcome.', dependsOn: ['source'] },
    { id: 'duplicate-outcome', task: 'Must not launder a bound accepted contract.', dependsOn: [] },
  ] };
  const evidence = (node, runId, attempt) => root.request('graph.evidence', { graph, node, ...(runId ? { runId } : {}), ...(attempt ? { attempt } : {}) });

  const source = await root.launch('source-launch', { role: 'builder', prompt: 'Produce upstream evidence.' });
  root.settle(); await evidence('source', source, 1);
  const firstInput = await evidence('first-outcome');
  const member = await root.launch('member-launch', { role: 'advisor', delegate: true, prompt: firstInput.prompt, acceptance: ['first accepted result'] });
  await root.request('team.enlist', { toolCallId: 'enlist-contract-owner', runId: member, name: 'contract-owner' });
  root.settle(); await evidence('first-outcome', member, 1);

  const firstRepairInput = (await evidence('first-outcome')).prompt + '\nRepair only the first accepted outcome.';
  await root.request('call', { toolCallId: 'repair-first-outcome', tool: 'bg_agent', cwd: f.cwd, params: { name: member, prompt: firstRepairInput } });
  await root.host.runtime.dispatch(); root.settle();
  await evidence('first-outcome', member, 2);
  const firstNode = await root.request('get', { runId: member });
  const firstCheck = root.host.runtime.checkNode({ scope: firstNode.snapshot.scope, command: process.execPath, args: ['check.mjs'], producer: 'contract-checker' });
  assert.deepEqual(firstCheck.contract.acceptance, ['first accepted result']); assert.equal(firstCheck.contract.riskTier, 'high');
  const firstBound = await evidence('first-outcome');
  assert.deepEqual(firstBound.node.budget, { maxRepairLoops: 1, used: 1, remaining: 0 });
  assert.equal(firstBound.node.proof, 'verified');
  const firstContract = firstBound.node.contract; const firstResult = firstBound.node.result;

  const secondInput = await evidence('second-outcome');
  await root.request('team.assign', { toolCallId: 'assign-second-outcome', to: 'contract-owner', assignmentId: 'second-contract', task: secondInput.prompt,
    acceptance: ['second accepted result', 'current checker contract'], riskTier: 'standard' });
  await root.host.runtime.dispatch(); root.settle();
  await assert.rejects(evidence('first-outcome', member, 3), /GRAPH_NODE_ALREADY_BOUND/, 'a new label cannot overwrite the exhausted graph outcome');
  await evidence('second-outcome', member, 3);
  await assert.rejects(evidence('duplicate-outcome', member, 3), /GRAPH_OUTCOME_ALREADY_BOUND/, 'one accepted assignment cannot mint another graph budget');
  let secondNode = await root.request('get', { runId: member });
  assert.equal(secondNode.packet.task, secondInput.prompt); assert.deepEqual(secondNode.packet.acceptance, ['second accepted result', 'current checker contract']); assert.equal(secondNode.packet.riskTier, 'standard');
  assert.deepEqual(secondNode.consumedInputs.map(input => input.node), ['second-outcome']);
  assert.equal(secondNode.result.contract.assignmentId, 'second-contract'); assert.deepEqual(secondNode.result.contract.acceptance, secondNode.packet.acceptance);
  const secondCheck = root.host.runtime.checkNode({ scope: secondNode.snapshot.scope, command: process.execPath, args: ['check.mjs'], producer: 'contract-checker' });
  assert.equal(secondCheck.contract.assignmentId, 'second-contract'); assert.deepEqual(secondCheck.contract.acceptance, secondNode.packet.acceptance); assert.equal(secondCheck.contract.riskTier, 'standard');
  assert.deepEqual(JSON.parse(readFileSync(secondCheck.path)).contract, secondCheck.contract, 'captured checker evidence freezes the current accepted contract');
  secondNode = await root.request('get', { runId: member });
  assert.deepEqual(secondNode.check.contract, secondCheck.contract); assert.deepEqual(secondNode.verification.contract, secondCheck.contract);
  let status = await root.request('team.status'); let teamMember = status.members.find(value => value.id === member);
  assert.equal(teamMember.assignments[0].endedAttempt, 2); assert.deepEqual(teamMember.assignments[0].acceptance, ['first accepted result']);
  assert.deepEqual(teamMember.assignments[0].attempts.at(-1).result.check.contract.acceptance, ['first accepted result']);
  assert.deepEqual(teamMember.assignments[1].acceptance, ['second accepted result', 'current checker contract']);

  const secondRepairInput = (await evidence('second-outcome')).prompt + '\nRepair only the second accepted outcome.';
  await root.request('call', { toolCallId: 'repair-second-outcome', tool: 'bg_agent', cwd: f.cwd, params: { name: member, prompt: secondRepairInput } });
  await root.host.runtime.dispatch(); root.settle(); await evidence('second-outcome', member, 4);
  secondNode = await root.request('get', { runId: member });
  root.host.runtime.checkNode({ scope: secondNode.snapshot.scope, command: process.execPath, args: ['check.mjs'], producer: 'contract-checker' });
  const historicalFirst = await evidence('first-outcome'); const currentSecond = await evidence('second-outcome');
  assert.equal(historicalFirst.node.reason, 'accepted contract changed'); assert.deepEqual(historicalFirst.node.contract, firstContract);
  assert.deepEqual(historicalFirst.node.budget, { maxRepairLoops: 1, used: 1, remaining: 0 });
  assert.equal(historicalFirst.node.result.path, firstResult.path); assert.ok(historicalFirst.node.history.every(item => item.attempt <= 2));
  assert.deepEqual(currentSecond.node.budget, { maxRepairLoops: 1, used: 1, remaining: 0 });
  assert.equal(currentSecond.node.contract.assignmentId, 'second-contract'); assert.ok(currentSecond.node.history.every(item => item.attempt >= 3));
  status = await root.request('team.status'); teamMember = status.members.find(value => value.id === member);
  assert.deepEqual(teamMember.assignments.map(assignment => assignment.attempts.map(attempt => attempt.kind)), [['initial', 'repair'], ['new', 'repair']]);

  await root.request('call', { toolCallId: 'repair-upstream', tool: 'bg_agent', cwd: f.cwd, params: { name: source, prompt: 'Repair the upstream evidence.' } });
  await root.host.runtime.dispatch(); root.settle(); await evidence('source', source, 2);
  assert.match((await evidence('second-outcome')).node.reason, /dependency attempt or capture changed|upstream lineage stale or unknown/);

  await root.ack(source); await root.ack(member);
  assert.equal((await root.request('team.retire', { toolCallId: 'retire-contract-owner', to: 'contract-owner' })).status, 'retired');
  await root.host.service.close();
});

test('enlistment preserves pre-roster checker evidence instead of relabelling its accepted contract', async t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, 'check.mjs'), "import assert from 'node:assert/strict'; assert.equal(2 + 2, 4);\n");
  const git = args => { const result = spawnSync('git', ['-C', f.cwd, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  const root = await f.start('root');
  await root.request('advisor.bind', { workstream: 'historical-enlistment', workerHarness: 'pi', teamMode: true });
  const member = await root.launch('pre-roster', { role: 'advisor', delegate: true, acceptance: ['pre-roster acceptance'] });
  root.settle();
  let node = await root.request('get', { runId: member });
  const checked = root.host.runtime.checkNode({ scope: node.snapshot.scope, command: process.execPath, args: ['check.mjs'], producer: 'pre-roster-checker' });
  const checkBytes = readFileSync(checked.path);
  node = await root.request('get', { runId: member });
  assert.equal(node.result.contract.assignmentId, null); assert.equal(node.result.proof, 'verified');

  const graph = { graphId: 'pre-roster-outcome', advisorSessionId: 'root', maxRepairLoops: 0, nodes: [{ id: 'original', task: 'original contract', dependsOn: [] }] };
  await root.request('graph.evidence', { graph, node: 'original', runId: member });
  await root.request('team.enlist', { toolCallId: 'enlist-prechecked', runId: member, name: 'prechecked' });
  node = await root.request('get', { runId: member });
  assert.equal(node.contract.assignmentId, null, 'roster enlistment is not a new accepted contract');
  assert.equal(node.result.contract.assignmentId, null); assert.equal(node.result.proof, 'verified'); assert.ok(node.result.tested, 'unchanged accepted contract retains actual pre-roster proof');
  assert.deepEqual(readFileSync(checked.path), checkBytes, 'hashed checker evidence is immutable across enlistment');
  const roster = (await root.request('team.status')).members.find(value => value.id === member);
  assert.equal(roster.assignments[0].attempts[0].result.contract.assignmentId, null);
  assert.equal(roster.assignments[0].attempts[0].result.check.contract.assignmentId, null);
  assert.equal(roster.assignments[0].attempts[0].result.verification.contract.assignmentId, null);

  await assert.rejects(root.request('call', { tool: 'bg_agent', toolCallId: 'enlist-cannot-reset-budget', cwd: f.cwd, params: { name: member, prompt: 'same outcome repair' } }), /GRAPH_REPAIR_LIMIT/);
  await root.request('team.assign', { toolCallId: 'distinct-after-pre-roster', to: 'prechecked', assignmentId: 'distinct-contract', task: 'New accepted outcome', acceptance: ['new proof'], riskTier: 'standard' });
  await root.host.runtime.dispatch(); root.settle();
  const nextGraph = { graphId: 'post-roster-outcome', advisorSessionId: 'root', maxRepairLoops: 1, nodes: [{ id: 'next', task: 'new contract', dependsOn: [] }] };
  await root.request('graph.evidence', { graph: nextGraph, node: 'next', runId: member });
  await root.request('call', { tool: 'bg_agent', toolCallId: 'new-contract-repair', cwd: f.cwd, params: { name: member, prompt: 'repair new accepted outcome' } });
  await root.host.runtime.dispatch(); root.settle();
  assert.equal((await root.request('graph.evidence', { graph, node: 'original' })).node.budget.used, 0, 'new repairs never charge the pre-roster outcome');
  assert.equal((await root.request('graph.evidence', { graph: nextGraph, node: 'next' })).node.budget.used, 1);
  assert.deepEqual(readFileSync(checked.path), checkBytes);

  await root.ack(member);
  assert.equal((await root.request('team.retire', { toolCallId: 'retire-prechecked', to: 'prechecked' })).status, 'retired');
  await root.host.service.close();
});

test('managed team storage is byte-bounded without a roster or conversation cardinal quota', async t => {
  const f = fixture(t); const root = await f.start('root', { maxLaunches: 4 });
  await root.request('advisor.bind', { workstream: 'byte-bounded-team', workerHarness: 'pi', teamMode: true });
  const member = await root.launch('member', { role: 'advisor', delegate: true });
  await root.request('team.enlist', { toolCallId: 'enlist', runId: member, name: 'member' });
  const node = await root.request('get', { runId: member });
  const child = await f.start('member-child', { stateRoot: node.childService.stateRoot });
  for (let index = 0; index < 260; index++) {
    const text = index === 259 ? 'é'.repeat(600) : `message ${index}`;
    await child.request('team.message', { toolCallId: `message-${index}`, to: 'root', text });
  }
  const status = await root.request('team.status');
  assert.equal(status.teamQuota, null); assert.equal(status.messageCount, 260, 'conversation history exceeds the removed 256-entry cap');
  assert.equal(status.messages.length, 128, 'status projection is bounded independently from durable history');
  assert.equal(status.messages.at(-1).textTruncated, true); assert.ok(Buffer.byteLength(status.messages.at(-1).text) <= 1024); assert.doesNotMatch(status.messages.at(-1).text, /�/);
  assert.deepEqual(status.storageLimits, { teamStateBytes: 16 * 1024 * 1024, commandEnvelopeBytes: 32768, responseEnvelopeBytes: 1048576, messageTextBytes: 16384 });
  assert.deepEqual(status.projectionLimits, { statusMessages: 128, statusMessageTextBytes: 1024 });
  assert.ok(Buffer.byteLength(root.rows('team_state')[0].data) < status.storageLimits.teamStateBytes);
  root.settle();
  for (;;) {
    const deliveries = await root.request('wait', { runId: member });
    if (!deliveries.length) break;
    for (const delivery of deliveries) await root.request('ack', { runId: member, deliveryId: delivery.id });
  }
  assert.equal((await root.request('team.retire', { toolCallId: 'retire', to: 'member' })).status, 'retired');
  await assert.rejects(child.host.service.close(), /CLOSED|SHUTDOWN/, 'retirement closed the settled child service');
  await root.host.service.close();
});

test('team retirement stays pending until actual descendants settle and exact replay finishes closure', async t => {
  const f = fixture(t); const root = await f.start('root');
  await root.request('advisor.bind', { workstream: 'retirement-workstream', workerHarness: 'pi', teamMode: true });
  const member = await root.launch('member', { role: 'advisor', delegate: true });
  await root.request('team.enlist', { toolCallId: 'enlist', runId: member, name: 'member' }); root.settle();
  const node = await root.request('get', { runId: member }); const child = await f.start('member-child', { stateRoot: node.childService.stateRoot });
  const descendant = await child.launch('descendant');
  const first = await root.request('team.retire', { toolCallId: 'retire', to: 'member' });
  assert.deepEqual(first, { memberId: member, status: 'retiring', descendants: 'active' });
  assert.equal((await root.request('team.status')).members.find(value => value.id === member).status, 'retiring');
  await assert.rejects(child.launch('after-seal'), /FAMILY_ADMISSION_SEALED/);
  await assert.rejects(root.request('team.message', { toolCallId: 'late-message', to: 'member', text: 'too late' }), /TEAM_TARGET_RETIRED/);
  child.settle(); await child.ack(descendant);
  const replay = await root.request('team.retire', { toolCallId: 'retire-reconcile', to: 'member' });
  assert.equal(replay.status, 'retired'); assert.equal(replay.descendants, 'settled');
  assert.deepEqual(await root.request('team.retire', { toolCallId: 'retire-reconcile', to: 'member' }), replay);
  assert.equal((await root.request('team.retire', { toolCallId: 'retire', to: 'member' })).status, 'retired', 'an old exact replay reports current retirement truth');
  await root.ack(member); await root.host.service.close();
});

test('a transport-confirmed cancelled teammate can retire without erasing cancellation history', async t => {
  const f = fixture(t); const root = await f.start('root');
  await root.request('advisor.bind', { workstream: 'cancelled-workstream', workerHarness: 'pi', teamMode: true });
  const member = await root.launch('member', { role: 'advisor', delegate: true });
  await root.request('team.enlist', { toolCallId: 'enlist', runId: member, name: 'member' });
  const node = await root.request('get', { runId: member });
  await f.start('member-child', { stateRoot: node.childService.stateRoot });
  await root.request('call', { toolCallId: 'cancel', tool: 'bg_stop', cwd: f.cwd, params: { runId: member } });
  await root.host.runtime.dispatch();
  const launch = root.launches.at(-1);
  for (let i = 0; i < 100 && !launch.observer; i++) await new Promise(resolve => setTimeout(resolve, 5));
  launch.observer.settled('done', 'cancelled by fixture transport', launch.generation + 1);
  const cancelled = await root.request('get', { runId: member });
  assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.snapshot.cancel);
  const retired = await root.request('team.retire', { toolCallId: 'retire', to: 'member' });
  assert.equal(retired.status, 'retired');
  const persisted = (await root.request('team.status')).members.find(value => value.id === member);
  assert.equal(persisted.status, 'retired'); assert.equal(persisted.node.status, 'cancelled');
  await root.ack(member); await root.host.service.close();
});

test('real recursive product fixture exercises both runtime and sibling execution-port source', { timeout: 60000, skip: !process.env.PI_DETACH_TEST_PACKAGE }, () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/bridge/pi-detach-recursive.ts'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 55000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS downward cancellation/); assert.match(result.stdout, /PASS root atomic accounting/);
});
