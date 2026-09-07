import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, symlinkSync, chmodSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { AdvisorRuntime } from '../scripts/advisor-runtime/runtime.mjs';
import { OPERATIONS, MUTATIONS } from '../scripts/advisor-runtime/contract.mjs';
import { startService, callSocket, writeCredential } from '../scripts/advisor-runtime/service.mjs';
import { createMcpHandler, serveMcp } from '../scripts/advisor-runtime/mcp.mjs';
import { Readable, Writable } from 'node:stream';
import { withRunOwnership } from '../scripts/advisor-runtime/security.mjs';
import { loadSchema, parseTrace, validateTrace } from '../scripts/advisor-trace.mjs';

const node = process.execPath;
const scope = (name = 'root', run = 'run') => ({ workstream: 'work', run, node: name, ownerEpoch: 1 });
const read = (op = 'progress', name = 'root', payload = {}) => ({ v: 1, op, scope: scope(name), payload });
let serial = 0;
const command = (op, revision, payload = {}, name = 'root', commandId = `cmd-${++serial}`) => ({ ...read(op, name, payload), commandId, expectedRevision: revision });
const packet = cwd => ({ role: 'builder', task: 'Test bounded worker', acceptance: ['deterministic result'], riskTier: 'high', cwd, adapter: 'mock', model: 'fixture', thinking: 'none' });
const graph = (waves = [['maker']], dependencies = { maker: [] }) => ({ graph: 'graph', waves, dependencies, topology: 'flat-root', maxParallel: 2, maxRepairLoops: 0 });
const success = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.receipt ?? result.value; };
const denied = (result, error) => assert.deepEqual(result, { ok: false, error });
function temporary(t) { const base = realpathSync(mkdtempSync(join(tmpdir(), 'ar-'))); const root = join(base, 'state'); mkdirSync(root, { mode: 0o700 }); mkdirSync(join(base, 'work'), { mode: 0o700 }); t.after(() => rmSync(base, { recursive: true, force: true })); return root; }
function setup(t, { fault, behavior, create = true } = {}) {
  const root = temporary(t); const work = resolve(root, '../work'); const calls = []; const contexts = new Map();
  const adapter = { capabilities: Object.fromEntries(['node.launch', 'node.reply', 'node.cancel', 'root.create', 'root.message', 'root.reply', 'root.cancel'].map(op => [op, true])),
    async execute(input) {
      calls.push(input.effect); contexts.set(input.effect.scope.node, input);
      if (input.effect.op === 'node.launch' || input.effect.op === 'root.create') input.recordHandle({ id: `handle-${input.effect.scope.node}` });
      if (behavior) await behavior(input);
      return { accepted: true };
    } };
  const runtime = new AdvisorRuntime({ stateRoot: root, allowedRoots: [work], adapters: { roots: { mock: adapter }, workers: { mock: adapter } }, fault });
  const grants = ['root', 'maker', 'checker'].map(name => ({ workstream: 'work', run: 'run', node: name }));
  const token = runtime.registerPrincipal({ id: 'operator', kind: 'operator', scopes: grants, operations: OPERATIONS });
  const state = (name = 'root') => success(runtime.execute(token, read('progress', name)));
  const send = (op, payload = {}, name = 'root', key) => runtime.execute(token, command(op, op === 'workstream.create' ? 0 : state(name).revision, payload, name, key));
  if (create) success(send('workstream.create', { cwd: work, host: 'codex' }));
  const prepare = (waves, deps) => {
    for (const name of (waves ?? [['maker']]).flat()) success(send('packet.admit', { node: name, packet: { ...packet(work), role: name === 'checker' ? 'checker' : 'builder' } }));
    success(send('graph.admit', graph(waves, deps)));
  };
  const emit = (name, kind, data, attempt = name === 'root' ? state().root.attempt : state(name).snapshot.attempt, eventId = `event-${++serial}`) => contexts.get(name).emit({ id: eventId, kind, data, attempt });
  const settle = (name = 'maker', status = 'done', verified = true) => {
    writeFileSync(join(root, 'runs', 'run', name, 'result.md'), status === 'done' ? 'Plain nonblank terminal result; no sections required.' : 'Status: BLOCKED\nNeed input', { mode: 0o600 });
    emit(name, 'settled', { status, reason: 'fixture finalized', verified });
  };
  const ack = () => { for (const delivery of success(runtime.execute(token, read('wait', 'root', { timeoutMs: 0, limit: 128 })))) success(send('delivery.ack', { deliveryId: delivery.id })); };
  return { runtime, root, work, calls, contexts, token, grants, state, send, prepare, emit, settle, ack };
}

test('SQLite admission: exact replay/conflicts/auth/revocation/CAS/epochs are pre-effect, kernel untouched', async t => {
  const h = setup(t); h.prepare();
  const launch = command('wave.launch', h.state().revision, { wave: 1 }, 'root', 'stable-launch');
  const original = success(h.runtime.execute(h.token, launch));
  assert.equal(h.calls.length, 0);
  assert.deepEqual(success(h.runtime.execute(h.token, launch)), original);
  denied(h.runtime.execute(h.token, { ...launch, payload: { wave: 2 } }), 'COMMAND_ID_REUSE');
  denied(h.runtime.execute(h.token, { ...launch, scope: scope('maker') }), 'COMMAND_ID_REUSE');
  denied(h.runtime.execute(h.token, { ...launch, commandId: 'stale' }), 'STALE_REVISION');
  denied(h.runtime.execute(h.token, { ...launch, commandId: 'epoch', scope: { ...scope(), ownerEpoch: 2 } }), 'OWNER_EPOCH_MISMATCH');
  const bob = h.runtime.registerPrincipal({ id: 'bob', kind: 'advisor', scopes: h.grants, operations: OPERATIONS });
  denied(h.runtime.execute(bob, launch), 'PRINCIPAL_MISMATCH');
  denied(h.runtime.execute('0'.repeat(64), launch), 'UNAUTHORIZED');
  const worker = h.runtime.registerPrincipal({ id: 'worker', kind: 'worker', scopes: [h.grants[1]], operations: ['progress', 'wait', 'delivery.ack', 'artifact.read'] });
  denied(h.runtime.execute(worker, launch), 'SCOPE_FORBIDDEN');
  assert.throws(() => h.runtime.registerPrincipal({ id: 'nested', kind: 'worker', scopes: [h.grants[1]], operations: ['wave.launch'] }), /WORKER_OPERATION/);
  assert.throws(() => h.runtime.registerPrincipal({ id: 'wild', kind: 'operator', scopes: [{ ...h.grants[0], node: '*' }], operations: OPERATIONS }), /INVALID_ID/);
  h.runtime.revokePrincipal('bob'); denied(h.runtime.execute(bob, launch), 'UNAUTHORIZED');
  denied(h.runtime.execute(bob, read()), 'UNAUTHORIZED');
  await h.runtime.dispatch(); assert.equal(h.calls.length, 1);
  assert.throws(() => h.runtime.close(), /SHUTDOWN_ACTIVE/);
  h.settle(); h.ack(); h.runtime.close();
});

test('durable BLOCKED, kernel reply/cancel coalescing, canonical ordering and result-v2 leniency', async t => {
  const h = setup(t); h.prepare(); success(h.send('wave.launch', { wave: 1 })); await h.runtime.dispatch();
  writeFileSync(join(h.root, 'runs/run/maker/result.md'), 'Status: BLOCKED\nNeed the option');
  h.emit('maker', 'blocked', { requestId: 'question-1', kind: 'question', text: 'Choose A or B' });
  assert.equal(h.state('maker').snapshot.state, 'blocked');
  const bad = command('node.reply', h.state('maker').revision, { attempt: 1, requestId: 'wrong', text: 'A' }, 'maker');
  denied(h.runtime.execute(h.token, bad), 'REQUEST_MISMATCH');
  const reply = command('node.reply', h.state('maker').revision, { attempt: 1, requestId: 'question-1', text: 'A' }, 'maker', 'answer');
  const receipt = success(h.runtime.execute(h.token, reply));
  assert.equal(receipt.intentId, 'intent:answer'); assert.equal(h.state('maker').snapshot.attempt, 2);
  await h.runtime.dispatch(); assert.equal(h.calls.filter(e => e.op === 'node.reply').length, 1);
  assert.deepEqual(success(h.runtime.execute(h.token, reply)), receipt);
  denied(h.send('node.cancel', { attempt: 1, reason: 'old attempt' }, 'maker'), 'ATTEMPT_MISMATCH');
  const cancel = success(h.send('node.cancel', { attempt: 2, reason: 'stop' }, 'maker'));
  const coalesced = success(h.send('node.cancel', { attempt: 2, reason: 'again' }, 'maker'));
  assert.equal(coalesced.outcome, 'coalesced'); assert.equal(cancel.intentId, coalesced.intentId);
  denied(h.send('node.reply', { attempt: 2, requestId: 'question-1', text: 'A' }, 'maker'), 'CANCEL_PENDING');
  await h.runtime.dispatch(); assert.equal(h.calls.filter(e => e.op === 'node.cancel').length, 1);
  assert.equal(h.state('maker').status, 'running'); assert.equal(h.state('maker').processExited, undefined);
  h.emit('maker', 'settled', { status: 'cancelled', reason: 'supervision finalized', verified: false });
  assert.equal(h.state('maker').status, 'cancelled');
  h.emit('maker', 'process-exited', { code: 0 }); assert.equal(h.state('maker').processExited, 0);
  denied(h.send('node.resume', {}, 'maker'), 'RESUME_UNSUPPORTED');
  assert.equal(success(h.send('node.cancel', { attempt: 2, reason: 'terminal' }, 'maker')).outcome, 'already-terminal');
  const exported = h.runtime.exportTrace('run');
  const events = parseTrace(readFileSync(exported.path, 'utf8'));
  assert.deepEqual(validateTrace(events, await loadSchema()), { ok: true, problems: [] });
  const replyIndex = events.findIndex(e => e.type === 'node.reply.sent'); assert.equal(events[replyIndex + 1].type, 'node.resumed');
  assert.equal(events.filter(e => e.type === 'node.cancel.requested').length, 1);
  h.ack(); h.runtime.close();
});

test('cancel directly from blocked emits no illegal post-settlement result events', async t => {
  const h = setup(t); h.prepare(); success(h.send('wave.launch', { wave: 1 })); await h.runtime.dispatch();
  writeFileSync(join(h.root, 'runs/run/maker/result.md'), 'BLOCKED\nNeed permission');
  h.emit('maker', 'blocked', { requestId: 'permission', kind: 'permission', text: 'Allow?' });
  success(h.send('node.cancel', { attempt: 1, reason: 'no' }, 'maker')); await h.runtime.dispatch();
  h.emit('maker', 'settled', { status: 'cancelled', reason: 'finalized', verified: false });
  h.runtime.exportTrace('run'); h.ack(); h.runtime.close();
});

test('graph gates packet scope/topology/cycles/waves and verified upstream, no hidden launch', async t => {
  const h = setup(t);
  denied(h.send('wave.launch', { wave: 1 }), 'WAVE_NOT_READY');
  denied(h.send('packet.admit', { node: 'maker', packet: { ...packet(h.work), executable: '/bin/sh' } }), 'EXTRA_FIELD');
  denied(h.send('packet.admit', { node: 'maker', packet: { ...packet(h.work), cwd: '/' } }), 'CWD_FORBIDDEN');
  denied(h.send('graph.admit', { ...graph(), topology: 'nested' }), 'UNSUPPORTED_TOPOLOGY');
  denied(h.send('graph.admit', graph([['maker']], { maker: ['maker'] })), 'GRAPH_CYCLE_OR_ORDER');
  h.prepare([['maker'], ['checker']], { maker: [], checker: ['maker'] });
  success(h.send('wave.launch', { wave: 1 })); await h.runtime.dispatch();
  denied(h.send('wave.launch', { wave: 2 }), 'WAVE_NOT_READY');
  h.settle(); assert.equal(h.calls.length, 1); // settlement never launches wave 2
  success(h.send('wave.launch', { wave: 2 })); await h.runtime.dispatch(); assert.equal(h.calls.length, 2);
  h.settle('checker'); h.runtime.exportTrace('run'); h.ack(); h.runtime.close();
  const unverified = setup(t); unverified.prepare([['maker'], ['checker']], { maker: [], checker: ['maker'] });
  success(unverified.send('wave.launch', { wave: 1 })); await unverified.runtime.dispatch(); unverified.settle('maker', 'done', false);
  denied(unverified.send('wave.launch', { wave: 2 }), 'UPSTREAM_NOT_VERIFIED'); unverified.ack(); unverified.runtime.close();
});

for (const transport of ['socket', 'cli', 'mcp']) test(`${transport}: full operational contract, scoped credentials, paths and reconnect`, async t => {
  const h = setup(t, { create: false }); const service = await startService(h.runtime);
  const credential = { socketPath: service.socketPath, token: h.token };
  assert.equal(statSync(h.root).mode & 0o777, 0o700); assert.equal(statSync(service.socketPath).mode & 0o777, 0o600);
  const credentialPath = join(h.root, 'operator.json'); writeCredential(credentialPath, credential, h.runtime);
  const transportToken = h.runtime.registerPrincipal({ id: 'transport-model', kind: 'advisor', scopes: h.grants, operations: OPERATIONS });
  const transportMcp = createMcpHandler({ ...credential, token: transportToken });
  await transportMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
  const send = async (op, payload = {}, name = 'root') => {
    const envelope = MUTATIONS.includes(op) ? command(op, op === 'workstream.create' ? 0 : h.state(name).revision, payload, name) : read(op, name, payload);
    if (transport === 'socket') return callSocket(credential, envelope);
    if (transport === 'mcp') {
      const { op: operation, ...args } = envelope;
      const result = await transportMcp({ jsonrpc: '2.0', id: ++serial, method: 'tools/call', params: { name: `advisor_${operation.replaceAll('.', '_')}`, arguments: args } });
      return JSON.parse(result.result.content[0].text);
    }
    const child = spawn(node, ['scripts/advisor-runtime/cli.mjs', 'call', credentialPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.stdin.end(JSON.stringify(envelope)); const [code] = await once(child, 'exit');
    assert.ok(code === 0 || code === 1, err); return JSON.parse(out);
  };
  success(await send('workstream.create', { cwd: h.work, host: 'codex' }));
  success(await send('workstream.open')); success(await send('progress'));
  denied(await callSocket({ ...credential, token: '0'.repeat(64) }, read()), 'UNAUTHORIZED');
  denied(await callSocket(credential, { ...read(), principal: { id: 'operator' } }), 'EXTRA_FIELD');
  denied(await callSocket(credential, { ...read(), op: 'sql.write' }), 'UNSUPPORTED_OPERATION');
  denied(await callSocket(credential, { ...read(), scope: scope('root', 'other') }), 'SCOPE_FORBIDDEN');
  success(await send('packet.admit', { node: 'maker', packet: packet(h.work) })); success(await send('graph.admit', graph()));
  success(await send('wave.launch', { wave: 1 })); await h.runtime.dispatch();
  h.emit('maker', 'progress', { note: 'working' });
  writeFileSync(join(h.root, 'runs/run/maker/result.md'), 'BLOCKED\nChoose');
  h.emit('maker', 'blocked', { requestId: 'socket-question', kind: 'question', text: 'Which?' });
  success(await send('node.reply', { attempt: 1, requestId: 'socket-question', text: 'A' }, 'maker')); await h.runtime.dispatch();
  success(await send('node.cancel', { attempt: 2, reason: 'stop' }, 'maker')); await h.runtime.dispatch();
  h.emit('maker', 'settled', { status: 'cancelled', reason: 'finalized', verified: false });
  denied(await send('node.resume', {}, 'maker'), 'RESUME_UNSUPPORTED');
  writeFileSync(join(h.root, 'runs/run/maker/output.log'), 'fixture log');
  assert.equal(success(await send('log.read', { path: 'output.log', offset: 0, maxBytes: 65536 }, 'maker')).text, 'fixture log');
  success(await send('artifact.read', { path: 'result.md', offset: 0, maxBytes: 65536 }, 'maker'));
  denied(await send('artifact.read', { path: '../root/result.md', offset: 0, maxBytes: 5 }, 'maker'), 'PATH_FORBIDDEN');
  symlinkSync(join(h.root, 'operator.json'), join(h.root, 'runs/run/maker/secret'));
  denied(await send('artifact.read', { path: 'secret', offset: 0, maxBytes: 5 }, 'maker'), 'SYMLINK_PATH');
  denied(await send('artifact.read', { path: 'result.md', offset: 0, maxBytes: 65537 }, 'maker'), 'INVALID_INTEGER');
  renameSync(join(h.root, 'runs/run/maker'), join(h.root, 'runs/run/maker-real'));
  symlinkSync(h.root, join(h.root, 'runs/run/maker'));
  denied(await send('artifact.read', { path: 'operator.json', offset: 0, maxBytes: 65536 }, 'maker'), 'SYMLINK_PATH');
  rmSync(join(h.root, 'runs/run/maker')); renameSync(join(h.root, 'runs/run/maker-real'), join(h.root, 'runs/run/maker'));
  success(await send('root.create', { adapter: 'mock', model: 'fixture', thinking: 'none', text: 'hello' })); await h.runtime.dispatch();
  h.emit('root', 'progress', { text: 'hello' }); h.emit('root', 'completed', { text: 'answer' });
  success(await send('root.message', { text: 'question' })); await h.runtime.dispatch();
  h.emit('root', 'blocked', { requestId: 'root-question', kind: 'permission', text: 'May I?' });
  denied(await send('root.reply', { requestId: 'wrong', text: 'no' }), 'REQUEST_MISMATCH');
  success(await send('root.reply', { requestId: 'root-question', text: 'no' })); await h.runtime.dispatch();
  success(await send('root.cancel', { reason: 'stop' })); await h.runtime.dispatch();
  h.emit('root', 'completed', { text: 'cancel finalized' }); denied(await send('root.resume'), 'RESUME_UNSUPPORTED');
  const deliveries = success(await send('wait', { timeoutMs: 0, limit: 128 }));
  assert.deepEqual(success(await send('wait', { timeoutMs: 0, limit: 128 })), deliveries);
  for (const delivery of deliveries) success(await send('delivery.ack', { deliveryId: delivery.id }));
  success(await send('delivery.ack', { deliveryId: deliveries[0].id }));
  assert.deepEqual(success(await send('wait', { timeoutMs: 1, limit: 128 })), []);
  const cli = spawn(node, ['scripts/advisor-runtime/cli.mjs', 'call', credentialPath], { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; cli.stdout.on('data', c => stdout += c); cli.stdin.end(JSON.stringify(read('workstream.open')));
  assert.equal((await once(cli, 'exit'))[0], 0); assert.equal(JSON.parse(stdout).ok, true); assert.ok(!stdout.includes(h.token));
  const modelToken = h.runtime.registerPrincipal({ id: 'model', kind: 'advisor', scopes: h.grants, operations: ['workstream.open', 'progress', 'wait', 'node.cancel'] });
  const mcp = createMcpHandler({ ...credential, token: modelToken });
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
  assert.equal((await mcp(init)).result.serverInfo.name, 'advisor-runtime');
  const toolList = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); assert.deepEqual(toolList.result.tools.map(tool => tool.name).sort(), ['advisor_workstream_open', 'advisor_progress', 'advisor_wait', 'advisor_node_cancel'].sort());
  const { op: _op, ...arguments_ } = read('workstream.open');
  const request = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'advisor_workstream_open', arguments: arguments_ } };
  assert.equal((await mcp(request)).result.isError, false);
  const unsafe = createMcpHandler(credential); await unsafe(init);
  assert.match((await unsafe(request)).result.content[0].text, /MODEL_OPERATOR_FORBIDDEN/);
  assert.equal((await mcp({ jsonrpc: '2.0', id: 4, method: 'registerPrincipal' })).error.message, 'METHOD_NOT_FOUND');
  const modelCredentialPath = join(h.root, 'model.json'); writeCredential(modelCredentialPath, { ...credential, token: modelToken }, h.runtime);
  const stdioMcp = spawn(node, ['scripts/advisor-runtime/cli.mjs', 'mcp', modelCredentialPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let mcpOutput = ''; stdioMcp.stdout.on('data', c => mcpOutput += c);
  stdioMcp.stdin.end([init, request].map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal((await once(stdioMcp, 'exit'))[0], 0);
  assert.equal(JSON.parse(mcpOutput.trim().split('\n')[1]).result.isError, false);
  assert.ok(!mcpOutput.includes(modelToken));
  h.runtime.revokePrincipal('model'); assert.match((await mcp(request)).result.content[0].text, /UNAUTHORIZED/);
  await service.close();
});

test('wait reauthenticates revoked principals and artifact reads reject stale epoch', async t => {
  const h = setup(t);
  const token = h.runtime.registerPrincipal({ id: 'waiter', kind: 'advisor', scopes: h.grants, operations: ['wait'] });
  const pending = h.runtime.request(token, read('wait', 'root', { timeoutMs: 10000, limit: 10 }));
  h.runtime.revokePrincipal('waiter'); denied(await pending, 'UNAUTHORIZED');
  denied(h.runtime.execute(h.token, { ...read('artifact.read', 'maker', { path: 'result.md', offset: 0, maxBytes: 10 }), scope: { ...scope('maker'), ownerEpoch: 2 } }), 'OWNER_EPOCH_MISMATCH');
  h.runtime.close();
});

// Real Node processes and SQLite; no live model or headless coding helper. Child prints only sanitized assertions.
const childPrelude = `
import assert from 'node:assert/strict';
import {AdvisorRuntime} from ${JSON.stringify(new URL('../scripts/advisor-runtime/runtime.mjs', import.meta.url).href)};
import {OPERATIONS} from ${JSON.stringify(new URL('../scripts/advisor-runtime/contract.mjs', import.meta.url).href)};
import {writeFileSync,readFileSync,appendFileSync} from 'node:fs';
const root=process.env.TEST_ROOT; const work=root+'/../work';
let activeFault=process.env.TEST_FAULT||'';
const adapter={capabilities:{'node.launch':true,'node.reply':true,'node.cancel':true},async execute({effect,recordHandle,context,emit}){
 appendFileSync(root+'/effects.log',effect.op+'\\n');
 recordHandle({id:'owned-handle'});
 writeFileSync(context.resultPath,'Nonblank terminal result');
 emit({id:'finish',kind:'settled',attempt:1,data:{status:'done',reason:'finished',verified:true}});
 return {accepted:true};
}};
const runtime=new AdvisorRuntime({stateRoot:root,allowedRoots:[work],adapters:{roots:{},workers:{mock:adapter}},fault(point){if(point===activeFault)process.exit(73);}});
const scope={workstream:'work',run:'run',node:'root',ownerEpoch:1};
const read=(op='progress',payload={})=>({v:1,op,scope,payload});
const cmd=(op,expectedRevision,payload,commandId=op.replaceAll('.','-'))=>({v:1,op,scope,payload,commandId,expectedRevision});
let token;
if(process.env.TEST_BOOT==='1'){
 token=runtime.registerPrincipal({id:'operator',kind:'operator',scopes:['root','maker'].map(node=>({workstream:'work',run:'run',node})),operations:OPERATIONS});
 writeFileSync(root+'/token',token,{mode:0o600});
 assert.equal(runtime.execute(token,cmd('workstream.create',0,{cwd:work,host:'codex'})).ok,true);
 assert.equal(runtime.execute(token,cmd('packet.admit',1,{node:'maker',packet:{role:'builder',task:'test',acceptance:['proof'],riskTier:'high',cwd:work,adapter:'mock',model:'fixture',thinking:'none'}})).ok,true);
 assert.equal(runtime.execute(token,cmd('graph.admit',2,{graph:'graph',waves:[['maker']],dependencies:{maker:[]},topology:'flat-root',maxParallel:1,maxRepairLoops:0})).ok,true);
}else token=readFileSync(root+'/token','utf8');
const launch=cmd('wave.launch',3,{wave:1},'launch');
`;
function processProbe(root, source, env = {}) {
  const result = spawnSync(node, ['--input-type=module', '-e', childPrelude + source], { env: { ...process.env, TEST_ROOT: root, ...env }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined, result.error?.message); return result;
}
function inspect(root, sql) { const db = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } }

test('Node process crash before/after transaction commit preserves atomic replay and no precommit effect', t => {
  for (const point of ['transaction.beforeCommit', 'transaction.afterCommit']) {
    const root = temporary(t);
    const result = processProbe(root, `activeFault=${JSON.stringify(point)};runtime.execute(token,launch);`, { TEST_BOOT: '1' });
    assert.equal(result.status, 73, result.stderr);
    const committed = point.endsWith('afterCommit');
    assert.equal(inspect(root, "SELECT * FROM receipts WHERE id='launch'").length, committed ? 1 : 0);
    assert.equal(inspect(root, 'SELECT * FROM effects').length, committed ? 1 : 0);
    const restarted = processProbe(root, `const a=runtime.execute(token,launch);assert.equal(a.ok,true);assert.equal(a.replayed,${committed});await runtime.dispatch();const b=runtime.execute(token,launch);assert.deepEqual(b.receipt,a.receipt);assert.equal(b.replayed,true);runtime.exportTrace('run');console.log('restart-pass');`);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(readFileSync(join(root, 'effects.log'), 'utf8').trim(), 'node.launch');
  }
});

test('Node process faults at claim/handle never duplicate ambiguous launch; recorded handle is durable', t => {
  for (const point of ['claim.before', 'claim.after', 'handle.before', 'handle.after', 'effect.afterDone']) {
    const root = temporary(t);
    const first = processProbe(root, `runtime.execute(token,launch);activeFault=${JSON.stringify(point)};await runtime.dispatch();`, { TEST_BOOT: '1' });
    assert.equal(first.status, 73, `${point}: ${first.stderr}`);
    const restart = processProbe(root, `await runtime.dispatch();console.log(JSON.stringify(runtime.execute(token,read())));`);
    assert.equal(restart.status, 0, restart.stderr);
    const rows = inspect(root, 'SELECT state,handle FROM effects');
    if (['claim.after', 'handle.before', 'handle.after'].includes(point)) {
      assert.equal(rows[0].state, 'recovery-required'); assert.match(restart.stdout, /recovery-required/);
      assert.equal(Boolean(rows[0].handle), point === 'handle.after');
    } else assert.equal(rows[0].state, 'done');
    let effects = ''; try { effects = readFileSync(join(root, 'effects.log'), 'utf8'); } catch {}
    assert.equal(effects.split('\n').filter(Boolean).length, point === 'claim.after' ? 0 : 1, point);
  }
});

test('restart delivery/ack fault before/after write/commit redelivers or deduplicates; partial exports rebuild atomically', async t => {
  for (const point of ['ack.before', 'ack.afterWrite', 'transaction.afterCommit', 'export.partial', 'export.renamed']) {
    const root = temporary(t);
    let source = `runtime.execute(token,launch);await runtime.dispatch();runtime.exportTrace('run');activeFault=${JSON.stringify(point)};`;
    if (point.startsWith('export')) source += `writeFileSync(root+'/traces/run.jsonl','{"partial":');runtime.exportTrace('run');`;
    else source += `const d=runtime.execute(token,read('wait',{timeoutMs:0,limit:10})).value[0];const rev=runtime.execute(token,read()).value.revision;runtime.execute(token,cmd('delivery.ack',rev,{deliveryId:d.id},'ack'));`;
    const first = processProbe(root, source, { TEST_BOOT: '1' }); assert.equal(first.status, 73, first.stderr);
    const restart = processProbe(root, `const deliveries=runtime.execute(token,read('wait',{timeoutMs:0,limit:10}));console.log(JSON.stringify(deliveries));runtime.exportTrace('run');`);
    assert.equal(restart.status, 0, restart.stderr);
    assert.equal(JSON.parse(restart.stdout).value.length, point === 'transaction.afterCommit' ? 0 : 1);
    const events = parseTrace(readFileSync(join(root, 'traces/run.jsonl'), 'utf8'));
    assert.equal(validateTrace(events, await loadSchema()).ok, true);
    assert.equal(new Set(events.map(e => e.seq)).size, events.length);
  }
});

test('competing actual owners: live PID never stolen, SQL nonce fences mutation, legacy/runtime exclusion', async t => {
  const root = temporary(t);
  const child = spawn(node, ['--input-type=module', '-e', childPrelude + `console.log('ready');setInterval(()=>{},1000);`], { env: { ...process.env, TEST_ROOT: root, TEST_BOOT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  const contenders = await Promise.all(Array.from({ length: 3 }, async () => {
    const p = spawn(node, ['--input-type=module', '-e', childPrelude], { env: { ...process.env, TEST_ROOT: root }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; p.stderr.on('data', c => stderr += c); const [status] = await once(p, 'exit'); return { status, stderr };
  }));
  for (const result of contenders) { assert.notEqual(result.status, 0); assert.match(result.stderr, /OWNER_BUSY/); }
  child.kill('SIGKILL'); await once(child, 'exit');
  const restart = processProbe(root, `assert.equal(runtime.execute(token,read()).ok,true);console.log('owner-recovered');`); assert.equal(restart.status, 0, restart.stderr);
  const h = setup(t);
  assert.throws(() => withRunOwnership(h.root, 'run', 'legacy', 'pi', () => {}), /RUN_OWNED/);
  withRunOwnership(h.root, 'legacy', 'legacy', 'pi', () => {});
  assert.throws(() => withRunOwnership(h.root, 'legacy', 'runtime', 'runtime', () => {}), /RUN_OWNED/);
  writeFileSync(join(h.root, 'traces', 'old.jsonl'), 'old trace');
  assert.throws(() => withRunOwnership(h.root, 'old', 'runtime', 'runtime', () => {}), /LEGACY_TRACE/);
  const db = new DatabaseSync(join(h.root, 'runtime.sqlite'));
  const nonce = db.prepare('SELECT nonce FROM owner').get().nonce;
  db.prepare('UPDATE owner SET nonce=?').run('other-owner');
  denied(h.runtime.execute(h.token, read()), 'OWNER_FENCE');
  db.prepare('UPDATE owner SET nonce=?').run(nonce); db.close(); h.runtime.close();
});

test('competing CLI processes commit one CAS winner and replay without duplicate dispatch', async t => {
  const h = setup(t); h.prepare(); const service = await startService(h.runtime);
  const credentialPath = join(h.root, 'client.json'); writeCredential(credentialPath, { socketPath: service.socketPath, token: h.token }, h.runtime);
  const call = async envelope => {
    const child = spawn(node, ['scripts/advisor-runtime/cli.mjs', 'call', credentialPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', c => output += c); child.stdin.end(JSON.stringify(envelope));
    await once(child, 'exit'); return JSON.parse(output);
  };
  const revision = h.state().revision;
  const commands = Array.from({ length: 4 }, (_, i) => command('wave.launch', revision, { wave: 1 }, 'root', `race-${i}`));
  const results = await Promise.all(commands.map(call));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.ok(results.filter(r => !r.ok).every(r => r.error === 'STALE_REVISION'));
  const winner = commands[results.findIndex(r => r.ok)];
  const replay = await Promise.all([call(winner), call(winner)]);
  assert.ok(replay.every(r => r.ok && r.replayed));
  await h.runtime.dispatch(); assert.equal(h.calls.length, 1);
  h.settle(); h.ack(); await service.close();
});

test('principal revocation and prior-epoch fencing survive SQLite restart', t => {
  const root = temporary(t);
  const first = processProbe(root, `runtime.execute(token,launch);runtime.revokePrincipal('operator');`, { TEST_BOOT: '1' });
  assert.equal(first.status, 0, first.stderr);
  const revoked = processProbe(root, `assert.deepEqual(runtime.execute(token,launch),{ok:false,error:'UNAUTHORIZED'});assert.deepEqual(runtime.execute(token,read()),{ok:false,error:'UNAUTHORIZED'});`);
  assert.equal(revoked.status, 0, revoked.stderr);
  const fresh = temporary(t);
  const initial = processProbe(fresh, `runtime.execute(token,launch);`, { TEST_BOOT: '1' }); assert.equal(initial.status, 0, initial.stderr);
  const db = new DatabaseSync(join(fresh, 'runtime.sqlite'));
  const row = JSON.parse(db.prepare('SELECT data FROM runs').get().data); row.epoch = 2;
  db.prepare('UPDATE runs SET data=?').run(JSON.stringify(row)); db.close();
  const stale = processProbe(fresh, `assert.deepEqual(runtime.execute(token,launch),{ok:false,error:'OWNER_EPOCH_MISMATCH'});`);
  assert.equal(stale.status, 0, stale.stderr);
});

test('result absence/blank/unreadable stall distinctly; invalid event IDs and old-turn emits fail closed', async t => {
  for (const kind of ['missing', 'blank', 'unreadable']) {
    const h = setup(t); h.prepare(); success(h.send('wave.launch', { wave: 1 })); await h.runtime.dispatch();
    const path = join(h.root, 'runs/run/maker/result.md');
    if (kind === 'blank') writeFileSync(path, '  \n');
    if (kind === 'unreadable') symlinkSync(join(h.root, 'runtime.sqlite'), path);
    const input = h.contexts.get('maker');
    const event = { id: 'dedup', kind: 'progress', attempt: 1, data: { note: 'hello' } };
    input.emit(event); assert.deepEqual(input.emit(event), { replayed: true });
    assert.throws(() => input.emit({ ...event, data: { note: 'changed' } }), /EVENT_ID_REUSE/);
    assert.throws(() => input.emit({ ...event, id: 'old', attempt: 2 }), /ATTEMPT_MISMATCH/);
    assert.throws(() => input.emit({ ...event, id: 'unknown', kind: 'arbitrary-write' }), /UNKNOWN_EVENT/);
    h.emit('maker', 'settled', { status: 'done', reason: 'finished', verified: true });
    assert.equal(h.state('maker').status, 'stalled');
    const outcome = success(h.runtime.execute(h.token, read('wait', 'root', { timeoutMs: 0, limit: 128 }))).find(d => d.kind === 'settled');
    assert.equal(outcome.reason, `result-${kind}`); h.ack(); h.runtime.close();
  }
});

test('bounded framing, unsafe credentials, model worker nesting and shutdown pending delivery fail closed', async t => {
  const h = setup(t); const service = await startService(h.runtime);
  const credentials = { socketPath: service.socketPath, token: h.token };
  const path = join(h.root, 'unsafe.json'); writeCredential(path, credentials, h.runtime); chmodSync(path, 0o644);
  const cli = spawn(node, ['scripts/advisor-runtime/cli.mjs', 'call', path], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = ''; cli.stderr.on('data', c => err += c); cli.stdin.end(JSON.stringify(read()));
  assert.equal((await once(cli, 'exit'))[0], 1); assert.match(err, /UNSAFE_FILE/); assert.ok(!err.includes(h.token));
  denied(h.runtime.execute(h.token, read()), 'UNSAFE_FILE'); // owner also rechecks its protected storage
  chmodSync(path, 0o600); // restore the synthetic bad setup before unrelated framing/lifecycle checks
  denied(await callSocket(credentials, read('wait', 'root', { timeoutMs: 10001, limit: 1 })), 'INVALID_INTEGER');
  await assert.rejects(callSocket(credentials, { ...read(), payload: { text: 'x'.repeat(40000) } }), /ENVELOPE_TOO_LARGE/);
  h.prepare(); success(h.send('wave.launch', { wave: 1 })); assert.throws(() => h.runtime.close(), /SHUTDOWN_PENDING/);
  await h.runtime.dispatch(); h.settle(); assert.throws(() => h.runtime.close(), /SHUTDOWN_DELIVERY/);
  h.ack(); await service.close();
});

test('worker delivery ack advances node CAS without root authority; FIFO artifacts never block', async t => {
  const h = setup(t); h.prepare(); success(h.send('wave.launch', { wave: 1 })); await h.runtime.dispatch();
  h.emit('maker', 'progress', { note: 'bounded' });
  const worker = h.runtime.registerPrincipal({ id: 'scoped-worker', kind: 'worker', scopes: [h.grants[1]], operations: ['progress', 'wait', 'delivery.ack', 'artifact.read'] });
  const deliveries = success(h.runtime.execute(worker, read('wait', 'maker', { timeoutMs: 0, limit: 10 })));
  const revision = h.state('maker').revision;
  const ack = command('delivery.ack', revision, { deliveryId: deliveries[0].id }, 'maker', 'worker-ack');
  assert.equal(success(h.runtime.execute(worker, ack)).revision, revision + 1);
  denied(h.runtime.execute(worker, { ...ack, commandId: 'racing-ack' }), 'STALE_REVISION');
  assert.equal(h.runtime.execute(worker, ack).replayed, true);
  denied(h.runtime.execute(worker, read()), 'SCOPE_FORBIDDEN');
  const fifo = join(h.root, 'runs/run/maker/pipe');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  denied(h.runtime.execute(worker, read('artifact.read', 'maker', { path: 'pipe', offset: 0, maxBytes: 10 })), 'UNSAFE_FILE');
  h.settle(); h.ack(); h.runtime.close();
});

test('shared appender fence spans async writes and credential files cannot enter artifact scope', async t => {
  const h = setup(t);
  let release;
  const pending = withRunOwnership(h.root, 'async-legacy', 'legacy', 'pi', () => new Promise(resolve => { release = resolve; }));
  assert.throws(() => withRunOwnership(h.root, 'async-legacy', 'legacy', 'pi', () => {}), /OWNER_BUSY/);
  release(); await pending;
  withRunOwnership(h.root, 'async-legacy', 'legacy', 'pi', () => {});
  assert.throws(() => writeCredential(join(h.root, 'runs/run/root/token.json'), { socketPath: join(h.root, 'runtime.sock'), token: h.token }), /CREDENTIAL_IN_ARTIFACT_SCOPE/);
  h.runtime.close();
});

test('MCP framing rejects protocol drift, excess requests and oversized wire bytes', async () => {
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };
  const handler = createMcpHandler({});
  assert.equal((await handler({ ...initialize, params: { ...initialize.params, protocolVersion: 'unknown' } })).error.message, 'UNSUPPORTED_PROTOCOL');
  const sink = () => new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const lines = [initialize, ...Array.from({ length: 128 }, () => ({ jsonrpc: '2.0', method: 'notifications/initialized' }))].map(r => JSON.stringify(r) + '\n');
  await assert.rejects(serveMcp({}, Readable.from(lines), sink()), /REQUEST_LIMIT/);
  await assert.rejects(serveMcp({}, Readable.from(['x'.repeat(70000)]), sink()), /ENVELOPE_TOO_LARGE/);
});
