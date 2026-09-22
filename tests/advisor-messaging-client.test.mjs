import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentMessageTool, callAgentMessage, messageError, parseAgentMessage, routeAgentMessage } from '../scripts/advisor-runtime/messaging-client.mjs';
import { createAgentMessageFacade } from '../scripts/advisor-runtime/messaging-cli.mjs';
import { configureAgentMessenger } from '../scripts/advisor-runtime/messaging-launch.mjs';
import { createMcpHandler } from '../scripts/advisor-runtime/mcp.mjs';
import { createPiDetachClient } from '../scripts/advisor-runtime/pi-detach-client.mjs';
import { RuntimeError } from '../scripts/advisor-runtime/security.mjs';

const cli = fileURLToPath(new URL('../scripts/advisor-runtime/messaging-cli.mjs', import.meta.url));
const send = { action: 'send', to: 'parent', text: 'Question?', messageId: 'message-one' };
const receipt = args => ({ messageId: args.messageId, from: 'worker', fromName: 'worker', to: 'advisor', text: args.text, replyTo: null, status: 'accepted', read: null, done: null, replies: [] });
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

function command(args, env, input = '', entry = cli) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}

test('one strict parser, stable facade IDs, and no semantic text ceiling', async () => {
  assert.deepEqual(parseAgentMessage(send), send);
  assert.deepEqual(parseAgentMessage({ action: 'send', to: 'parent', text: 'hi' }, { messageId: 'fixed' }), { action: 'send', to: 'parent', text: 'hi', messageId: 'fixed' });
  assert.deepEqual(parseAgentMessage({ action: 'wait', messageId: 'fixed' }), { action: 'wait', messageId: 'fixed', timeoutMs: 10000 });
  assert.match(parseAgentMessage({ action: 'reply', replyTo: 'received', text: 'answer' }).messageId, /^msg-/);
  assert.equal(parseAgentMessage({ ...send, text: '🚀'.repeat(100000) }).text.length, 200000);
  for (const args of [null, {}, { action: 'list', to: 'parent' }, { ...send, from: 'spoof' }, { ...send, messageId: null }, { ...send, text: ' ' }, { action: 'reply', to: 'parent', replyTo: 'x', text: 'x' }, { action: 'status', messageId: 'x', timeoutMs: 0 }, { action: 'wait', messageId: 'x', timeoutMs: null }, { action: 'wait', messageId: 'x', timeoutMs: 10001 }]) assert.throws(() => parseAgentMessage(args));
  const facade = createAgentMessageFacade(async () => { throw new RuntimeError('MESSAGE_TRANSPORT_UNCERTAIN'); });
  const result = await facade.call('agent_message', { action: 'send', to: 'parent', text: 'hi' });
  assert.equal(result.error, 'MESSAGE_TRANSPORT_UNCERTAIN'); assert.equal(result.outcomeKnown, false); assert.match(result.messageId, /^msg-/);
  assert.deepEqual(messageError(new Error('MESSAGE_TARGET_NOT_FOUND')), { ok: false, error: 'MESSAGE_TARGET_NOT_FOUND' });
  assert.deepEqual(messageError(new Error('private filesystem details')), { ok: false, error: 'MESSAGE_UNAVAILABLE' });
  assert.deepEqual(messageError(Object.assign(new Error('filesystem details'), { code: 'ENOENT' })), { ok: false, error: 'MESSAGE_UNAVAILABLE' });
});

test('CLI, MCP, and direct client use the same scoped socket envelope and preserve errors', async t => {
  const base = realpathSync(mkdtempSync('/tmp/msg-cli-')); chmodSync(base, 0o700);
  const socketPath = join(base, 'runtime.sock'), descriptorPath = join(base, 'credential.json');
  const requests = []; let drop = false, responseOverride;
  const server = createServer(socket => {
    let text = ''; socket.setEncoding('utf8');
    socket.on('data', chunk => {
      text += chunk; if (!text.endsWith('\n')) return;
      const request = JSON.parse(text); requests.push(request);
      if (drop) { socket.end(); return; }
      socket.end(JSON.stringify(responseOverride ?? { ok: true, value: receipt(request.command.payload) }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve)); chmodSync(socketPath, 0o600);
  writeFileSync(descriptorPath, JSON.stringify({ v: 1, socketPath, token: 'a'.repeat(64) }), { mode: 0o600 });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(base, { recursive: true, force: true }); });
  const expected = receipt(send);
  assert.deepEqual(await callAgentMessage(send, { descriptorPath }), expected);
  const result = await command([JSON.stringify(send)], { AGENT_MESSAGE_DESCRIPTOR: descriptorPath });
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { ok: true, value: expected });
  const toolCall = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_message', arguments: send } };
  const mcp = await command(['mcp'], { AGENT_MESSAGE_DESCRIPTOR: descriptorPath }, [initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, toolCall].map(JSON.stringify).join('\n') + '\n');
  assert.equal(mcp.code, 0, mcp.stderr);
  const responses = mcp.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(responses[1].result.tools, [agentMessageTool]);
  assert.deepEqual(JSON.parse(responses[2].result.content[0].text), { ok: true, value: expected });
  assert.equal(requests.length, 3); assert.ok(requests.every(request => request.audience === 'model' && request.command.op === 'agent.message' && request.token === 'a'.repeat(64)));
  assert.deepEqual(requests[0].command, { v: 1, op: 'agent.message', payload: send });
  const bin = join(base, 'agent-message'); symlinkSync(cli, bin);
  const linked = await command([JSON.stringify(send)], { AGENT_MESSAGE_DESCRIPTOR: descriptorPath }, '', bin);
  assert.equal(linked.code, 0, linked.stderr); assert.deepEqual(JSON.parse(linked.stdout), { ok: true, value: expected });
  const piClient = createPiDetachClient(descriptorPath);
  assert.deepEqual(await piClient.request('session', 'message', send), expected);
  assert.deepEqual(requests.at(-1).command, { v: 1, op: 'pi.detach', sessionId: 'session', action: 'message', payload: send });
  const reply = { ...expected, messageId: 'reply-one', from: expected.to, fromName: 'advisor', to: expected.from, replyTo: expected.messageId };
  responseOverride = { ok: true, value: { ...expected, replies: [reply] } };
  assert.deepEqual(await callAgentMessage(send, { descriptorPath }), responseOverride.value);
  assert.deepEqual(await piClient.request('session', 'message', send), responseOverride.value);
  const malformedReplies = [null, { token: 'not-an-attributed-reply' }, { ...reply, from: 'foreign' }, { ...reply, replyTo: null }, { ...reply, read: true }];
  for (const malformed of [{}, { ok: true }, { ok: 'yes', value: expected }, { ok: false, error: ['UNAUTHORIZED'] }, { ok: false, error: {} }, { ok: true, value: { ...expected, messageId: 'wrong' } },
    ...malformedReplies.map(reply => ({ ok: true, value: { ...expected, replies: [reply] } }))]) {
    responseOverride = malformed;
    await assert.rejects(callAgentMessage(send, { descriptorPath }), error => error.code === 'MESSAGE_TRANSPORT_UNCERTAIN' && error.messageId === send.messageId);
    await assert.rejects(piClient.request('session', 'message', send), error => error.code === 'MESSAGE_TRANSPORT_UNCERTAIN' && error.messageId === send.messageId);
    const status = { action: 'status', messageId: send.messageId };
    await assert.rejects(callAgentMessage(status, { descriptorPath }), /MESSAGE_UNAVAILABLE/);
    await assert.rejects(piClient.request('session', 'message', status), /MESSAGE_UNAVAILABLE/);
  }
  responseOverride = undefined;
  const beforeDrop = requests.length;
  drop = true;
  const uncertain = await command([JSON.stringify(send)], { AGENT_MESSAGE_DESCRIPTOR: descriptorPath });
  assert.equal(uncertain.code, 1); assert.deepEqual(JSON.parse(uncertain.stdout), { ok: false, error: 'MESSAGE_TRANSPORT_UNCERTAIN', messageId: send.messageId, outcomeKnown: false });
  assert.equal(requests.length, beforeDrop + 1, 'uncertain submission must not retry');
  const missing = await command(['{"action":"list"}'], { AGENT_MESSAGE_DESCRIPTOR: join(base, 'missing.json') });
  assert.equal(missing.code, 1); assert.deepEqual(JSON.parse(missing.stdout), { ok: false, error: 'MESSAGE_UNAVAILABLE' });
});

test('MCP facade has only one tool and returns validation failures as tool errors', async () => {
  const handle = createMcpHandler(null, createAgentMessageFacade(async args => args));
  await handle(initialize);
  const result = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_message', arguments: { action: 'list', token: 'spoof' } } });
  assert.equal(result.result.isError, true); assert.equal(JSON.parse(result.result.content[0].text).error, 'EXTRA_FIELD');
  const unknown = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'advisor_node_launch', arguments: {} } });
  assert.equal(JSON.parse(unknown.result.content[0].text).error, 'UNKNOWN_TOOL');
});

test('child advisors merge only parent neighborhood and own children; ambiguous names and references fail closed', async () => {
  const self = { id: 'child-advisor', name: 'planner' }, calls = [];
  const channel = (parent, peers, known) => ({ parent, async request(args) {
    calls.push({ parent, args });
    if (args.action === 'list') return { self, parent: parent ? 'root' : null, peers };
    if (args.action === 'status' && !known.includes(args.messageId)) throw new RuntimeError('MESSAGE_NOT_FOUND');
    return { ...args, channel: parent ? 'parent' : 'local' };
  } });
  const channels = [channel(false, [{ id: 'own-worker', name: 'worker' }], ['own-message']), channel(true, [{ id: 'root', name: 'advisor' }, { id: 'sibling', name: 'worker' }], ['parent-message'])];
  const roster = await routeAgentMessage({ action: 'list' }, channels);
  assert.equal(roster.parent, 'root'); assert.deepEqual(roster.peers.map(peer => peer.id), ['own-worker', 'root', 'sibling']);
  assert.equal((await routeAgentMessage(send, channels)).channel, 'parent');
  assert.equal((await routeAgentMessage({ ...send, to: 'own-worker', messageId: 'message-two' }, channels)).channel, 'local');
  assert.equal((await routeAgentMessage({ action: 'reply', replyTo: 'parent-message', text: 'answer' }, channels)).channel, 'parent');
  await assert.rejects(routeAgentMessage({ ...send, to: 'worker' }, channels), /MESSAGE_TARGET_AMBIGUOUS/);
  await assert.rejects(routeAgentMessage({ ...send, to: 'foreign' }, channels), /MESSAGE_TARGET_NOT_FOUND/);
  await assert.rejects(routeAgentMessage({ action: 'status', messageId: 'absent' }, channels), /MESSAGE_NOT_FOUND/);
  await assert.rejects(routeAgentMessage({ action: 'status', messageId: 'own-message' }, [channels[0], channels[0]]), /MESSAGE_AMBIGUOUS/);
  assert.equal(calls.filter(call => call.args.action === 'reply').length, 1);
});

test('launch binding preserves commands and uses per-process descriptor paths, not secrets', () => {
  const execution = { command: 'codex -m model', prompt: 'task', environment: { EXISTING: 'yes' } };
  const configured = configureAgentMessenger(execution, '/private/credential.json');
  assert.equal(configured.command, execution.command); assert.equal(execution.prompt, 'task');
  assert.equal(configured.environment.EXISTING, 'yes'); assert.equal(configured.environment.AGENT_MESSAGE_DESCRIPTOR, '/private/credential.json');
  assert.equal(configured.environment.AGENT_MESSAGE_CLI, cli); assert.equal(configured.environment.AGENT_MESSAGE_NODE, process.execPath);
  assert.match(configured.prompt, /agent_message/); assert.match(configured.prompt, /do not change assignments/);
});

test('changed-target and reply key reuse cannot fork a child advisor message across channels', async () => {
  const self = { id: 'child-advisor', name: 'advisor' };
  const makeChannel = (parent, target) => {
    const messages = new Map([[`inbound-${target}`, { messageId: `inbound-${target}`, from: target, to: self.id }]]);
    return { parent, async request(args) {
      if (args.action === 'list') return { self, parent: parent ? target : null, peers: [{ id: target, name: target }] };
      if (args.action === 'status') {
        if (!messages.has(args.messageId)) throw new RuntimeError('MESSAGE_NOT_FOUND');
        return messages.get(args.messageId);
      }
      const value = { ...args, from: self.id, to: args.to ?? messages.get(args.replyTo).from };
      if (messages.has(args.messageId)) assert.deepEqual(messages.get(args.messageId), value);
      messages.set(args.messageId, value); return value;
    } };
  };
  const channels = [makeChannel(false, 'own-worker'), makeChannel(true, 'root')];
  const first = await routeAgentMessage(send, channels);
  assert.deepEqual(await routeAgentMessage(send, channels), first);
  await assert.rejects(routeAgentMessage({ ...send, to: 'own-worker' }, channels), /MESSAGE_ID_REUSE/);
  await assert.rejects(routeAgentMessage({ action: 'reply', replyTo: 'inbound-own-worker', messageId: send.messageId, text: 'different' }, channels), /MESSAGE_ID_REUSE/);
  assert.deepEqual(await routeAgentMessage({ action: 'status', messageId: send.messageId }, channels), first);
  const outcomes = await Promise.allSettled([
    routeAgentMessage({ ...send, messageId: 'concurrent' }, channels),
    routeAgentMessage({ ...send, messageId: 'concurrent', to: 'own-worker' }, channels),
  ]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(value => value.status === 'rejected').reason.message, /MESSAGE_ID_REUSE/);
});
