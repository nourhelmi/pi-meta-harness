import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AdvisorRuntime } from '../scripts/advisor-runtime/runtime.mjs';
import { OPERATIONS } from '../scripts/advisor-runtime/contract.mjs';
import { host } from '../scripts/advisor-runtime/cli.mjs';
import { writeCredential } from '../scripts/advisor-runtime/service.mjs';

function paths(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'repair-')));
  const work = join(base, 'work'); mkdirSync(work, { mode: 0o700 });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, work, state: join(base, 'state') };
}
const scope = (node = 'root') => ({ workstream: 'work', run: 'run', node, ownerEpoch: 1 });
const grant = node => ({ workstream: 'work', run: 'run', node });
const principal = (id = 'operator', nodes = ['root', 'maker']) => ({ id, kind: id === 'operator' ? 'operator' : 'advisor', scopes: nodes.map(grant), operations: OPERATIONS });
const packet = cwd => ({ role: 'builder', task: 'Synthetic defensive regression', acceptance: ['No real secrets'], riskTier: 'high', cwd, adapter: 'fixture', model: 'fixture', thinking: 'off' });
function fixture(t) {
  const p = paths(t); const contexts = new Map(); const calls = [];
  const adapter = { capabilities: Object.fromEntries(OPERATIONS.map(op => [op, true])), execute(input) {
    calls.push(input.effect); contexts.set(input.effect.scope.node, input);
    if (['node.launch', 'root.create'].includes(input.effect.op)) input.recordHandle({ id: 'fixture-handle' });
    return { accepted: true };
  } };
  const runtime = new AdvisorRuntime({ stateRoot: p.state, allowedRoots: [p.work], adapters: { workers: { fixture: adapter }, roots: { fixture: adapter } } });
  const token = runtime.registerPrincipal(principal('operator', ['root', 'maker', 'rogue']));
  const read = (op = 'progress', node = 'root', payload = {}, credential = token) => runtime.execute(credential, { v: 1, op, scope: scope(node), payload });
  const send = (op, payload = {}, node = 'root', credential = token) => runtime.execute(credential, { v: 1, op, scope: scope(node), commandId: randomUUID(), expectedRevision: op === 'workstream.create' ? 0 : read('progress', node).value.revision, payload });
  assert.equal(send('workstream.create', { cwd: p.work, host: 'codex' }).ok, true);
  t.after(() => { try { runtime.close(); } catch { /* synthetic uncompleted handles only; no process launched */ } });
  return { ...p, runtime, token, read, send, contexts, calls };
}

test('R1 legitimate host bootstrap restart reuses credentials, rejects changed/missing/revoked bindings', async t => {
  const p = paths(t); const credentialPath = join(p.state, 'operator.json');
  const config = { stateRoot: p.state, allowedRoots: [p.work], principals: [{ principal: principal(), credentialPath }] };
  const first = await host(config, {}); const bytes = readFileSync(credentialPath); await first.service.close();
  const second = await host(config, {}); assert.deepEqual(readFileSync(credentialPath), bytes); await second.service.close();
  await assert.rejects(host({ ...config, principals: [{ ...config.principals[0], principal: principal('operator', ['root']) }] }, {}), /BOOTSTRAP_MISMATCH/);
  await assert.rejects(host({ ...config, principals: [{ ...config.principals[0], credentialPath: join(p.state, 'changed.json') }] }, {}), /BOOTSTRAP_MISMATCH/);
  const stored = JSON.parse(bytes); writeFileSync(credentialPath, JSON.stringify({ ...stored, token: 'a'.repeat(64) }), { mode: 0o600 });
  await assert.rejects(host(config, {}), /BOOTSTRAP_CREDENTIAL_MISMATCH/); writeFileSync(credentialPath, bytes);
  rmSync(credentialPath); await assert.rejects(host(config, {}), /BOOTSTRAP_CREDENTIAL_MISSING/); writeFileSync(credentialPath, bytes, { mode: 0o600 });
  const revoker = new AdvisorRuntime({ stateRoot: p.state, allowedRoots: [p.work] }); revoker.revokePrincipal('operator'); revoker.close();
  await assert.rejects(host(config, {}), /BOOTSTRAP_PRINCIPAL_REVOKED/);
  assert.deepEqual(readFileSync(credentialPath), bytes);
});

test('R2 every referenced target needs an explicit grant, including graph, reads and delivery acknowledgment', async t => {
  const h = fixture(t); const narrow = h.runtime.registerPrincipal(principal('narrow', ['root']));
  const denied = result => assert.deepEqual(result, { ok: false, error: 'TARGET_SCOPE_FORBIDDEN' });
  denied(h.send('packet.admit', { node: 'rogue', packet: packet(h.work) }, 'root', narrow));
  assert.equal(h.read().value.packets.rogue, undefined);
  assert.equal(h.send('packet.admit', { node: 'rogue', packet: packet(h.work) }).ok, true);
  denied(h.send('node.launch', { node: 'rogue' }, 'root', narrow));
  const graph = { graph: 'fixture', waves: [['rogue']], dependencies: { rogue: [] }, topology: 'flat-root', maxParallel: 1, maxRepairLoops: 0 };
  denied(h.send('graph.admit', graph, 'root', narrow));
  assert.equal(h.send('graph.admit', graph).ok, true);
  denied(h.send('wave.launch', { wave: 1 }, 'root', narrow));
  denied(h.read('progress', 'root', {}, narrow));
  denied(h.read('history', 'root', { cursor: 0, limit: 32, maxBytes: 131072 }, narrow));
  denied(h.read('wait', 'root', { timeoutMs: 0, limit: 32 }, narrow));
  assert.equal(h.calls.length, 0);
  assert.equal(h.send('wave.launch', { wave: 1 }).ok, true); await h.runtime.dispatch();
  const input = h.contexts.get('rogue'); input.emit({ id: 'progress', kind: 'progress', attempt: 1, data: { note: 'Synthetic update' } });
  const delivery = h.read('wait', 'root', { timeoutMs: 0, limit: 32 }).value[0];
  denied(h.send('delivery.ack', { deliveryId: delivery.id }, 'root', narrow));
});

test('R3 control state and credential paths cannot overlap declared workspaces, including aliases and missing parents', async t => {
  const p = paths(t);
  assert.throws(() => new AdvisorRuntime({ stateRoot: join(p.work, 'state'), allowedRoots: [p.work] }), /CONTROL_WORKSPACE_OVERLAP/);
  const alias = join(p.base, 'alias'); symlinkSync(p.work, alias);
  assert.throws(() => new AdvisorRuntime({ stateRoot: join(alias, 'missing/state'), allowedRoots: [p.work] }), /CONTROL_WORKSPACE_OVERLAP|SYMLINK_PATH/);
  await assert.rejects(host({ stateRoot: p.state, allowedRoots: [p.work], principals: [{ principal: principal(), credentialPath: join(alias, 'missing/operator.json') }] }, {}), /CONTROL_WORKSPACE_OVERLAP|SYMLINK_PATH/);
  await assert.rejects(host({ stateRoot: p.state, allowedRoots: [p.work], principals: [{ principal: principal(), credentialPath: join(p.state, 'operator.json') }] }, {}, { bootstrapPath: join(p.work, 'bootstrap.json') }), /CONTROL_WORKSPACE_OVERLAP/);
  const h = fixture(t);
  assert.throws(() => writeCredential(join(h.work, 'operator.json'), { socketPath: join(h.state, 'runtime.sock'), token: h.token }, h.runtime), /CONTROL_WORKSPACE_OVERLAP/);
  assert.throws(() => writeCredential(join(h.base, 'unguarded.json'), { socketPath: join(h.state, 'runtime.sock'), token: h.token }), /CONTROL_OWNER_REQUIRED/);
});

test('R1 foreign first-bootstrap credentials are never adopted or overwritten', async t => {
  const p = paths(t); mkdirSync(p.state, { mode: 0o700 }); const credentialPath = join(p.state, 'operator.json');
  const bytes = JSON.stringify({ v: 1, socketPath: join(p.state, 'runtime.sock'), token: 'b'.repeat(64) });
  writeFileSync(credentialPath, bytes, { mode: 0o600 });
  await assert.rejects(host({ stateRoot: p.state, allowedRoots: [p.work], principals: [{ principal: principal(), credentialPath }] }, {}), /BOOTSTRAP_OWNERSHIP_CONFLICT/);
  assert.equal(readFileSync(credentialPath, 'utf8'), bytes);
  const db = new DatabaseSync(join(p.state, 'runtime.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM principals').get().n, 0); db.close();
});

test('R3 protected descriptor reservations survive restart and reject a newly overlapping allowed workspace', t => {
  const p = paths(t); const controls = join(p.base, 'controls'); mkdirSync(controls, { mode: 0o700 });
  const runtime = new AdvisorRuntime({ stateRoot: p.state, allowedRoots: [p.work] });
  const token = runtime.registerPrincipal(principal());
  writeCredential(join(controls, 'operator.json'), { socketPath: join(p.state, 'runtime.sock'), token }, runtime); runtime.close();
  assert.throws(() => new AdvisorRuntime({ stateRoot: p.state, allowedRoots: [p.work, controls] }), /CONTROL_WORKSPACE_OVERLAP/);
});

for (const kind of ['credential', 'secret']) for (const target of ['root', 'maker']) test(`R4 ${target} typed ${kind} reply never reaches SQL/history/trace/effect`, async t => {
  const h = fixture(t);
  if (target === 'root') assert.equal(h.send('root.create', { adapter: 'fixture', model: 'fixture', thinking: 'off', text: 'Synthetic credential request' }).ok, true);
  else { assert.equal(h.send('packet.admit', { node: 'maker', packet: packet(h.work) }).ok, true); assert.equal(h.send('node.launch', { node: 'maker' }).ok, true); }
  await h.runtime.dispatch(); const input = h.contexts.get(target);
  if (target === 'maker') writeFileSync(input.context.resultPath, '# Status\nBLOCKED\nUse supported out-of-band login.');
  input.emit({ id: 'credential-request', kind: 'blocked', attempt: 1, data: { requestId: 'login', kind, text: 'Authenticate through supported login, never paste a credential.' } });
  const before = h.calls.length; const marker = 'ARTIFICIAL_NOT_A_CREDENTIAL_4EFA';
  const reply = h.send(target === 'root' ? 'root.reply' : 'node.reply', { ...(target === 'root' ? {} : { attempt: 1 }), requestId: 'login', text: marker }, target);
  assert.deepEqual(reply, { ok: false, error: 'CREDENTIAL_REPLY_FORBIDDEN' }); await h.runtime.dispatch(); assert.equal(h.calls.length, before);
  const db = new DatabaseSync(join(h.state, 'runtime.sqlite'), { readOnly: true });
  for (const table of ['receipts', 'effects', 'events', 'deliveries', 'runs']) assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(marker), table);
  db.close(); assert.ok(!readFileSync(join(h.state, 'traces/run.jsonl'), 'utf8').includes(marker));
});
