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
    const stateRoot = options.stateRoot ?? join(base, name); const launches = [];
    const port = { version: 1,
      async prepare(params, sourceDirectory, scope) { if (options.prepareGate) await options.prepareGate; return { v: 1, command: 'fixture', prompt: params.prompt, role: params.role ?? 'foreman', runtime: 'pi', model: 'fixture', thinking: 'none', maxTurns: null, requiredSkills: [], harness: 'pi', keepAlive: true, label: 'fixture', resultDiscovery: null, resultPolicy: 'runtime-capture', sourceDirectory,
        environment: { ADVISOR_RUNTIME_DESCRIPTOR: '', PI_DETACH_RUNTIME_BRIDGE: '', ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_RUNTIME_CANONICAL_OWNER: '1', ADVISOR_BRIDGE_CHILD_STATE: params.delegate ? scope.childState : '' } }; },
      async launch({ hooks, intent }) { launches.push({ hooks, intent }); hooks.recordHandle({ id: `fixture-${intent.sourceDirectory}`, session: 'fixture' }); return { async interrupt(observer) { launches.at(-1).observer = observer; }, async readLive() { return 'fixture'; } }; },
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
    return { host, opts, launches, stateRoot, request, launch, settle, ack, rows };
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

test('real recursive product fixture exercises both runtime and sibling execution-port source', { timeout: 60000, skip: !process.env.PI_DETACH_TEST_PACKAGE }, () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/bridge/pi-detach-recursive.ts'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 55000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS downward cancellation/); assert.match(result.stdout, /PASS root atomic accounting/);
});
