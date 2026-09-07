import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { AdvisorRuntime } from '../scripts/advisor-runtime/runtime.mjs';
import { OPERATIONS, WORKER_OPERATIONS } from '../scripts/advisor-runtime/contract.mjs';
import { startService, callSocket, writeCredential } from '../scripts/advisor-runtime/service.mjs';
import { createMcpHandler } from '../scripts/advisor-runtime/mcp.mjs';
import { createNativeAdapters } from '../scripts/advisor-runtime/adapters/index.mjs';
import { mockClaude, mockClaudeProcess } from './native-mock-claude.mjs';
import { loadSchema, validateTrace, parseTrace } from '../scripts/advisor-trace.mjs';

const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value ?? result.receipt; };
const scope = (node = 'root', run = 'run') => ({ workstream: 'work', run, node, ownerEpoch: 1 });
const read = (op = 'progress', node = 'root', payload = {}) => ({ v: 1, op, scope: scope(node), payload });
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
async function setup(t, provider) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'an-'))); const stateRoot = join(base, 'state'); const cwd = join(base, 'work'); const home = join(base, 'codex-home');
  mkdirSync(cwd, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  const grants = ['root', 'maker', 'second'].map(node => ({ workstream: 'work', run: 'run', node }));
  const registration = { principal: { id: 'advisor', kind: 'advisor', scopes: grants, operations: OPERATIONS.filter(op => !op.startsWith('root.')) }, credentialPath: join(stateRoot, 'advisor.json') };
  const calls = []; const children = [];
  const seams = { codex: { probe: () => '0.153.4', env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, spawnProcess(_command, args, options) {
    calls.push({ args, options }); const child = spawn(process.execPath, [new URL('./native-mock-codex.mjs', import.meta.url).pathname, ...args], options); children.push(child); return child;
  } }, claude: { env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home }, load: mockClaude(calls), spawnProcess: mockClaudeProcess } };
  const adapters = createNativeAdapters([registration], seams);
  const runtime = new AdvisorRuntime({ stateRoot, allowedRoots: [cwd], adapters });
  const operator = runtime.registerPrincipal({ id: 'operator', kind: 'operator', scopes: grants, operations: OPERATIONS });
  const advisor = runtime.registerPrincipal(registration.principal);
  const worker = runtime.registerPrincipal({ id: 'worker', kind: 'worker', scopes: [grants[1]], operations: WORKER_OPERATIONS });
  const service = await startService(runtime, { keepAlive: false }); const credential = { socketPath: service.socketPath, token: operator };
  writeCredential(registration.credentialPath, { socketPath: service.socketPath, token: advisor }, runtime);
  const state = node => ok(runtime.execute(operator, read('progress', node)));
  const send = async (op, payload = {}, node = 'root', commandId = randomUUID(), retries = 0) => {
    const envelope = { ...read(op, node, payload), commandId, expectedRevision: op === 'workstream.create' ? 0 : state(node).revision };
    const result = await callSocket(credential, envelope); await runtime.dispatch();
    if (result.error === 'STALE_REVISION') { assert.ok(retries < 8, 'fixture CAS bound'); return send(op, payload, node, randomUUID(), retries + 1); }
    return { result, envelope };
  };
  const awaitState = async (condition, node = 'root') => {
    for (let i = 0; i < 300; i++) {
      const snapshot = state(node); if (condition(snapshot)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`state timeout: ${JSON.stringify(state(node))}`);
  };
  const packet = task => ({ role: 'builder', task, acceptance: ['deterministic'], riskTier: 'high', cwd, adapter: provider, model: 'fixture', thinking: 'high' });
  const launch = async task => { ok((await send('packet.admit', { node: 'maker', packet: packet(task) })).result); return send('node.launch', { node: 'maker' }); };
  const ack = async () => { for (const d of ok(await callSocket(credential, read('wait', 'root', { timeoutMs: 0, limit: 128 })))) ok((await send('delivery.ack', { deliveryId: d.id })).result); };
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); try { await ack(); await service.close(); } catch {} rmSync(base, { recursive: true, force: true }); });
  ok((await send('workstream.create', { cwd, host: provider })).result);
  return { base, stateRoot, cwd, runtime, service, credential, operator, advisor, worker, calls, state, send, awaitState, packet, launch, ack };
}

for (const provider of ['codex', 'claude-code']) {
  test(`${provider}: native root fixture operates real scoped MCP to launch exactly one concrete maker and synthesize durable result`, async t => {
    const h = await setup(t, provider);
    ok((await h.send('root.create', { adapter: provider, model: 'fixture', thinking: 'high', text: 'fleet-launch' })).result);
    await h.awaitState(s => s.root.state === 'idle');
    assert.equal(h.state('maker').status, 'done'); assert.equal(h.state().graph, null);
    assert.equal(h.calls.filter(c => c.args || c.options?.sessionId).length, 2);
    const deliveries = ok(await callSocket(h.credential, read('wait', 'root', { timeoutMs: 0, limit: 128 })));
    assert.ok(deliveries.some(d => d.kind === 'root.completed' && d.text.includes('Root synthesized durable maker evidence')));
    const trace = parseTrace(readFileSync(h.runtime.exportTrace('run').path, 'utf8')); assert.equal(trace.filter(e => e.type === 'node.launched').length, 1);
    if (process.env.NATIVE_EVIDENCE_DIR) { const output = join(process.env.NATIVE_EVIDENCE_DIR, `fleet-${provider}`); mkdirSync(output, { recursive: true }); writeFileSync(join(output, 'snapshot-deliveries.json'), JSON.stringify({ snapshot: h.state(), deliveries, trace }, null, 2)); }
    ok((await h.send('root.stop')).result); await h.awaitState(s => s.root.processExited !== undefined); await h.awaitState(s => s.processExited !== undefined, 'maker');
  });
  test(`${provider}: concrete adapter + SQLite + service direct launch; durable blocked/reply/delivery, least privilege and canonical result`, async t => {
    const h = await setup(t, provider);
    const launched = await h.launch('question'); ok(launched.result);
    assert.equal(h.state().graph, null); assert.equal(h.state().wave, 0);
    await h.awaitState(s => s.snapshot.state === 'blocked', 'maker');
    const blocked = h.state('maker'); assert.ok(blocked.handle); assert.match(readFileSync(join(h.stateRoot, 'runs/run/maker/result.md'), 'utf8'), /BLOCKED/);
    assert.equal(ok(await callSocket(h.credential, launched.envelope)).commandId, launched.envelope.commandId);
    assert.equal(h.calls.filter(c => c.args || c.options?.sessionId).length, 1);
    assert.equal((await h.send('node.reply', { attempt: 1, requestId: 'wrong', text: 'A' }, 'maker')).result.error, 'REQUEST_MISMATCH');
    const answer = provider === 'codex' ? '{"choice":["A"]}' : '{"A or B?":"A"}';
    const replied = await h.send('node.reply', { attempt: 1, requestId: blocked.snapshot.request.id, text: answer }, 'maker'); ok(replied.result);
    await h.awaitState(s => s.snapshot.state === 'terminal' && s.processExited !== undefined, 'maker');
    assert.equal(h.state('maker').status, 'done'); assert.equal(h.state('maker').verified, false);
    assert.equal(h.state('maker').snapshot.attempt, 2);
    assert.equal(ok(await callSocket(h.credential, replied.envelope)).commandId, replied.envelope.commandId);
    const deliveries = ok(await callSocket(h.credential, read('wait', 'root', { timeoutMs: 0, limit: 128 })));
    assert.deepEqual(ok(await callSocket(h.credential, read('wait', 'root', { timeoutMs: 0, limit: 128 }))), deliveries);
    assert.ok(deliveries.some(d => d.status === 'done')); await h.ack();
    assert.deepEqual(ok(await callSocket(h.credential, read('wait', 'root', { timeoutMs: 0, limit: 128 }))), []);
    const mcp = createMcpHandler({ socketPath: h.service.socketPath, token: h.worker }); await mcp(init);
    const tools = (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
    assert.equal(tools.length, WORKER_OPERATIONS.length); assert.ok(!tools.some(t => t.name.includes('launch') || t.name.includes('root')));
    assert.equal((await callSocket({ socketPath: h.service.socketPath, token: h.worker }, launched.envelope, 'model')).error, 'SCOPE_FORBIDDEN');
    const trace = parseTrace(readFileSync(h.runtime.exportTrace('run').path, 'utf8')); assert.equal(validateTrace(trace, await loadSchema()).ok, true);
    assert.equal(trace.filter(e => e.type === 'node.launched').length, 1); assert.equal(trace.some(e => e.type === 'wave.started'), false);
    const resultEvents = trace.map(e => e.type); assert.ok(resultEvents.indexOf('node.result.written') < resultEvents.indexOf('node.result.validated'));
    const result = readFileSync(join(h.stateRoot, 'runs/run/maker/result.md'));
    h.runtime.verifyNode({ scope: scope('maker'), expectedRevision: h.state('maker').revision, resultSha256: createHash('sha256').update(result).digest('hex'), evidenceSha256: 'a'.repeat(64) }); assert.equal(h.state('maker').verified, true);
    const identity = JSON.parse(readFileSync(join(h.stateRoot, 'runs/run/maker/native.json'), 'utf8'));
    assert.equal(identity.requested.model, 'fixture'); assert.equal(identity.observed.thinking, null);
    assert.equal((await h.send('node.resume', {}, 'maker')).result.error, 'RESUME_UNSUPPORTED');
    if (process.env.NATIVE_EVIDENCE_DIR) {
      const output = join(process.env.NATIVE_EVIDENCE_DIR, provider); mkdirSync(output, { recursive: true });
      cpSync(join(h.stateRoot, 'runs'), join(output, 'runs'), { recursive: true }); cpSync(join(h.stateRoot, 'traces'), join(output, 'traces'), { recursive: true });
      writeFileSync(join(output, 'snapshot.json'), JSON.stringify(h.state(), null, 2));
      writeFileSync(join(output, 'receipts.json'), JSON.stringify({ launch: launched, reply: replied, deliveries }, null, 2));
    }
  });
  test(`${provider}: root conversation fleet config, second message, cancel acceptance versus final/exit, stop and reconnect`, async t => {
    const h = await setup(t, provider);
    ok((await h.send('root.create', { adapter: provider, model: 'fixture', thinking: 'high', text: 'initial' })).result);
    await h.awaitState(s => s.root.state === 'idle'); assert.equal(h.state().root.processExited, undefined);
    assert.equal((await h.send('root.create', { adapter: provider, model: 'fixture', thinking: 'high', text: 'duplicate' })).result.error, 'ROOT_EXISTS');
    ok((await h.send('root.message', { text: 'question' })).result); await h.awaitState(s => s.root.state === 'blocked');
    const requestId = h.state().root.request.id;
    assert.equal((await h.send('root.reply', { requestId: 'stale', text: 'A' })).result.error, 'REQUEST_MISMATCH');
    ok((await h.send('root.reply', { requestId, text: provider === 'codex' ? '{"choice":["A"]}' : '{"A or B?":"A"}' })).result);
    await h.awaitState(s => s.root.state === 'idle');
    ok((await h.send('root.message', { text: 'hold-turn' })).result);
    await h.awaitState(s => s.root.state === 'running');
    ok((await h.send('root.cancel', { reason: 'test cancellation' })).result);
    await h.awaitState(s => s.root.state === 'idle'); assert.equal(h.state().root.processExited, undefined);
    assert.equal((await h.send('root.resume')).result.error, 'RESUME_UNSUPPORTED');
    const reconnected = ok(await callSocket(h.credential, read('workstream.open'))); assert.equal(reconnected.root.attempt, 3);
    ok((await h.send('root.stop')).result); await h.awaitState(s => s.root.processExited !== undefined);
    if (provider === 'claude-code') {
      const options = h.calls[0].options; assert.deepEqual(options.settingSources, []); assert.equal(options.allowedTools, undefined); assert.equal(options.permissionMode, 'default'); assert.ok(options.disallowedTools.includes('Agent')); assert.ok(options.mcpServers.advisor_runtime.env.ADVISOR_RUNTIME_DESCRIPTOR_PATH); assert.equal(options.env.ADVISOR_RUNTIME_DESCRIPTOR_PATH, undefined);
    }
  });
  test(`${provider}: worker cancel receipt replay waits for terminal and observed process exit`, async t => {
    const h = await setup(t, provider); ok((await h.launch('hold-turn')).result);
    const cancelled = await h.send('node.cancel', { attempt: 1, reason: 'bounded fixture cancellation' }, 'maker'); ok(cancelled.result);
    ok(await callSocket(h.credential, cancelled.envelope));
    await h.awaitState(s => s.status === 'cancelled' && s.processExited !== undefined, 'maker');
    const deliveries = ok(await callSocket(h.credential, read('wait', 'root', { timeoutMs: 0, limit: 128 })));
    assert.equal(deliveries.filter(d => d.kind === 'settled' && d.status === 'cancelled').length, 1);
    assert.equal(deliveries.filter(d => d.kind === 'process-exited').length, 1);
  });
  test(`${provider}: explicit deny permission and no grant defaults`, async t => {
    const h = await setup(t, provider); ok((await h.launch('permission')).result);
    await h.awaitState(s => s.snapshot.state === 'blocked', 'maker');
    const blocked = h.state('maker'); ok((await h.send('node.reply', { attempt: 1, requestId: blocked.snapshot.request.id, text: 'deny' }, 'maker')).result);
    await h.awaitState(s => s.status === 'done', 'maker');
    if (provider === 'claude-code') assert.equal(h.calls.find(c => c.response).response.behavior, 'deny');
  });
  for (const scenario of ['unknown-event', 'nested-agent', 'foreign-thread']) test(`${provider}: ${scenario} is durable recovery-required, never successful`, async t => {
    const h = await setup(t, provider); await h.launch(scenario);
    await h.awaitState(s => s.runtimeState === 'recovery-required', 'maker');
    assert.notEqual(h.state('maker').status, 'done');
    const diagnostics = readFileSync(join(h.stateRoot, 'runs/run/maker/diagnostic.json'), 'utf8'); assert.match(diagnostics, /recoveryRequired/); assert.ok(!diagnostics.includes(h.operator));
  });
}
