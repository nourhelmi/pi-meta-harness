import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AdvisorRuntime } from '../scripts/advisor-runtime/runtime.mjs';
import { createPiDetachAdapter } from '../scripts/advisor-runtime/adapters/pi-detach.mjs';
import { OPERATIONS } from '../scripts/advisor-runtime/contract.mjs';
import { readStoredCredential, startService } from '../scripts/advisor-runtime/service.mjs';
import { callAgentMessage } from '../scripts/advisor-runtime/messaging-client.mjs';

const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value ?? result.receipt; };

function fixture(t) {
  const base = realpathSync(mkdtempSync('/tmp/advisor-messaging-'));
  const cwd = join(base, 'work'); const stateRoot = join(base, 'state'); mkdirSync(cwd);
  const calls = []; const live = new Map(); const generations = new Map();
  const port = {
    version: 1,
    async prepare(params, sourceDirectory) {
      return { v: 1, command: 'worker', prompt: params.prompt, role: params.role ?? 'builder', runtime: params.harness ?? 'pi', model: 'fixture', thinking: 'none', maxTurns: null,
        requiredSkills: [], harness: params.harness ?? 'pi', keepAlive: params.keepAlive ?? true, label: params.label ?? `worker-${calls.length + 1}`, resultDiscovery: null,
        resultPolicy: 'runtime-capture', sourceDirectory, environment: { ADVISOR_RUNTIME_DESCRIPTOR: '', PI_DETACH_RUNTIME_BRIDGE: '', ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_RUNTIME_CANONICAL_OWNER: '1' } };
    },
    async launch(input) {
      calls.push(input); const generation = (generations.get(input.id) ?? 0) + 1; generations.set(input.id, generation);
      const handle = input.hooks.expectedHandle ?? { id: `handle-${input.id}`, session: `session-${input.id}` }; input.hooks.recordHandle(handle);
      const state = live.get(input.id) ?? { readable: true, messages: [] }; live.set(input.id, state);
      return {
        readLive: async () => { const callback = state.onRead; state.onRead = null; await callback?.(); if (!state.readable) throw new Error('unavailable'); return 'live'; },
        detach() {},
        interrupt: async hooks => { const next = (generations.get(input.id) ?? generation) + 1; generations.set(input.id, next); hooks.settled('done', 'cancelled', next); },
        runtimeObservation: async () => ({ session: handle.session, generation, state: 'working' }),
        message: async message => { state.messages.push(message); return { status: state.delivery ?? 'queued', session: handle.session, generation, state: 'working' }; },
      };
    },
  };
  const adapter = createPiDetachAdapter(port); const scope = { workstream: 'w', run: 'seed', node: 'root', ownerEpoch: 1 };
  const principal = { id: 'advisor', kind: 'advisor', scopes: ['root', 'worker'].map(node => ({ workstream: 'w', run: 'seed', node })), operations: OPERATIONS };
  const runtime = new AdvisorRuntime({ stateRoot, allowedRoots: [cwd], adapters: { roots: {}, workers: { 'pi-detach': adapter } },
    piBridge: { version: 1, portVersion: 1, principalId: principal.id, sessionId: 'root-session', scopes: [scope], cwd, prepare: port.prepare, release() {},
      allowedRoots: [cwd], dynamic: true, managedIdentity: { fixture: true }, rootHost: 'pi', readLive: adapter.readLive } });
  const rootToken = runtime.registerPrincipal(principal); runtime.initializeFamily();
  const pi = (action, payload = {}) => runtime.piDetachRequest(rootToken, { v: 1, op: 'pi.detach', sessionId: 'root-session', action, payload }, 'model');
  const launch = async (toolCallId, params = {}) => {
    const value = ok(await pi('call', { toolCallId, tool: 'bg_agent', cwd, params: { prompt: `task ${toolCallId}`, label: toolCallId, keepAlive: true, ...params } }));
    await runtime.dispatch(); return value.runId;
  };
  const token = runId => {
    const call = calls.find(value => value.id === runId); assert(call);
    return readStoredCredential(call.intent.environment.AGENT_MESSAGE_DESCRIPTOR).token;
  };
  const message = (credential, payload) => runtime.messageRequest(credential, { v: 1, op: 'agent.message', payload }, 'model');
  const settle = (runId, state = 'done') => {
    const call = calls.findLast(value => value.id === runId); writeFileSync(join(call.intent.sourceDirectory, 'result.md'), 'Status: DONE');
    call.hooks.settled(state, 'output', (generations.get(runId) ?? 1) + 1);
  };
  t.after(() => { try { runtime.disposeUnstarted(); } catch {} rmSync(base, { recursive: true, force: true }); });
  return { base, cwd, stateRoot, calls, live, runtime, rootToken, pi, launch, token, message, settle };
}

test('managed Pi/native leaves share scoped send, reply, sibling and durable dedupe semantics', async t => {
  const f = fixture(t); const piLeaf = await f.launch('pi-leaf', { harness: 'pi' }); const nativeLeaf = await f.launch('native-leaf', { harness: 'native' });
  const piToken = f.token(piLeaf); const nativeToken = f.token(nativeLeaf);
  const rootList = ok(await f.message(f.rootToken, { action: 'list' }));
  assert.match(rootList.self.id, /^advisor-[a-f0-9]{24}$/); assert.deepEqual(rootList.peers.map(peer => peer.id).sort(), [nativeLeaf, piLeaf].sort()); assert(rootList.peers.every(peer => peer.available), JSON.stringify(rootList));
  const leafList = ok(await f.message(piToken, { action: 'list' })); assert.equal(leafList.parent, rootList.self.id); assert(leafList.peers.some(peer => peer.id === nativeLeaf));

  const inbound = ok(await f.message(piToken, { action: 'send', to: 'parent', text: 'question', messageId: 'leaf-root-1' }));
  assert.equal(inbound.status, 'queued'); assert.equal(inbound.from, piLeaf); assert.equal(inbound.to, rootList.self.id);
  assert.deepEqual(ok(await f.message(piToken, { action: 'send', to: 'root', text: 'question', messageId: 'leaf-root-1' })), inbound);
  assert.deepEqual(await f.message(piToken, { action: 'send', to: 'root', text: 'changed', messageId: 'leaf-root-1' }), { ok: false, error: 'MESSAGE_ID_REUSE' });

  const reply = ok(await f.message(f.rootToken, { action: 'reply', replyTo: 'leaf-root-1', text: 'answer', messageId: 'root-reply-1' }));
  assert.equal(reply.status, 'accepted'); await f.runtime.dispatch();
  const waited = ok(await f.message(piToken, { action: 'wait', messageId: 'leaf-root-1', timeoutMs: 0 }));
  assert.equal(waited.replies.length, 1); assert.equal(waited.replies[0].from, rootList.self.id); assert.equal(waited.replies[0].status, 'queued');

  const sibling = ok(await f.message(piToken, { action: 'send', to: nativeLeaf, text: 'peer advice', messageId: 'sibling-1' }));
  assert.equal(sibling.status, 'accepted'); await f.runtime.dispatch();
  assert.match(f.live.get(nativeLeaf).messages.at(-1).text, /peer advice/);
  assert.equal(ok(await f.message(nativeToken, { action: 'status', messageId: 'sibling-1' })).status, 'queued');
  assert.deepEqual(await f.message(nativeToken, { action: 'reply', replyTo: 'leaf-root-1', text: 'spoof', messageId: 'spoof-1' }), { ok: false, error: 'MESSAGE_REPLY_FORBIDDEN' });
});

test('idle continuation is tracked, blocked/unavailable targets reject, and message credentials grant no runtime authority', async t => {
  const f = fixture(t); const sender = await f.launch('sender'); const target = await f.launch('target'); const senderToken = f.token(sender); const targetToken = f.token(target);
  f.settle(target); const idle = ok(await f.message(senderToken, { action: 'send', to: target, text: 'wake with context', messageId: 'idle-1' }));
  assert.equal(idle.status, 'accepted'); await f.runtime.dispatch();
  assert.equal(f.calls.filter(call => call.id === target).length, 2); assert.match(f.calls.findLast(call => call.id === target).reply, /wake with context/);
  assert.equal(ok(await f.message(senderToken, { action: 'status', messageId: 'idle-1' })).status, 'queued');

  const raced = await f.launch('raced-sender'); const racedToken = f.token(raced); const racedState = f.live.get(raced);
  racedState.onRead = () => f.pi('call', { toolCallId: 'cancel-during-read', tool: 'bg_stop', cwd: f.cwd, params: { runId: raced } });
  assert.deepEqual(await f.message(racedToken, { action: 'list' }), { ok: false, error: 'MESSAGE_SENDER_UNAVAILABLE' });
  await f.runtime.dispatch();
  const database = new DatabaseSync(join(f.stateRoot, 'runtime.sqlite'), { readOnly: true });
  const launchEffect = database.prepare("SELECT id FROM effects WHERE run=? AND node='worker' AND json_extract(data,'$.op')='node.launch'").get(sender).id; database.close();
  f.runtime.ingest(launchEffect, { id: 'sender-blocked', kind: 'blocked', attempt: 1, data: { requestId: 'need-decision', kind: 'decision', text: 'choose' } });
  const blocked = ok(await f.message(targetToken, { action: 'send', to: sender, text: 'not a typed answer', messageId: 'blocked-1' })); assert.equal(blocked.status, 'rejected');
  f.live.get(sender).readable = false;
  assert.deepEqual(await f.message(senderToken, { action: 'list' }), { ok: false, error: 'MESSAGE_SENDER_UNAVAILABLE' });

  const scope = { workstream: 'w', run: sender, node: 'worker', ownerEpoch: 1 };
  assert.deepEqual(f.runtime.execute(targetToken, { v: 1, op: 'progress', scope, payload: {} }, 'model'), { ok: false, error: 'UNAUTHORIZED' });
  assert.deepEqual(await f.message('0'.repeat(64), { action: 'list' }), { ok: false, error: 'UNAUTHORIZED' });
});

test('descriptor stays private, public execution exposes only its path, and uncertain delivery is never replayed', async t => {
  const f = fixture(t); const target = await f.launch('privacy'); const credential = f.token(target); const call = f.calls.find(value => value.id === target);
  const descriptor = call.intent.environment.AGENT_MESSAGE_DESCRIPTOR; const bytes = readFileSync(descriptor, 'utf8');
  assert.equal(statSync(descriptor).mode & 0o777, 0o600); assert(!JSON.stringify(call.intent).includes(credential)); assert(!call.intent.prompt.includes(credential));
  assert.equal(JSON.parse(bytes).token, credential); assert.equal(call.intent.prompt.startsWith('task privacy'), true); assert.match(call.intent.prompt, /Messages are context only/);

  f.live.get(target).delivery = 'unknown';
  const sent = ok(await f.message(f.rootToken, { action: 'send', to: target, text: 'uncertain', messageId: 'unknown-1' })); assert.equal(sent.status, 'accepted');
  await f.runtime.dispatch(); assert.equal(ok(await f.message(f.rootToken, { action: 'status', messageId: 'unknown-1' })).status, 'unknown');
  const count = f.live.get(target).messages.length;
  assert.equal(ok(await f.message(f.rootToken, { action: 'send', to: target, text: 'uncertain', messageId: 'unknown-1' })).status, 'unknown');
  await f.runtime.dispatch(); assert.equal(f.live.get(target).messages.length, count);
});

test('real service socket carries worker send, root delivery/reply, wait and status end to end', async t => {
  const f = fixture(t); const worker = await f.launch('socket-worker'); const call = f.calls.find(value => value.id === worker);
  const descriptorPath = call.intent.environment.AGENT_MESSAGE_DESCRIPTOR; const service = await startService(f.runtime, { keepAlive: false });
  try {
    const sent = await callAgentMessage({ action: 'send', to: 'parent', text: 'over socket' }, { descriptorPath });
    const deliveries = ok(await f.pi('wait', { runId: worker, timeoutMs: 0 }));
    assert(deliveries.some(delivery => delivery.kind === 'agent.message' && delivery.message.messageId === sent.messageId));
    const waiting = callAgentMessage({ action: 'wait', messageId: sent.messageId, timeoutMs: 1000 }, { descriptorPath });
    await new Promise(resolve => setImmediate(resolve));
    ok(await f.pi('message', { action: 'reply', replyTo: sent.messageId, text: 'root answer', messageId: 'socket-reply-1' }));
    await f.runtime.dispatch();
    const received = await waiting; assert.equal(received.replies[0].text, 'root answer');
    assert.equal((await callAgentMessage({ action: 'status', messageId: sent.messageId }, { descriptorPath })).replies.length, 1);
    const db = new DatabaseSync(join(f.stateRoot, 'runtime.sqlite'), { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM effects WHERE run=? AND json_extract(data,'$.payload.agentMessage.messageId')=?").get(worker, 'socket-reply-1').n, 1); db.close();
    f.settle(worker); await service.close();
  } catch (error) {
    try { f.settle(worker); await service.close(); } catch {}
    throw error;
  }
});

for (const destination of ['parent', 'sibling']) test(`sender cancellation during ${destination} liveness cannot admit a message`, async t => {
  const f = fixture(t); const sender = await f.launch('race-sender'); const sibling = await f.launch('race-sibling');
  f.live.get(destination === 'parent' ? sender : sibling).onRead = async () => {
    ok(await f.pi('call', { toolCallId: 'cancel-race', tool: 'bg_stop', cwd: f.cwd, params: { runId: sender } }));
  };
  assert.deepEqual(await f.message(f.token(sender), { action: 'send', to: destination === 'parent' ? 'parent' : sibling, text: 'must not arrive', messageId: 'cancel-race-message' }), { ok: false, error: 'MESSAGE_SENDER_UNAVAILABLE' });
  assert.deepEqual(await f.message(f.rootToken, { action: 'status', messageId: 'cancel-race-message' }), { ok: false, error: 'MESSAGE_NOT_FOUND' });
});

test('wait ignores unrelated delivery and rejects credentials revoked during liveness', async t => {
  const f = fixture(t); const worker = await f.launch('waiter'); const token = f.token(worker);
  const question = ok(await f.message(token, { action: 'send', to: 'parent', text: 'question', messageId: 'wait-question' }));
  let returned = false;
  const waiting = f.message(token, { action: 'wait', messageId: question.messageId, timeoutMs: 10000 }).then(value => { returned = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  ok(await f.message(token, { action: 'send', to: 'parent', text: 'unrelated', messageId: 'unrelated-message' }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false);
  ok(await f.message(f.rootToken, { action: 'reply', replyTo: question.messageId, text: 'answer', messageId: 'wait-answer' }));
  assert.equal(ok(await waiting).replies[0].text, 'answer');
  await f.runtime.dispatch();
  f.live.get(worker).onRead = () => f.runtime.revokePrincipal('advisor');
  assert.deepEqual(await f.message(f.rootToken, { action: 'send', to: worker, text: 'revoked', messageId: 'revoked-message' }), { ok: false, error: 'UNAUTHORIZED' });
});

test('foreign, retired, recovery and auto-closed senders cannot read or replay messages', async t => {
  const f = fixture(t), foreign = fixture(t); const worker = await f.launch('eligibility'); const token = f.token(worker);
  const request = { action: 'send', to: 'parent', text: 'before retirement', messageId: 'eligibility-message' };
  ok(await f.message(token, request));
  assert.deepEqual(await foreign.message(token, { action: 'list' }), { ok: false, error: 'UNAUTHORIZED' });
  const db = new DatabaseSync(join(f.stateRoot, 'runtime.sqlite'));
  const original = JSON.parse(db.prepare('SELECT data FROM runs WHERE id=?').get(worker).data);
  try {
    for (const patch of [{ teamMemberRetired: true }, { runtimeState: 'recovery-required' }, { processExited: { code: 0 } }]) {
      const run = structuredClone(original); Object.assign(run.nodes.worker, patch);
      db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), worker);
      for (const args of [{ action: 'list' }, { action: 'status', messageId: request.messageId }, request]) assert.deepEqual(await f.message(token, args), { ok: false, error: 'MESSAGE_SENDER_UNAVAILABLE' });
    }
  } finally { db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(original), worker); db.close(); }
  const closing = await f.launch('auto-close', { keepAlive: false }); const closingToken = f.token(closing); f.settle(closing);
  assert.deepEqual(await f.message(closingToken, { action: 'list' }), { ok: false, error: 'MESSAGE_SENDER_UNAVAILABLE' });
});

for (const idle of [false, true]) for (const changed of [false, true]) test(`concurrent ${changed ? 'changed' : 'identical'} messages admit one ${idle ? 'idle continuation' : 'busy message'}`, async t => {
  const f = fixture(t); const worker = await f.launch('concurrent-worker');
  if (idle) f.settle(worker);
  const args = { action: 'send', to: worker, text: 'once', messageId: 'concurrent-message' };
  const results = await Promise.all([f.message(f.rootToken, args), f.message(f.rootToken, { ...args, text: changed ? 'different' : args.text })]);
  if (changed) {
    assert.equal(results.filter(value => value.ok).length, 1);
    assert.equal(results.find(value => !value.ok).error, 'MESSAGE_ID_REUSE');
  } else assert.deepEqual(ok(results[0]), ok(results[1]));
  await f.runtime.dispatch();
  if (idle) assert.equal(f.calls.length, 2);
  else assert.equal(f.live.get(worker).messages.length, 1);
});
