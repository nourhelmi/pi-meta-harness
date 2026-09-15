import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { AdvisorRuntime } from '../scripts/advisor-runtime/runtime.mjs';
import { createPiDetachAdapter } from '../scripts/advisor-runtime/adapters/pi-detach.mjs';
import { OPERATIONS, validateGraph } from '../scripts/advisor-runtime/contract.mjs';
import { newFamily, familyOperation } from '../scripts/advisor-runtime/family.mjs';
import { readTranscript } from '../scripts/advisor-runtime/transcript.mjs';
import { authorizedWorktree } from '../scripts/advisor-runtime/workspaces.mjs';

const success = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.value ?? value.receipt; };
function fixture(t, gitRepository = false, operations = OPERATIONS, subdirectory = false) {
  const base = realpathSync(mkdtempSync('/tmp/thin-')); let cwd = join(base, 'work'); mkdirSync(cwd);
  if (gitRepository) { for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']]) assert.equal(spawnSync('git', ['-C', cwd, ...args]).status, 0); }
  if (subdirectory) { cwd = join(cwd, 'packages', 'foo'); mkdirSync(cwd, { recursive: true }); }
  const stateRoot = join(base, 'state'); const calls = []; let generation = 0;
  const scope = { workstream: 'w', run: 'seed', node: 'root', ownerEpoch: 1 };
  const port = { version: 1, async prepare(params, sourceDirectory) {
    return { v: 1, command: 'pi', prompt: params.prompt, role: 'worker', runtime: 'pi', model: 'fixture', thinking: 'none', maxTurns: null, requiredSkills: [], harness: 'pi', keepAlive: params.keepAlive ?? true, label: 'worker', resultDiscovery: null, resultPolicy: 'runtime-capture', sourceDirectory,
      environment: { ADVISOR_RUNTIME_DESCRIPTOR: '', PI_DETACH_RUNTIME_BRIDGE: '', ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_RUNTIME_CANONICAL_OWNER: '1' } };
  }, async launch(input) {
    calls.push(input); const handle = input.hooks.expectedHandle ?? { id: `handle-${input.id}`, session: `session-${input.id}` };
    input.hooks.recordHandle(handle); generation++;
    return { readLive: async () => 'terminal tail', detach() {}, runtimeObservation: async () => ({ session: handle.session, generation, state: input.hooks.completed ? 'done' : 'working' }) };
  } };
  let runtime, token;
  const principal = { id: 'advisor', kind: 'advisor', scopes: ['root', 'worker'].map(node => ({ workstream: 'w', run: 'seed', node })), operations };
  function start(restart = false) {
    const adapter = createPiDetachAdapter(port);
    runtime = new AdvisorRuntime({ stateRoot, allowedRoots: [cwd], adapters: { roots: {}, workers: { 'pi-detach': adapter } }, piBridge: { version: 1, portVersion: 1, principalId: principal.id, sessionId: 'owner', scopes: [scope], cwd, prepare: port.prepare, allowedRoots: [cwd], maxLaunches: 1, dynamic: true, managedIdentity: { fixture: true }, readLive: adapter.readLive } });
    if (!restart) token = runtime.registerPrincipal(principal);
    runtime.initializeFamily();
  }
  start();
  const raw = (action, payload = {}) => runtime.piDetachRequest(token, { v: 1, op: 'pi.detach', sessionId: 'owner', action, payload }, 'model');
  const request = async (action, payload = {}) => success(await raw(action, payload));
  const launch = async (key, params) => { const result = await request('call', { toolCallId: key, tool: 'bg_agent', cwd, params }); await runtime.dispatch(); return result.runId; };
  const settle = text => { const last = calls.at(-1); if (text !== null) writeFileSync(join(last.intent.sourceDirectory, 'result.md'), text); last.hooks.settled('done', 'terminal tail', ++generation); };
  t.after(() => { try { runtime.disposeUnstarted(); } catch {} rmSync(base, { recursive: true, force: true }); });
  return { base, cwd, calls, request, raw, port, launch, settle, restart() { runtime.close(); start(true); }, runtime: () => runtime };
}

test('large prompts, followups and reports retain full content; report state never gates completed turns', async t => {
  const f = fixture(t); const prompt = '🚀 task\n'.repeat(30000);
  const runId = await f.launch('large', { prompt }); assert.equal(f.calls[0].intent.prompt, prompt);
  f.settle(null);
  let node = await f.request('get', { runId }); assert.equal(node.status, 'done'); assert.equal(node.reportStatus.availability, 'result-blank'); assert.equal(node.reusable, true);
  for (const [i, report] of ['', 'Status: IN PROGRESS', 'Status: BLOCKED\nChoose A?', 'plain unusual format', 'Status: DONE\n' + 'é'.repeat(800000)].entries()) {
    const reply = `${i}\n${prompt}`; await f.launch(`follow-${i}`, { name: runId, prompt: reply, keepAlive: false });
    assert.equal(f.calls.at(-1).reply, reply); assert.equal(f.calls.at(-1).intent.keepAlive, false);
    f.settle(report); node = await f.request('get', { runId }); assert.equal(node.status, 'done');
    if (report) assert.equal(readFileSync(node.result.path, 'utf8'), report);
    if (i === 4) {
      const page = await f.request('artifact', { runId, path: 'result.md', offset: 1100000, maxBytes: 100 }); assert.equal(page.bytes, 100); assert.equal(page.eof, false);
    }
  }
  const stopped = await f.request('call', { toolCallId: 'stop', tool: 'bg_stop', cwd: f.cwd, params: { runId } }); assert.equal(stopped.alreadySettled, true);
  const deliveries = await f.request('wait', { runId, timeoutMs: 0 }); assert.equal(deliveries.filter(d => d.kind === 'settled').length, 6);
  assert.equal((await f.request('family.budget')).maxLaunches, null);
});

test('existing family budgets no longer cap root or descendant admissions; replay and ancestry sealing remain', () => {
  const root = '/private/tmp/family-fixture'; const config = { sessionId: 'root', maxLaunches: 1, allowedRoots: ['/private/tmp'], scopes: [{ workstream: 'w' }] };
  const ledger = newFamily(root, config); ledger.maxLaunches = 1;
  ledger.services.child = { token: 'child-token', sessionId: 'child', workstream: 'child-work', parent: root, sealed: false };
  const token = ledger.services[root].token;
  for (let i = 0; i < 300; i++) {
    const child = i % 2 === 1; const payload = { commandId: `c-${i}`, digest: 'a'.repeat(64), scope: { workstream: child ? 'child-work' : 'w', run: `r-${i}`, node: 'worker', ownerEpoch: 1 }, op: ['node.launch', 'node.task', 'node.reply', 'team.assign'][i % 4], attempt: 1 };
    familyOperation(ledger, child ? 'child-token' : token, 'reserve', payload); familyOperation(ledger, child ? 'child-token' : token, 'reserve', payload);
  }
  assert.equal(familyOperation(ledger, token, 'budget', {}).used, 300);
  assert.equal(familyOperation(ledger, token, 'budget', {}).remaining, null);
  familyOperation(ledger, token, 'seal', {}); assert.throws(() => familyOperation(ledger, 'child-token', 'check', {}), /FAMILY_ADMISSION_SEALED/);
});

test('large DAGs and unknown evidence do not veto ordinary execution', async t => {
  const names = Array.from({ length: 70 }, (_, i) => `n-${i}`);
  validateGraph({ graph: 'g', waves: [names.slice(0, 35), names.slice(35)], dependencies: Object.fromEntries(names.map((n, i) => [n, i < 35 ? [] : names.slice(0, 35)])), maxParallel: 35, maxRepairLoops: 99, topology: 'flat-root' });
  assert.throws(() => validateGraph({ graph: 'g', waves: [['a']], dependencies: { a: ['a'] }, maxParallel: 1, maxRepairLoops: 99, topology: 'flat-root' }), /GRAPH_CYCLE_OR_ORDER/);
  const f = fixture(t); const runId = await f.launch('unknown-input', { prompt: `work\n[advisor-input:${'a'.repeat(64)}]` }); f.settle('done');
  const node = await f.request('get', { runId }); assert.equal(node.consumedInputs[0].evidenceStatus, 'unknown'); assert.equal(node.status, 'done');
});

test('registered worktrees inside and outside are admitted by an existing owner; aliases and unrelated cwd denied', async t => {
  const f = fixture(t, true);
  const git = (...args) => { const result = spawnSync('git', ['-C', f.cwd, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init', '-q'); git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  // Repository identity must be established at trusted startup.
  f.restart();
  const outside = join(f.base, 'outside'); const inside = join(f.cwd, 'inside');
  for (const path of [outside, inside]) {
    git('worktree', 'add', '--detach', path); assert.equal(authorizedWorktree(f.cwd, path), true);
    const runId = await f.launch(`worktree-${path === inside ? 'in' : 'out'}`, { cwd: path, prompt: 'task' }); f.settle('done'); assert.equal((await f.request('get', { runId })).packet.cwd, path);
  }
  f.restart(); assert.equal((await f.request('list')).length, 2);
  const unrelated = join(f.base, 'unrelated'); mkdirSync(unrelated);
  await assert.rejects(f.launch('foreign', { cwd: unrelated, prompt: 'task' }), /CWD_FORBIDDEN/);
  const alias = join(f.base, 'alias'); symlinkSync(outside, alias);
  await assert.rejects(f.launch('alias', { cwd: alias, prompt: 'task' }), /SYMLINK_PATH/);
  git('worktree', 'remove', '--force', inside);
  const remaining = await f.launch('remaining', { cwd: outside, prompt: 'task' }); f.settle('done'); assert.equal((await f.request('get', { runId: remaining })).status, 'done');
  const stale = join(f.base, 'stale-registration'); git('worktree', 'add', '--detach', stale);
  rmSync(stale, { recursive: true }); mkdirSync(stale); assert.equal(spawnSync('git', ['-C', stale, 'init', '-q']).status, 0);
  await assert.rejects(f.launch('foreign-registered-path', { cwd: stale, prompt: 'task' }), /CWD_FORBIDDEN/);
  const unaffected = await f.launch('unaffected', { cwd: outside, prompt: 'task' }); f.settle('done');
  assert.equal((await f.request('get', { runId: unaffected })).status, 'done');
});

test('shutdown retains unacked notifications and restart reconciliation never replays input or clears captures', async t => {
  const f = fixture(t); const runId = await f.launch('once', { prompt: 'one task' }); f.settle('Status: DONE\nOriginal report');
  const before = await f.request('wait', { runId, timeoutMs: 0 }); const path = (await f.request('get', { runId })).result.path;
  f.restart(); const original = readFileSync(path, 'utf8');
  await f.request('reconcile', { runId });
  assert.equal(f.calls.filter(call => !call.hooks.observeOnly).length, 1); assert.equal(f.calls.at(-1).hooks.observeOnly, true);
  assert.equal(readFileSync(path, 'utf8'), original);
  const after = await f.request('wait', { runId, timeoutMs: 0 }); assert.equal(after.filter(d => d.id === before[0].id).length, 1);
  await f.request('ack', { runId, deliveryId: before[0].id }); await f.request('ack', { runId, deliveryId: before[0].id });
  assert.equal((await f.request('wait', { runId, timeoutMs: 0 })).some(d => d.id === before[0].id), false);
  await f.launch('next', { name: runId, prompt: 'explicit new task' }); f.settle('done');
  assert.equal(f.calls.filter(call => !call.hooks.observeOnly).length, 2);
});

test('transcript searches early recorded tools/messages with stable pagination and denies foreign/control paths', t => {
  const f = fixture(t); const agentDir = join(f.base, 'pi'); const directory = join(agentDir, 'sessions', 'work'); mkdirSync(directory, { recursive: true });
  const path = join(directory, '2026-09-15T00-00-00-000Z_a0000000-0000-4000-8000-000000000001.jsonl'); const session = JSON.stringify(['herdr:pi', 'pi', 'path', path]);
  const records = [{ type: 'session', id: 'a0000000-0000-4000-8000-000000000001', cwd: f.cwd }, ...Array.from({ length: 500 }, (_, i) => ({ type: 'message', id: `m-${i}`, parentId: i ? `m-${i-1}` : null, message: { role: i === 2 ? 'toolResult' : 'user', content: i < 4 ? `early needle ${i}` : `later ${i}` } }))];
  writeFileSync(path, records.map(value => JSON.stringify(value)).join('\n') + '\n');
  const binding = { session, cwd: f.cwd, environment: { PI_CODING_AGENT_DIR: agentDir } };
  const first = readTranscript(binding, { query: 'needle', context: 0, limit: 2 }); assert.equal(first.source, 'transcript'); assert.equal(first.entries.length, 2); assert.equal(first.hasMore, true);
  const second = readTranscript(binding, { query: 'needle', context: 0, limit: 2, cursor: first.nextCursor }); assert.equal(second.entries[0].record.message.role, 'toolResult'); assert.equal(second.hasMore, false);
  assert.equal(first.entries[0].ref, readTranscript(binding, { query: 'needle', context: 0, limit: 1 }).entries[0].ref);
  assert.throws(() => readTranscript({ ...binding, cwd: f.base }), /TRANSCRIPT_SESSION_MISMATCH/);
  assert.throws(() => readTranscript({ ...binding, controlPaths: [directory] }), /TRANSCRIPT_PATH_FORBIDDEN/);
  assert.equal(readTranscript({ ...binding, session: 'unknown' }).source, 'unavailable');
  return f.request('transcript', { runId: 'foreign-run' }).then(() => assert.fail('foreign run accepted'), error => assert.match(error.message, /BRIDGE_TARGET_FORBIDDEN/));
});

test('cleanup changes commit with accepted followup only and never rewrite the evidence contract', async t => {
  const f = fixture(t); const runId = await f.launch('initial', { prompt: 'task', keepAlive: true }); f.settle('Status: DONE');
  const original = await f.request('get', { runId });
  const rejected = await f.raw('call', { toolCallId: 'invalid-followup', tool: 'bg_agent', cwd: f.cwd, params: { name: runId, prompt: 'next', keepAlive: false, promoteAfterMs: 'invalid' } });
  assert.deepEqual(rejected, { ok: false, error: 'BRIDGE_INVALID_INPUT' });
  const after = await f.request('get', { runId });
  assert.deepEqual(after.packet, original.packet); assert.equal(after.cleanupKeepAlive, undefined); assert.deepEqual(after.contract, original.contract);
  await f.launch('accepted-followup', { name: runId, prompt: 'next', keepAlive: false }); f.settle('Status: DONE');
  const accepted = await f.request('get', { runId });
  assert.equal(accepted.cleanupKeepAlive, false); assert.deepEqual(accepted.packet, original.packet); assert.deepEqual(accepted.contract, original.contract);
  assert.equal(f.calls.at(-1).intent.keepAlive, false);
});

test('removed registered worktree cannot authorize dispatch or child registration after path reuse', async t => {
  const f = fixture(t, true); const outside = join(f.base, 'outside');
  assert.equal(spawnSync('git', ['-C', f.cwd, 'worktree', 'add', '--detach', outside]).status, 0);
  const admitted = await f.request('call', { toolCallId: 'removed', tool: 'bg_agent', cwd: f.cwd, params: { cwd: outside, prompt: 'never execute' } });
  assert.equal(spawnSync('git', ['-C', f.cwd, 'worktree', 'remove', '--force', outside]).status, 0); mkdirSync(outside);
  await f.runtime().dispatch();
  const node = await f.request('get', { runId: admitted.runId });
  assert.equal(f.calls.length, 0); assert.equal(node.recoveryCause, 'CWD_FORBIDDEN');
  const ledger = newFamily(join(f.base, 'family'), { cwd: f.cwd, sessionId: 'root', allowedRoots: [f.cwd, outside], scopes: [{ workstream: 'w' }] });
  assert.throws(() => familyOperation(ledger, ledger.services[join(f.base, 'family')].token, 'register', { scope: { workstream: 'w', run: 'x', node: 'worker', ownerEpoch: 1 }, cwd: outside, issuedAttempt: 1 }), /FAMILY_CWD_FORBIDDEN/);
});

test('foreign replacement beneath the anchor cannot regain admission, dispatch or family authority', async t => {
  const f = fixture(t, true); const inside = join(f.cwd, 'inside');
  assert.equal(spawnSync('git', ['-C', f.cwd, 'worktree', 'add', '--detach', inside]).status, 0);
  const admitted = await f.request('call', { toolCallId: 'before-replacement', tool: 'bg_agent', cwd: f.cwd, params: { cwd: inside, prompt: 'never execute' } });
  // Keep Git's stale registration while replacing its directory with a foreign repo.
  rmSync(inside, { recursive: true }); mkdirSync(inside);
  assert.equal(spawnSync('git', ['-C', inside, 'init', '-q']).status, 0);
  await assert.rejects(f.request('call', { toolCallId: 'after-replacement', tool: 'bg_agent', cwd: f.cwd, params: { cwd: inside, prompt: 'forbidden' } }), /CWD_FORBIDDEN/);
  await f.runtime().dispatch();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('get', { runId: admitted.runId })).recoveryCause, 'CWD_FORBIDDEN');
  const ledger = newFamily(join(f.base, 'family'), { cwd: f.cwd, sessionId: 'root', allowedRoots: [f.cwd, inside], scopes: [{ workstream: 'w' }] });
  assert.throws(() => familyOperation(ledger, ledger.services[join(f.base, 'family')].token, 'register', { scope: { workstream: 'w', run: 'x', node: 'worker', ownerEpoch: 1 }, cwd: inside, issuedAttempt: 1 }), /FAMILY_CWD_FORBIDDEN/);
});

test('transcript operation requires artifact.read independently of progress and run ownership', async t => {
  const f = fixture(t, false, OPERATIONS.filter(op => op !== 'artifact.read')); const runId = await f.launch('owned', { prompt: 'task' }); f.settle(null);
  assert.equal((await f.request('get', { runId })).status, 'done');
  assert.deepEqual(await f.raw('transcript', { runId }), { ok: false, error: 'OPERATION_FORBIDDEN' });
  f.runtime().revokePrincipal('advisor'); assert.deepEqual(await f.raw('transcript', { runId }), { ok: false, error: 'UNAUTHORIZED' });
});

test('completed reconciliation observes a currently working session without claiming reuse or closing it', async t => {
  const f = fixture(t); const runId = await f.launch('initial', { prompt: 'task' }); f.settle('Status: DONE');
  const before = await f.request('get', { runId }); f.restart();
  const launch = f.port.launch;
  f.port.launch = async input => { const driver = await launch(input); return { ...driver, runtimeObservation: async () => ({ session: input.hooks.expectedHandle.session, generation: 50, state: 'working' }) }; };
  const reconciled = await f.request('reconcile', { runId });
  assert.equal(reconciled.executionStatus, 'done'); assert.equal(reconciled.agentState, 'working'); assert.equal(reconciled.reusable, false); assert.equal(reconciled.continuation, 'none');
  assert.throws(() => f.runtime().assertClosable(), /SHUTDOWN_ACTIVE/);
  const last = f.calls.at(-1); last.hooks.settled('done', 'background notification turn', 51);
  const idle = await f.request('get', { runId }); assert.equal(idle.reusable, true); assert.deepEqual(idle.result, { ...before.result, proof: 'unknown', tested: null });
  assert.equal(f.calls.filter(call => !call.hooks.observeOnly).length, 1);
  await f.launch('after-observed-background-turn', { name: runId, prompt: 'explicit next' });
  assert.equal(f.calls.at(-1).hooks.expectedGeneration, 51);
});

test('busy ordinary worker advice uses one durable typed message, never a followup launch', async t => {
  const f = fixture(t); let messages = 0;
  const launch = f.port.launch; f.port.launch = async input => ({ ...await launch(input), async message(value) { messages++; return { status: 'queued', session: value.target.session, generation: value.target.generation, state: 'working' }; } });
  const runId = await f.launch('initial', { prompt: 'task' });
  await f.launch('advice', { name: runId, prompt: 'advice ' + 'x'.repeat(200000) });
  await f.launch('advice', { name: runId, prompt: 'advice ' + 'x'.repeat(200000) });
  assert.equal(messages, 1); assert.equal(f.calls.length, 1); assert.equal((await f.request('get', { runId })).attempt, 1);
  assert.equal((await f.request('wait', { runId, timeoutMs: 0 })).find(d => d.kind === 'message.delivery').delivery.status, 'queued'); f.settle(null);
});

test('provider transcripts pin IDs for paths and cover Pi/Claude IDs, Codex local date, giant records and cross-session denial', async t => {
  const f = fixture(t); const piDir = join(f.base, 'pi'); const claudeDir = join(f.base, 'claude'); const codexDir = join(f.base, 'codex');
  const id = 'a0000000-0000-4000-8000-000000000001';
  const piPath = join(piDir, 'sessions', `--${f.cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`, `2026-09-15T00-00-00-000Z_${id}.jsonl`);
  mkdirSync(join(piPath, '..'), { recursive: true });
  const huge = JSON.stringify({ type: 'message', id: 'tool', parentId: null, message: { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [{ type: 'text', text: 'early needle ' + 'é'.repeat(200000) }], isError: false, timestamp: 1 } });
  const header = JSON.stringify({ type: 'session', version: 3, id, cwd: f.cwd }); writeFileSync(piPath, `${header}\n${huge}\n`);
  const binding = { session: JSON.stringify(['herdr:pi', 'pi', 'id', id]), cwd: f.cwd, environment: { PI_CODING_AGENT_DIR: piDir } };
  const page = readTranscript(binding, { query: 'early needle', context: 1 });
  assert.equal(page.entries.length, 2); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16000);
  const ref = page.entries[1].ref; let offset = 0; const chunks = [];
  for (;;) { const chunk = readTranscript(binding, { entryRef: ref, offset, maxBytes: 65536 }); chunks.push(Buffer.from(chunk.base64, 'base64')); if (chunk.eof) break; assert.ok(chunk.nextOffset > offset); offset = chunk.nextOffset; }
  assert.equal(Buffer.concat(chunks).toString(), huge);
  assert.throws(() => readTranscript(binding, { entryRef: ref + 'foreign' }), /TRANSCRIPT_ENTRY_FORBIDDEN/);
  const pathBinding = { ...binding, session: JSON.stringify(['herdr:pi', 'pi', 'path', piPath]) };
  assert.equal(readTranscript(pathBinding).source, 'transcript');
  writeFileSync(piPath, JSON.stringify({ type: 'session', version: 3, id: 'b0000000-0000-4000-8000-000000000002', cwd: f.cwd }) + '\n');
  assert.throws(() => readTranscript(pathBinding), /TRANSCRIPT_SESSION_MISMATCH/);
  const claudePath = join(claudeDir, 'projects', f.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`); mkdirSync(join(claudePath, '..'), { recursive: true });
  const claude = { type: 'assistant', sessionId: id, cwd: f.cwd, uuid: 'm1', parentUuid: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'source.ts' } }] } };
  writeFileSync(claudePath, JSON.stringify(claude) + '\n');
  const cb = { session: JSON.stringify(['herdr:claude', 'claude', 'id', id]), cwd: f.cwd, environment: { CLAUDE_CONFIG_DIR: claudeDir } };
  assert.equal(readTranscript(cb).entries[0].record.uuid, 'm1');
  writeFileSync(claudePath, JSON.stringify(claude) + '\n' + JSON.stringify({ ...claude, sessionId: 'foreign' }) + '\n');
  assert.throws(() => readTranscript(cb), /TRANSCRIPT_SESSION_MISMATCH/);
  const stamp = Date.parse('2026-09-14T22:00:00Z').toString(16).padStart(12, '0'); const codexId = `${stamp.slice(0, 8)}-${stamp.slice(8)}-7000-8000-000000000001`;
  const codexPath = join(codexDir, 'sessions', '2026', '09', '15', `rollout-2026-09-15T01-00-00-${codexId}.jsonl`); mkdirSync(join(codexPath, '..'), { recursive: true });
  writeFileSync(codexPath, JSON.stringify({ type: 'session_meta', payload: { id: codexId, cwd: f.cwd } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 't1', output: 'recorded output' } }) + '\n');
  const xb = { session: JSON.stringify(['herdr:codex', 'codex', 'id', codexId]), cwd: f.cwd, environment: { CODEX_HOME: codexDir } };
  assert.equal(readTranscript(xb, { query: 'recorded output', context: 0 }).entries[0].record.payload.type, 'function_call_output');
});

test('trusted package subdirectory cwd survives launch, child registration and reconnect', async t => {
  const f = fixture(t, true, OPERATIONS, true); const runId = await f.launch('package', { prompt: 'task' }); f.settle('done');
  const ledger = newFamily(join(f.base, 'family'), { cwd: f.cwd, sessionId: 'root', allowedRoots: [f.cwd], scopes: [{ workstream: 'w' }] });
  const token = ledger.services[join(f.base, 'family')].token; const scope = { workstream: 'w', run: 'child', node: 'worker', ownerEpoch: 1 };
  familyOperation(ledger, token, 'reserve', { commandId: 'launch', digest: 'a'.repeat(64), scope, op: 'node.launch', attempt: 1 });
  assert.equal(familyOperation(ledger, token, 'register', { scope, cwd: f.cwd, issuedAttempt: 1 }).cwd, f.cwd);
  f.restart(); await f.request('reconcile', { runId }); await f.launch('next', { name: runId, prompt: 'new task' }); f.settle(null);
  assert.equal(f.calls.filter(call => !call.hooks.observeOnly).length, 2);
});

test('unacknowledged input stays unknown through reconciliation and unrelated settlement, without replay', async t => {
  const f = fixture(t); const launch = f.port.launch; let failReconcile = true;
  f.port.launch = async input => { if (input.hooks.observeOnly && failReconcile) { failReconcile = false; throw new Error('BRIDGE_OBSERVATION_AMBIGUOUS'); } const driver = await launch(input); if (!input.hooks.observeOnly) throw new Error('BRIDGE_PROMPT_AMBIGUOUS'); return { ...driver, runtimeObservation: async () => ({ session: input.hooks.expectedHandle.session, generation: 10, state: 'working' }) }; };
  const runId = await f.launch('uncertain', { prompt: 'never proven delivered' });
  assert.equal((await f.request('get', { runId })).recoveryCause, 'BRIDGE_PROMPT_AMBIGUOUS');
  await f.request('reconcile', { runId });
  assert.equal((await f.request('get', { runId })).recoveryCause, 'BRIDGE_OBSERVATION_AMBIGUOUS');
  assert.equal((await f.request('get', { runId })).uncertainInput, true);
  const persisted = new DatabaseSync(join(f.base, 'state', 'runtime.sqlite'), { readOnly: true });
  try { assert.equal(JSON.parse(persisted.prepare('SELECT data FROM runs WHERE id=?').get(runId).data).nodes.worker.uncertainInput, true); } finally { persisted.close(); }
  await f.request('reconcile', { runId });
  const observing = await f.request('get', { runId }); assert.equal(observing.executionCompletion, 'unknown'); assert.equal(observing.reusable, false);
  const reattached = f.calls.at(-1); writeFileSync(join(reattached.intent.sourceDirectory, 'result.md'), 'Status: DONE\nUnrelated task B');
  reattached.hooks.settled('done', 'unrelated output', 11);
  const retired = await f.request('get', { runId }); assert.equal(retired.executionCompletion, 'unknown'); assert.equal(retired.status, 'stalled'); assert.equal(retired.result, null);
  assert.equal((await f.request('wait', { runId, timeoutMs: 0 })).some(d => d.kind === 'settled' && d.status === 'done'), false);
  assert.equal(f.calls.filter(call => !call.hooks.observeOnly).length, 1); f.runtime().assertClosable();
});

test('host verification preserves output beyond former report and evidence byte ceilings', async t => {
  const f = fixture(t, true); const runId = await f.launch('check-large', { prompt: 'produce report' });
  f.settle('# Status\nPASS\n# Claims\nCompleted.\n# Evidence\nRecorded.\n# Remaining Risk\nNone.\n');
  const node = await f.request('get', { runId });
  const graph = { graphId: 'proof', advisorSessionId: 'owner', nodes: [{ id: 'maker', task: 'checked work', dependsOn: [] }] };
  await f.request('graph.evidence', { graph, node: 'maker', runId });
  const checked = f.runtime().checkNode({ scope: node.snapshot.scope, command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(1200000))"] });
  assert.equal(checked.output, 'x'.repeat(1200000) + '\n');
  assert.equal(JSON.parse(readFileSync(checked.path, 'utf8')).output, checked.output);
  assert.equal(checked.proof, 'verified');
  assert.equal((await f.request('get', { runId })).result.proof, 'verified');
  f.restart();
  assert.equal((await f.request('get', { runId })).result.proof, 'unknown');
  f.runtime().checkNode({ scope: node.snapshot.scope, command: process.execPath, args: ['-e', 'process.exit(0)'] });
  const rechecked = await f.request('get', { runId });
  assert.equal(rechecked.runtimeState, 'recovery-required');
  assert.equal(rechecked.result.proof, 'verified', 'fresh actual verification is independent of session availability');
  assert.equal((await f.request('graph.evidence', { graph, node: 'maker' })).node.proof, 'verified');
});
