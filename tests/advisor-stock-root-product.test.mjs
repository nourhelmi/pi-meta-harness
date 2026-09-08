import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { callSocket, readCredential } from '../scripts/advisor-runtime/service.mjs';

const detach = process.env.PI_DETACH_TEST_PACKAGE;
const executable = resolve('scripts/advisor-runtime/stock-root.mjs');
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'native-root-stub', version: '1' } };
const success = response => { assert.equal(response.ok, true, JSON.stringify(response)); return response.value; };
function fixture(t, host) {
  const root = realpathSync(mkdtempSync('/tmp/stk-'));
  for (const dir of ['work', 'config', 'bin']) mkdirSync(join(root, dir), { mode: 0o700 });
  const kind = host === 'codex' ? 'codex' : 'claude';
  // The test process stands in for the native root; real OS parent/start identity is checked by each MCP child.
  const data = { agent: { agent: kind, pane_id: 'w1:p1', terminal_id: `terminal-${host}`, foreground_cwd: join(root, 'work'), agent_session: { source: `herdr:${kind}`, agent: kind, kind: 'id', value: `native-${host}` } }, info: { pane_id: 'w1:p1', shell_pid: 10, foreground_process_group_id: 20, foreground_processes: [{ pid: process.pid, name: kind, argv0: kind, cwd: join(root, 'work') }] } };
  const saveRoot = () => writeFileSync(join(root, 'root.json'), JSON.stringify(data)); saveRoot();
  const behavior = value => writeFileSync(join(root, 'behavior.json'), JSON.stringify(value)); behavior({ status: 'working' });
  writeFileSync(join(root, 'config/pi-detach-runtime.json'), JSON.stringify({ v: 1, backend: 'runtime', node: process.execPath, host: resolve('scripts/advisor-runtime/pi-detach-host.mjs'), stateBase: join(root, 'state') }));
  writeFileSync(join(root, 'bin/herdr'), `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/bridge/fake-stock-herdr.mjs')}' "$@"\n`, { mode: 0o700 });
  const env = { PATH: `${join(root, 'bin')}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(root, 'config'), HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', STOCK_FAKE_ROOT: root };
  const clients = [];
  const calls = () => existsSync(join(root, 'calls.jsonl')) ? readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const effects = () => calls().filter(a => ['split', 'start', 'prompt', 'send-keys', 'close'].includes(a[1]));
  const state = () => join(root, 'state', readdirSync(join(root, 'state'))[0]);
  const rows = table => { const db = new DatabaseSync(join(state(), 'runtime.sqlite'), { readOnly: true }); try { return db.prepare(`SELECT * FROM ${table}`).all(); } finally { db.close(); } };
  const mcp = async (patch = {}) => {
    const child = spawn(process.execPath, [executable, 'mcp', host, detach], { cwd: join(root, 'work'), env: { ...env, ...patch }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', stderr = '', next = 0;
    const pending = new Map(); const received = [];
    child.stderr.on('data', b => { stderr += b; });
    child.stdout.on('data', b => {
      buffer += b;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); received.push(message);
        const p = pending.get(message.id); if (p) { pending.delete(message.id); clearTimeout(p.timer); p.resolve(message); }
      }
    });
    child.on('exit', code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP exited ${code}: ${stderr}`)); } pending.clear(); });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method} ${stderr}`)); }, 25000);
      pending.set(id, { resolve, reject, timer });
      const wire = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      child.stdin.write(wire.slice(0, 9)); child.stdin.write(wire.slice(9));
    });
    const client = { child, received, rpc, async tool(name, args = {}) {
      const response = await rpc('tools/call', { name: `advisor_worker_${name}`, arguments: args });
      assert.ok(response.result, JSON.stringify(response)); return JSON.parse(response.result.content[0].text);
    }, async close() { if (child.exitCode !== null || child.signalCode) return; const exit = once(child, 'exit'); child.stdin.end(); await exit; assert.equal(child.exitCode, 0, stderr); } };
    clients.push(client);
    const hello = await rpc('initialize', init); assert.equal(hello.result.serverInfo.name, 'meta-harness');
    assert.equal((await rpc('tools/list', {})).result.tools.length, 10);
    return client;
  };
  t.after(async () => {
    for (const client of clients) if (client.child.exitCode === null && !client.child.signalCode) client.child.kill('SIGTERM');
    // Failure cleanup only: this test owns every service PID under its fresh temporary state.
    if (existsSync(join(root, 'state'))) for (const key of readdirSync(join(root, 'state'))) {
      const owner = join(root, 'state', key, 'service.lock/owner.json');
      if (existsSync(owner)) { try { process.kill(JSON.parse(readFileSync(owner, 'utf8')).pid, 'SIGKILL'); } catch {} }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, data, saveRoot, behavior, env, mcp, calls, effects, state, rows };
}
async function stateIs(client, runId, target) {
  for (let i = 0; i < 40; i++) {
    const state = success(await client.tool('status', { runId }));
    if (state.state === target) return state;
    assert.notEqual(state.runtimeState, 'recovery-required', JSON.stringify(state));
    await client.tool('wait', { runId, timeoutMs: 100 });
  }
  assert.fail(`state ${target} was not observed`);
}
async function ackAll(client, runId) {
  const deliveries = success(await client.tool('wait', { runId, timeoutMs: 0 }));
  for (const delivery of deliveries) success(await client.tool('ack', { runId, deliveryId: delivery.id }));
  return deliveries;
}

test('stock MCP over actual paired host/core/SQLite/Herdr execution port, both native roots, no models', { skip: !detach, timeout: 120000 }, async t => {
  const all = [];
  for (const host of ['codex', 'claude-code']) {
    const f = fixture(t, host); let client = await f.mcp();
    assert.equal(existsSync(join(f.root, 'state')), false); assert.equal(f.calls().length, 0, 'initialize/list require no native session and never query Herdr');
    const session = f.data.agent.agent_session; delete f.data.agent.agent_session; f.saveRoot();
    assert.equal((await client.tool('launch', { commandId: 'missing-session', prompt: 'no effects' })).error, 'STOCK_SESSION_REQUIRED');
    assert.equal(existsSync(join(f.root, 'state')), false);
    f.data.agent.agent_session = session; f.saveRoot();
    assert.equal((await client.tool('list')).error, 'STOCK_NOT_STARTED');
    assert.equal((await client.tool('runtime_close')).error, 'STOCK_NOT_STARTED');
    const worker = await f.mcp({ ADVISOR_RUNTIME_CANONICAL_OWNER: '1' });
    const callsBeforeWorker = f.calls().length;
    assert.equal((await worker.tool('launch', { commandId: 'worker', prompt: 'no authority' })).error, 'STOCK_WORKER_FORBIDDEN');
    assert.equal(f.calls().length, callsBeforeWorker); await worker.close();
    const args = { commandId: 'one', prompt: 'Bounded fixture task', harness: 'native', model: 'openai-codex/example', keepAlive: true };
    const admitted = success(await client.tool('launch', args)); const runId = admitted.runId;
    assert.deepEqual(Object.keys(admitted), ['runId', 'status']); assert.match(runId, /^pib-/);
    await stateIs(client, runId, 'running');
    // A running snapshot can precede asynchronous acquisition; live output uses the real port when ready.
    for (let i = 0; i < 30 && f.calls().filter(a => a[1] === 'prompt').length !== 1; i++) await client.tool('wait', { runId, timeoutMs: 100 });
    assert.equal(f.calls().filter(a => a[1] === 'prompt').length, 1);
    assert.match(success(await client.tool('output', { runId })).text, /stock fixture output/);
    const started = Date.now(); assert.deepEqual(success(await client.tool('wait', { runId, timeoutMs: 1200 })), []); assert.ok(Date.now() - started >= 1200);
    assert.match((await client.tool('runtime_close')).error, /^SHUTDOWN_/);
    const owner = readFileSync(join(f.state(), 'service.lock/owner.json'), 'utf8');
    const markerHash = hashFile(join(f.state(), 'startup.json')); const descriptorHash = hashFile(join(f.state(), 'pi.json'));
    await client.close(); client = await f.mcp(); // EOF is not service shutdown.
    assert.equal(readFileSync(join(f.state(), 'service.lock/owner.json'), 'utf8'), owner);
    assert.deepEqual(success(await client.tool('launch', args)), admitted);
    assert.equal((await client.tool('launch', { ...args, prompt: 'changed' })).error, 'COMMAND_ID_REUSE');
    assert.equal(f.rows('runs').length, 1); assert.equal(f.calls().filter(a => a[1] === 'prompt').length, 1);
    assert.equal(hashFile(join(f.state(), 'startup.json')), markerHash); assert.equal(hashFile(join(f.state(), 'pi.json')), descriptorHash);
    const run = JSON.parse(f.rows('runs')[0].data); const node = run.nodes.worker;
    const events = f.rows('events').map(row => JSON.parse(row.data));
    assert.ok(events.every(e => e.host === host)); assert.equal(events.filter(e => e.type === 'node.launched').length, 1);
    assert.ok(!events.some(e => ['graph.planned', 'wave.started'].includes(e.type)));
    assert.equal(node.packet.execution.environment.ADVISOR_RUNTIME_DESCRIPTOR, '');
    assert.equal(node.packet.execution.environment.PI_DETACH_RUNTIME_BRIDGE, '');
    const marker = JSON.parse(readFileSync(join(f.state(), 'startup.json'), 'utf8'));
    assert.equal(marker.identity.rootHost, host); assert.equal(marker.identity.nativeRoot.pid, process.pid);
    assert.equal(marker.identity.nativeRoot.providerSession.value, session.value);
    const control = readCredential(join(f.state(), 'pi.json'));
    // Exact canonical packet admission remains forbidden without the runtime-owned bridge intent.
    const grant = JSON.parse(f.rows('principals')[0].data).scopes.find(scope => scope.node === 'root');
    const rootScope = { ...grant, ownerEpoch: 1 };
    assert.equal((await callSocket(control, { v: 1, op: 'workstream.create', scope: rootScope, commandId: 'bare-create', expectedRevision: 0, payload: { cwd: join(f.root, 'work'), host } }, 'model')).ok, true);
    const forged = await callSocket(control, { v: 1, op: 'packet.admit', scope: rootScope, commandId: 'forged', expectedRevision: 1, payload: { node: 'worker', packet: node.packet } }, 'model');
    assert.equal(forged.error, 'BRIDGE_TRUSTED_INTENT_REQUIRED');
    const effectsBefore = f.effects().length;
    for (const field of ['terminal_id', 'foreground_cwd']) {
      const old = f.data.agent[field]; f.data.agent[field] = field === 'foreground_cwd' ? f.root : 'foreign-terminal'; f.saveRoot();
      assert.equal((await client.tool('list')).ok, false); f.data.agent[field] = old; f.saveRoot();
    }
    session.value = 'foreign-session'; f.saveRoot(); assert.equal((await client.tool('list')).error, 'STOCK_ROOT_BINDING'); session.value = `native-${host}`; f.saveRoot();
    f.data.info.foreground_processes[0].pid = 999999; f.saveRoot(); assert.equal((await client.tool('list')).error, 'STOCK_ROOT_BINDING'); f.data.info.foreground_processes[0].pid = process.pid; f.saveRoot();
    assert.equal(f.effects().length, effectsBefore);
    const markerPath = join(f.state(), 'startup.json'); const markerBytes = readFileSync(markerPath, 'utf8');
    const tampered = JSON.parse(markerBytes); tampered.identity.nativeRoot.pid += 1;
    writeFileSync(markerPath, JSON.stringify(tampered), { mode: 0o600 });
    const fresh = await f.mcp();
    assert.equal((await fresh.tool('launch', { commandId: 'tampered-marker', prompt: 'no effect' })).error, 'PI_DETACH_BINDING_MISMATCH');
    assert.equal(f.effects().length, effectsBefore); await fresh.close();
    writeFileSync(markerPath, markerBytes, { mode: 0o600 });
    // Force a real captured BLOCKED artifact and its canonical request through the existing observer.
    writeFileSync(join(node.packet.execution.sourceDirectory, 'result.md'), '# Status\nBLOCKED\nChoose A.');
    const pane = JSON.parse(node.handle.id)[0]; const panePath = join(f.root, `${pane.replace(':', '-')}.json`);
    const occupant = JSON.parse(readFileSync(panePath, 'utf8')); occupant.status = 'done'; occupant.state_change_seq += 2; writeFileSync(panePath, JSON.stringify(occupant));
    await stateIs(client, runId, 'blocked');
    const request = JSON.parse(success(await client.tool('artifact', { runId, path: 'request.json' })).text);
    assert.equal(request.kind, 'question'); assert.equal(request.answered, false);
    const result = '# Status\nPASS\nA verified.\n'; f.behavior({ status: 'done', artifact: result });
    const message = { commandId: 'answer', runId, text: 'A' };
    success(await client.tool('message', message)); await stateIs(client, runId, 'terminal');
    const prompts = f.calls().filter(a => a[1] === 'prompt').length;
    success(await client.tool('message', message)); assert.equal(f.calls().filter(a => a[1] === 'prompt').length, prompts);
    assert.equal((await client.tool('message', { ...message, text: 'B' })).error, 'COMMAND_ID_REUSE');
    assert.equal(JSON.parse(success(await client.tool('artifact', { runId, path: 'request.json' })).text).answered, true);
    const page = success(await client.tool('artifact', { runId, path: 'result.md', maxBytes: 8 })); assert.equal(page.bytes, 8); assert.equal(page.eof, false);
    assert.equal(page.text + success(await client.tool('artifact', { runId, path: 'result.md', offset: page.nextOffset })).text, result);
    assert.equal((await client.tool('artifact', { runId, path: '../pi.json' })).error, 'STOCK_INVALID_ARGUMENTS');
    const pending = success(await client.tool('wait', { runId, timeoutMs: 10000 })); assert.ok(pending.length);
    assert.equal((await client.tool('runtime_close')).error, 'SHUTDOWN_DELIVERY');
    await client.close(); client = await f.mcp();
    assert.deepEqual(success(await client.tool('wait', { runId, timeoutMs: 0 })), pending);
    await ackAll(client, runId); assert.deepEqual(success(await client.tool('wait', { runId, timeoutMs: 0 })), []);
    assert.deepEqual(success(await client.tool('wait', { runId, timeoutMs: 10000 })), [], 'terminal wait returns immediately');
    success(await client.tool('message', { commandId: 'kept-task', runId, text: 'Fresh bounded task' })); await stateIs(client, runId, 'terminal'); await ackAll(client, runId);
    f.behavior({ status: 'working' });
    const cancelRun = success(await client.tool('launch', { ...args, commandId: 'cancel-me' })).runId;
    for (let i = 0; i < 30 && f.rows('effects').some(e => e.run === cancelRun && e.state !== 'done'); i++) await client.tool('wait', { runId: cancelRun, timeoutMs: 100 });
    const cancel = { commandId: 'escape', runId: cancelRun }; assert.equal(success(await client.tool('cancel', cancel)).status, 'cancel-pending');
    const cancelled = await stateIs(client, cancelRun, 'terminal'); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.processExited, undefined);
    success(await client.tool('cancel', cancel)); assert.equal(f.calls().filter(a => a[1] === 'send-keys').length, 1); await ackAll(client, cancelRun);
    const listed = success(await client.tool('list')); assert.equal(listed.length, 2);
    const curated = JSON.stringify(client.received.filter(r => r.result?.content).map(r => JSON.parse(r.result.content[0].text)));
    for (const forbidden of ['packet', 'execution', 'environment', 'scopes', 'sourceDirectory', control.token, control.socketPath, node.packet.execution.command]) assert.ok(!curated.includes(forbidden), forbidden);
    assert.equal((await client.tool('status', { runId: 'pib-foreign' })).error, 'BRIDGE_TARGET_FORBIDDEN');
    all.push({ f, client, runId, control, markerHash, owner });
  }
  // Both live root services have distinct credentials and disjoint run authority.
  const [a, b] = all;
  assert.notEqual(a.control.token, b.control.token); assert.notEqual(a.f.state(), b.f.state());
  assert.equal((await callSocket({ ...b.control, token: a.control.token }, { v: 1, op: 'pi.detach', sessionId: 'foreign', action: 'list', payload: {} }, 'model')).error, 'UNAUTHORIZED');
  assert.equal((await b.client.tool('status', { runId: a.runId })).error, 'BRIDGE_TARGET_FORBIDDEN');
  assert.equal((await b.client.tool('artifact', { runId: a.runId, path: 'result.md' })).error, 'BRIDGE_TARGET_FORBIDDEN');
  for (const item of all) {
    const { f, client } = item;
    const effects = f.effects().length;
    success(await client.tool('runtime_close'));
    assert.equal(existsSync(join(f.state(), 'service.lock/owner.json')), false);
    assert.equal(hashFile(join(f.state(), 'startup.json')), item.markerHash);
    assert.equal((await client.tool('launch', { commandId: 'never-restart', prompt: 'must fail closed' })).error, 'STOCK_UNAVAILABLE');
    const reconnect = await f.mcp(); assert.equal((await reconnect.tool('list')).error, 'STOCK_UNAVAILABLE');
    assert.equal(f.effects().length, effects); assert.equal(f.rows('runs').length, 3, 'two facade runs plus the empty canonical negative-probe run');
    await client.close(); await reconnect.close();
  }
  console.log('PASS actual stock MCP framing/reconnect → lazy host → core/SQLite → paired port/fake Herdr; both native root hosts, no model/Pi root process');
});

test('a dead or uncertain permanent stock marker never restarts a host or adopts work', { skip: !detach, timeout: 30000 }, async t => {
  const f = fixture(t, 'codex'); let client = await f.mcp();
  const args = { commandId: 'one', prompt: 'Bounded task', harness: 'native', model: 'openai-codex/example', keepAlive: true };
  const runId = success(await client.tool('launch', args)).runId;
  for (let i = 0; i < 30 && f.rows('effects').some(e => e.state !== 'done'); i++) await client.tool('wait', { runId, timeoutMs: 100 });
  const ownerPath = join(f.state(), 'service.lock/owner.json');
  const owner = readFileSync(ownerPath, 'utf8'); const marker = readFileSync(join(f.state(), 'startup.json'), 'utf8');
  const effects = f.effects().length;
  process.kill(JSON.parse(owner).pid, 'SIGKILL'); // Deliberate death of this test's own service, not product recovery.
  await client.close(); client = await f.mcp();
  for (const [name, input] of [['list', {}], ['launch', args], ['launch', { ...args, commandId: 'new' }], ['runtime_close', {}]]) assert.equal((await client.tool(name, input)).error, 'STOCK_UNAVAILABLE');
  assert.equal(f.effects().length, effects); assert.equal(f.rows('runs').length, 1);
  assert.equal(readFileSync(ownerPath, 'utf8'), owner); assert.equal(readFileSync(join(f.state(), 'startup.json'), 'utf8'), marker);
  await client.close();
  // An incomplete startup with no descriptor is equally permanent.
  rmSync(join(f.state(), 'pi.json')); rmSync(join(f.state(), 'runtime.sock'), { force: true });
  const uncertain = await f.mcp(); assert.equal((await uncertain.tool('launch', args)).error, 'STOCK_UNAVAILABLE');
  assert.equal(existsSync(join(f.state(), 'pi.json')), false); assert.equal(f.effects().length, effects);
  assert.equal(readFileSync(ownerPath, 'utf8'), owner); await uncertain.close();
});
