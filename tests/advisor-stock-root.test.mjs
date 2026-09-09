import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { createStockFacade, identifyStockRoot, stockConfig, stockError, stockTools } from '../scripts/advisor-runtime/stock-root.mjs';
import { bootstrapIdentity } from '../scripts/advisor-runtime/pi-detach-bootstrap.mjs';
import { createMcpHandler, serveMcp } from '../scripts/advisor-runtime/mcp.mjs';

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };
function fixture(t, host = 'codex') {
  const base = realpathSync(mkdtempSync('/tmp/stock-unit-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const dir of ['work', 'config', 'detach/src']) mkdirSync(join(base, dir), { recursive: true, mode: 0o700 });
  writeFileSync(join(base, 'detach/src/execution-port.ts'), '// unused by unit tests');
  const config = { v: 1, backend: 'runtime', node: process.execPath, host: resolve('scripts/advisor-runtime/pi-detach-host.mjs'), stateBase: join(base, 'state') };
  writeFileSync(join(base, 'config/pi-detach-runtime.json'), JSON.stringify(config));
  const env = { PI_CODING_AGENT_DIR: join(base, 'config'), HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1' };
  const kind = host === 'codex' ? 'codex' : 'claude';
  const agent = { agent: kind, pane_id: env.HERDR_PANE_ID, tab_id: env.HERDR_TAB_ID, workspace_id: env.HERDR_WORKSPACE_ID, terminal_id: 'terminal-root', foreground_cwd: join(base, 'work'), agent_session: { agent: kind, source: `herdr:${kind}`, kind: 'id', value: 'real-reported-session' } };
  const info = { pane_id: env.HERDR_PANE_ID, shell_pid: 10, foreground_process_group_id: 20, foreground_processes: [{ pid: 21, name: kind, argv0: kind, cwd: join(base, 'work') }] };
  let queries = 0;
  const options = { host, cwd: join(base, 'work'), env, detachPath: join(base, 'detach') };
  const query = args => { queries++; return args[0] === 'agent' ? { agent } : { process_info: info }; };
  const identify = input => identifyStockRoot(input, query, () => new Map([[21, 'Mon Sep 7 10:00:00 2026']]));
  const current = () => identify(options);
  return { base, config, env, options, agent, info, current, identify, query, queries: () => queries };
}
for (const host of ['codex', 'claude-code']) {
  test(`${host}: exact native binding, stable root hash, default Pi identity unchanged`, t => {
    const f = fixture(t, host);
    const first = f.current();
    assert.equal(first.rootHost, host); assert.equal(first.nativeRoot.providerSession.value, f.agent.agent_session.value);
    assert.match(first.sessionId, /^stock-[a-f0-9]{64}$/);
    f.info.foreground_processes[0].cwd = f.base;
    assert.throws(f.current, /STOCK_ROOT_BINDING/); f.info.foreground_processes[0].cwd = f.options.cwd;
    const pi = bootstrapIdentity({ cwd: f.options.cwd, sessionId: 'pi-session', detachPath: f.options.detachPath, config: f.config, herdr: first.herdr });
    assert.deepEqual(Object.keys(pi.identity), ['v', 'sessionId', 'cwd', 'detachPath', 'host', 'herdr', 'childState']);
    const native = bootstrapIdentity({ ...first, detachPath: f.options.detachPath, config: f.config });
    assert.equal(native.identity.rootHost, host); assert.deepEqual(native.identity.nativeRoot, first.nativeRoot);
    assert.equal(existsSync(f.config.stateBase), false);
  });
  test(`${host}: config is only a separately named fixed stdio member; no config writer`, t => {
    const f = fixture(t, host);
    const result = stockConfig(host, f.options.detachPath);
    assert.doesNotMatch(result.text, /--tools|--permission|--danger|--allow|CODEX_HOME|HOME|sandbox|features|hooks|env|advisor_runtime/);
    const args = [resolve('scripts/advisor-runtime/stock-root.mjs'), 'mcp', host, f.options.detachPath];
    if (host === 'claude-code') assert.deepEqual(JSON.parse(result.text), { mcpServers: { meta_harness: { command: realpathSync(process.execPath), args } } });
    else assert.equal(result.text, `[mcp_servers.meta_harness]\ncommand = ${JSON.stringify(realpathSync(process.execPath))}\nargs = ${JSON.stringify(args)}\n`);
    const cli = spawnSync(process.execPath, [resolve('scripts/advisor-runtime/stock-root.mjs'), 'config', host, f.options.detachPath], { encoding: 'utf8', env: f.env });
    assert.equal(cli.status, 0, cli.stderr); assert.equal(cli.stdout, result.text);
    assert.equal(existsSync(join(f.options.cwd, '.codex')), false); assert.equal(existsSync(join(f.options.cwd, '.mcp.json')), false);
    assert.equal(existsSync(f.config.stateBase), false);
  });
}

test('initialize, exact tool list, read-before-launch and reconnect are effect-free', async t => {
  const f = fixture(t);
  for (let reconnect = 0; reconnect < 2; reconnect++) {
    const handle = createMcpHandler(null, createStockFacade(f.options, f.identify));
    assert.equal((await handle(init)).result.serverInfo.name, 'meta-harness');
    const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.deepEqual(list.result.tools, stockTools);
    assert.equal(f.queries(), reconnect * 18);
    assert.deepEqual(stockTools.map(t => t.name), ['launch', 'message', 'cancel', 'list', 'status', 'output', 'wait', 'ack', 'artifact', 'runtime_close'].map(n => `advisor_worker_${n}`));
    for (const tool of stockTools) assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(stockTools[0].inputSchema.required, ['commandId', 'prompt']);
    assert.deepEqual(Object.keys(stockTools[0].inputSchema.properties), ['commandId', 'prompt', 'role', 'harness', 'model', 'thinking', 'maxTurns', 'anchor', 'acceptance', 'requiredSkills', 'keepAlive', 'cwd', 'label']);
    for (const [name, args] of [
      ['list', {}], ['status', { runId: 'missing' }], ['output', { runId: 'missing' }], ['wait', { runId: 'missing', timeoutMs: 10000 }],
      ['ack', { runId: 'missing', deliveryId: 1 }], ['artifact', { runId: 'missing', path: 'result.md' }], ['runtime_close', {}],
      ['cancel', { commandId: 'stop', runId: 'missing' }], ['message', { commandId: 'reply', runId: 'missing', text: 'reply' }],
    ]) {
      const response = await handle({ jsonrpc: '2.0', id: 'transport-only', method: 'tools/call', params: { name: `advisor_worker_${name}`, arguments: args } });
      assert.deepEqual(JSON.parse(response.result.content[0].text), { ok: false, error: 'STOCK_NOT_STARTED' });
      assert.equal(existsSync(f.config.stateBase), false);
    }
  }
});

test('native identity and worker-origin negatives reject before control-state effects', async t => {
  for (const mutate of [
    f => { delete f.agent.agent_session; }, f => { f.agent.agent = 'pi'; }, f => { f.agent.agent_session.agent = 'pi'; },
    f => { f.agent.agent_session.kind = 'path'; }, f => { f.agent.agent_session.value = ''; },
    f => { f.agent.pane_id = 'w1:p2'; }, f => { f.info.pane_id = 'w1:p2'; }, f => { f.agent.terminal_id = ''; },
    f => { f.agent.foreground_cwd = f.base; }, f => { f.info.foreground_processes[0].cwd = f.base; },
    f => { f.info.foreground_processes[0].pid = 999; }, f => { f.info.foreground_processes[0].argv0 = 'pi'; },
    f => { f.info.foreground_processes.push({ ...f.info.foreground_processes[0] }); }, f => { f.info.shell_pid = 0; },
    f => { f.info.foreground_process_group_id = 0; }, f => { f.agent.tab_id = 'another'; }, f => { f.agent.workspace_id = 'another'; },
    f => { f.env.HERDR_ENV = '0'; }, f => { f.env.ADVISOR_RUNTIME_CANONICAL_OWNER = '1'; },
    f => { f.env.ADVISOR_BRIDGE_CHILD_STATE = '/parent'; }, f => { f.env.ADVISOR_RUNTIME_DESCRIPTOR = '/secret'; },
  ]) {
    const f = fixture(t); mutate(f);
    const response = await createStockFacade(f.options, f.identify).call('advisor_worker_launch', { commandId: 'no-effect', prompt: 'must not start' });
    assert.equal(response.ok, false); assert.match(response.error, /^STOCK_/); assert.equal(existsSync(f.config.stateBase), false);
  }
});

test('exact schemas reject model authority, malformed values and implicit command IDs before identity queries', async t => {
  const f = fixture(t); const facade = createStockFacade(f.options, f.identify);
  for (const args of [
    { prompt: 'missing ID' }, { commandId: 1, prompt: 'numeric ID' }, { commandId: 'id', prompt: ' ' },
    ...['agent', 'resultPath', 'name', 'execution', 'environment', 'scope', 'descriptor', 'op', 'rootHost', 'nativeRoot'].map(key => ({ commandId: 'id', prompt: 'task', [key]: '/private' })),
    { commandId: 'id', prompt: 'task', harness: 'codex' }, { commandId: 'id', prompt: 'task', keepAlive: 'true' },
    { commandId: 'id', prompt: 'task', requiredSkills: ['../bad'] }, { commandId: 'id', prompt: 'task', acceptance: Array(13).fill('x') },
    { commandId: 'id', prompt: 'task', maxTurns: 0 }, { commandId: 'id', prompt: 'x'.repeat(16385) },
  ]) assert.deepEqual(await facade.call('advisor_worker_launch', args), { ok: false, error: 'STOCK_INVALID_ARGUMENTS' });
  for (const args of [{ runId: 'r', path: '../pi.json' }, { runId: 'r', path: 'result.md', offset: -1 }, { runId: 'r', path: 'result.md', maxBytes: 65537 }]) assert.equal((await facade.call('advisor_worker_artifact', args)).error, 'STOCK_INVALID_ARGUMENTS');
  assert.equal((await facade.call('advisor_worker_wait', { runId: 'r', timeoutMs: 10001 })).error, 'STOCK_INVALID_ARGUMENTS');
  assert.equal((await facade.call('advisor_packet_admit', {})).error, 'UNKNOWN_TOOL');
  assert.equal(f.queries(), 0); assert.equal(existsSync(f.config.stateBase), false);
  for (const error of [new Error('token=secret /private/source command'), new Error('PRIVATE_UPPERCASE'), null]) assert.equal(stockError(error), 'STOCK_UNAVAILABLE');
});

test('stock transport shares bounded framing and strict MCP metadata validation without a service', async t => {
  const f = fixture(t); const handler = () => createMcpHandler(null, createStockFacade(f.options, f.identify));
  const request = JSON.stringify(init) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { progressToken: 'ok' } } }) + '\n';
  let output = ''; const sink = new Writable({ write(chunk, _, callback) { output += chunk; callback(); } });
  await serveMcp(null, Readable.from([request.slice(0, 7), request.slice(7)]), sink, handler());
  assert.equal(output.trim().split('\n').length, 2);
  assert.equal(f.queries(), 0);
  for (const [wire, error] of [['{broken}\n', /INVALID_JSON/], ['{}', /TRUNCATED_REQUEST/], ['x'.repeat(65537), /ENVELOPE_TOO_LARGE/]]) await assert.rejects(serveMcp(null, Readable.from([wire]), sink, handler()), error);
  const h = handler(); await h(init);
  const invalid = await h({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { progressToken: {} } } });
  assert.equal(invalid.error.message, 'INVALID_MCP_METADATA');
  assert.equal(existsSync(f.config.stateBase), false);
});

test('Meta portable install copies the stock skill; strict package has no new mandatory backend dependency', () => {
  assert.match(readFileSync(resolve('scripts/meta-harness.mjs'), 'utf8'), /\["skills\/advisor-stock-entry", "skills\/advisor-stock-entry"\]/);
  assert.doesNotMatch(readFileSync(resolve('scripts/pack-advisor-native.mjs'), 'utf8'), /dependencies:.*(?:herdr|pi-detach)/);
});

for (const host of ['codex', 'claude-code']) {
  test(`F1 ${host}: foreign session source is rejected before any effect`, async t => {
    const f = fixture(t, host);
    for (const source of ['herdr:pi', host === 'codex' ? 'herdr:claude' : 'herdr:codex', 'fixture']) {
      f.agent.agent_session.source = source;
      assert.throws(f.current, /STOCK_SESSION_REQUIRED/);
      assert.deepEqual(await createStockFacade(f.options, f.identify).call('advisor_worker_launch', { commandId: 'no-source', prompt: 'No effect' }), { ok: false, error: 'STOCK_SESSION_REQUIRED' });
      assert.equal(existsSync(f.config.stateBase), false);
    }
  });
}

test('F2 stock cancellation notifications are silent transport-only input; strict MCP is unchanged', async t => {
  const f = fixture(t); const facade = createStockFacade(f.options, f.identify);
  const handle = createMcpHandler(null, facade); await handle(init);
  const cancelled = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'caller cancelled' } };
  assert.equal(await handle(cancelled), null);
  assert.equal(await handle({ ...cancelled, params: { requestId: 'stable-transport', _meta: { progressToken: 't' } } }), null);
  // Even malformed notifications must not receive a JSON-RPC response or enter the facade.
  assert.equal(await handle({ ...cancelled, params: { requestId: 2, runId: 'not-authority', reason: {} } }), null);
  assert.ok((await handle({ ...cancelled, id: 3 })).error);
  const strict = createMcpHandler(null); await strict(init);
  assert.equal((await strict(cancelled)).error.message, 'REQUEST_ID_REQUIRED');
  let output = ''; const sink = new Writable({ write(chunk, _, callback) { output += chunk; callback(); } });
  const wire = [init, cancelled, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }].map(JSON.stringify).join('\n') + '\n';
  await serveMcp(null, Readable.from([wire]), sink, createMcpHandler(null, facade));
  assert.deepEqual(output.trim().split('\n').map(line => JSON.parse(line).id), [1, 4]);
  assert.equal(f.queries(), 0); assert.equal(existsSync(f.config.stateBase), false);
});

for (const initialStatus of ['PASS', 'BLOCKED']) {
  test(`F3 ${initialStatus}: next attempt invalidates public result at admission before dispatch`, async t => {
    const { hostPiDetach } = await import('../scripts/advisor-runtime/pi-detach-host.mjs');
    const { readCredential } = await import('../scripts/advisor-runtime/service.mjs');
    const f = fixture(t); const launches = [];
    const port = { version: 1, async prepare(params, sourceDirectory) {
      return { v: 1, command: 'fixture', prompt: params.prompt, role: 'worker', runtime: 'fixture', model: 'fixture', thinking: 'none', maxTurns: null, requiredSkills: [], harness: 'native', keepAlive: true, label: 'fixture', resultDiscovery: null, resultPolicy: 'runtime-capture', sourceDirectory,
        environment: { ADVISOR_RUNTIME_DESCRIPTOR: '', PI_DETACH_RUNTIME_BRIDGE: '', ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_RUNTIME_CANONICAL_OWNER: '1' } };
    }, async launch({ hooks, intent }) { launches.push({ hooks, intent }); hooks.recordHandle({ id: 'fixture-worker', session: 'fixture-session' }); return { async interrupt() {}, async readLive() { return 'fixture'; } }; } };
    const stateRoot = join(f.base, 'state'); const credentialPath = join(stateRoot, 'pi.json');
    const host = await hostPiDetach({ stateRoot, cwd: f.options.cwd, sessionId: 'fixture-root', credentialPath, port, keepAlive: false, managedIdentity: { rootHost: 'codex' } });
    t.after(async () => { try { await host.service.close(); } catch {} });
    const { token } = readCredential(credentialPath);
    const request = async (action, payload) => { const r = await host.runtime.piDetachRequest(token, { v: 1, op: 'pi.detach', sessionId: 'fixture-root', action, payload }, 'model'); assert.equal(r.ok, true, JSON.stringify(r)); return r.value ?? r.receipt; };
    const call = (toolCallId, params) => request('call', { tool: 'bg_agent', toolCallId, cwd: f.options.cwd, params });
    const runId = (await call('first', { prompt: 'First result' })).runId;
    await host.runtime.dispatch();
    const oldText = `# Status\n${initialStatus}\nFirst attempt evidence.`;
    writeFileSync(join(launches[0].intent.sourceDirectory, 'result.md'), oldText);
    launches[0].hooks.settled('done', 'first output', 2);
    assert.equal((await request('artifact', { runId, path: 'result.md' })).text, oldText);
    const oldDeliveries = await request('wait', { runId, timeoutMs: 0 });
    const tracePath = join(stateRoot, 'traces', `${runId}.jsonl`); const oldTrace = readFileSync(tracePath, 'utf8');
    const next = { name: runId, prompt: 'Next attempt without any new result' };
    await call('next', next); // Direct runtime admission deliberately does NOT auto-dispatch.
    assert.equal(launches.length, 1);
    const current = await request('get', { runId }); assert.equal(current.snapshot.attempt, 2); assert.equal(current.snapshot.state, 'running');
    assert.equal((await request('artifact', { runId, path: 'result.md' })).text, '', 'old result is not current even before dispatch');
    const canonical = host.runtime.execute(token, { v: 1, op: 'artifact.read', scope: current.snapshot.scope, payload: { path: 'result.md', offset: 3, maxBytes: 8 } }, 'model');
    assert.deepEqual(canonical.value, { text: '', bytes: 0, nextOffset: 3, eof: true });
    assert.equal(readFileSync(join(stateRoot, 'runs', runId, 'worker/result.md'), 'utf8'), oldText, 'admission need not destructively rewrite historical capture bytes');
    assert.ok(readFileSync(tracePath, 'utf8').startsWith(oldTrace), 'prior trace records remain byte-identical');
    const deliveries = await request('wait', { runId, timeoutMs: 0 });
    for (const old of oldDeliveries) assert.deepEqual(deliveries.find(d => d.id === old.id), old);
    await call('next', next); assert.equal(launches.length, 1, 'replay cannot dispatch');
    await host.runtime.dispatch(); assert.equal(launches.length, 2);
    assert.equal((await request('artifact', { runId, path: 'result.md' })).text, '', 'running next attempt cannot read prior capture');
    launches[1].hooks.settled('done', 'empty second result', 4);
    assert.equal((await request('get', { runId })).status, 'stalled', 'missing fresh result never inherits PASS');
    assert.equal((await request('artifact', { runId, path: 'result.md' })).text, '');
    for (const delivery of await request('wait', { runId, timeoutMs: 0 })) await request('ack', { runId, deliveryId: delivery.id });
    await host.service.close();
  });
}
