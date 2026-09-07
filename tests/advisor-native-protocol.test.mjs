import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSession, environment } from '../scripts/advisor-runtime/adapters/common.mjs';
import { createCodexAdapter, codexThreadOptions, codexTurnOptions, decodeCodex, CodexWire, codexIsolatedConfig } from '../scripts/advisor-runtime/adapters/codex.mjs';
import { createClaudeAdapter, claudeOptions, decodeClaude, claudePermission } from '../scripts/advisor-runtime/adapters/claude.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { claudeResult, codexStart } from './native-fixture-shapes.mjs';
import { READ_PROFILE, WRITE_PROFILE } from '../scripts/advisor-runtime/native-boundary.mjs';

function session(t, provider = 'codex', root = false, limits) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pn-'))); const cwd = join(base, 'work'); const artifacts = join(base, 'artifacts'); mkdirSync(cwd); mkdirSync(artifacts, { mode: 0o700 });
  const events = []; const sent = []; let recovery = 0;
  const packet = { role: 'builder', model: 'fixture', thinking: 'high', task: 'fixture' };
  const input = { effect: { id: 'effect', commandId: 'command', scope: { workstream: 'work', run: 'run', node: root ? 'root' : 'maker', ownerEpoch: 1 }, payload: root ? { ...packet, text: 'hello' } : { packet }, attempt: 1 }, handle: null,
    context: { cwd, artifactDirectory: artifacts, resultPath: join(artifacts, 'result.md'), nestedDelegation: false, recoveryRequired() { recovery++; } }, emit: e => events.push(e), recordHandle() {} };
  const s = new NativeSession(input, provider, limits); s.stop = () => {}; s.startTurn(); s.turn = 'turn'; s.thread = 'thread'; s.items = new Set(['item']); s.events = new Map(); s.wire = { send: value => sent.push(value) };
  s.initialized = true; s.messages = new Map(); s.permissionPromises = new Map(); s.permissionFingerprints = new Map(); s.inputUuid = '00000000-0000-4000-a000-000000000002';
  t.after(() => { clearTimeout(s.timer); rmSync(base, { recursive: true, force: true }); }); return { s, input, events, sent, recovery: () => recovery };
}
const question = (id = 'request', overrides = {}) => ({ id, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [{ id: 'q1', header: 'Choice', question: 'Choose?', isOther: true, isSecret: false, options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }], isBlocking: true, autoResolutionMs: null, ...overrides } });
const sdkQuestion = { questions: [{ question: 'Choose?', header: 'Choice', multiSelect: true, options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] };
const permissionOptions = overrides => ({ requestId: 'request', toolUseID: 'tool', signal: new AbortController().signal, ...overrides });

test('supported options are explicit, no env token forwarding, no dangerous bypass and no worker root MCP', t => {
  const { s } = session(t);
  assert.deepEqual(environment({ PATH: '/bin', HOME: '/home', SECRET: 'never', ADVISOR_RUNTIME_DESCRIPTOR_PATH: '/secret' }), { PATH: '/bin', HOME: '/home' });
  const thread = codexThreadOptions(s); assert.equal(thread.approvalPolicy, 'untrusted'); assert.equal(thread.approvalsReviewer, 'user'); assert.equal(thread.config.features.multi_agent, false); assert.equal(thread.config.agents.enabled, false); assert.deepEqual(thread.config.mcp_servers, {});
  const turn = codexTurnOptions(s, 'test'); assert.equal(turn.permissions, WRITE_PROFILE); assert.equal(turn.sandboxPolicy, undefined); assert.equal(thread.sandbox, undefined); assert.equal(thread.permissions, WRITE_PROFILE);
  assert.equal(thread.config.permissions[WRITE_PROFILE].network.enabled, false); assert.equal(thread.config.permissions[WRITE_PROFILE].filesystem[s.input.context.cwd], 'write');
  const sdk = claudeOptions(s, null, {}, () => {}); assert.deepEqual(sdk.mcpServers, {}); assert.deepEqual(sdk.settingSources, []); assert.equal(sdk.allowedTools, undefined); assert.equal(sdk.permissionMode, 'default'); assert.equal(sdk.permissionPrompts, 'host'); assert.ok(!sdk.tools.includes('Agent')); assert.ok(sdk.disallowedTools.includes('Agent')); assert.equal(sdk.allowDangerouslySkipPermissions, undefined);
});
test('Codex request ID/type/turn/item correlation, exact replay, multi-question reply and secret rejection', async t => {
  const h = session(t); const q = question(); q.params.questions.push({ ...q.params.questions[0], id: 'q2', question: 'Another?' });
  decodeCodex(h.s, q); decodeCodex(h.s, q); assert.equal(h.events.filter(e => e.kind === 'blocked').length, 1);
  const blocked = h.s.pending; assert.match(readFileSync(h.input.context.resultPath, 'utf8'), /BLOCKED/);
  await h.s.reply('{"q1":["A"],"q2":["B"]}', blocked.id); assert.deepEqual(h.sent[0], { id: 'request', result: { answers: { q1: { answers: ['A'] }, q2: { answers: ['B'] } } } });
  await assert.rejects(h.s.reply('{"q1":["A"]}', blocked.id), /REQUEST_MISMATCH/);
  for (const override of [{ threadId: 'foreign' }, { turnId: 'old' }, { itemId: 'foreign' }, { questions: [{ ...q.params.questions[0], isSecret: true, question: 'SECRET-SENTINEL' }] }]) assert.throws(() => decodeCodex(h.s, question('different', override)));
  assert.ok(!JSON.stringify(h.events).includes('SECRET-SENTINEL'));
});
for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']) test(`Codex ${method}: denial is explicit; no session/network/amendment grant`, async t => {
  const h = session(t); decodeCodex(h.s, { id: 7, method, params: { threadId: 'thread', turnId: 'turn', itemId: 'item', kind: 'command', startedAtMs: 1, environmentId: null, cwd: h.input.context.cwd, permissions: {} } });
  const expanded = method.includes('/permissions/') ? 'deny' : 'decline'; await h.s.reply(expanded, h.s.pending.id);
  assert.deepEqual(h.sent[0].result, method.includes('/permissions/') ? { permissions: {}, scope: 'turn', strictAutoReview: true } : { decision: 'decline' });
  const other = session(t); decodeCodex(other.s, { id: 'grant', method, params: { threadId: 'thread', turnId: 'turn', itemId: 'item', kind: 'command', startedAtMs: 1, environmentId: null, cwd: other.input.context.cwd, permissions: {} } });
  await assert.rejects(other.s.reply('acceptForSession', other.s.pending.id), /APPROVAL_GRANT_UNSUPPORTED/); assert.equal(other.sent.length, 0);
});
for (const malformed of [
  { id: 'x', method: 'future/permission', params: { threadId: 'thread', turnId: 'turn', itemId: 'item' } },
  { method: 'thread/status/changed', params: { threadId: 'thread', status: { type: 'unknown' } } },
  { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { id: 'never-started', type: 'agentMessage', text: 'bad' } } },
  { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'unknown', items: [] } } },
]) test(`Codex rejects protocol drift ${malformed.method}`, t => {
  const h = session(t); h.s.guarded(() => decodeCodex(h.s, malformed)); assert.equal(h.recovery(), 1); assert.equal(h.sent.length, 0); assert.equal(h.events.filter(e => e.kind === 'settled').length, 0);
});
test('Claude duplicate permission identity, exact question update, nested/unknown/stale denial', async t => {
  const h = session(t, 'claude-code'); const options = permissionOptions();
  const first = claudePermission(h.s, 'AskUserQuestion', sdkQuestion, options); const second = claudePermission(h.s, 'AskUserQuestion', sdkQuestion, options); assert.equal(first, second);
  await h.s.reply('{"Choose?":"A, B"}', h.s.pending.id); const reply = await first; assert.equal(reply.behavior, 'allow'); assert.deepEqual(reply.updatedInput.answers, { 'Choose?': 'A, B' });
  for (const variant of [{ name: 'Agent' }, { name: 'Unknown' }, { name: 'AskUserQuestion', options: { agentID: 'child' } }, { name: 'AskUserQuestion', options: { signal: AbortSignal.abort() } }]) {
    const other = session(t, 'claude-code'); assert.equal((await claudePermission(other.s, variant.name, sdkQuestion, permissionOptions(variant.options))).behavior, 'deny'); assert.equal(other.recovery(), 1);
  }
});
for (const subtype of ['error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']) test(`Claude ${subtype} is failure only after authoritative idle, not process exit`, t => {
  const h = session(t, 'claude-code'); const event = claudeResult(h.s.id, h.s.inputUuid, subtype);
  decodeClaude(h.s, event); decodeClaude(h.s, event); assert.equal(h.events.length, 0);
  decodeClaude(h.s, { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'idle', session_id: h.s.id });
  assert.equal(h.events[0].data.status, 'failed'); assert.equal(h.events[0].data.verified, false); assert.ok(!JSON.stringify(h.events).includes('DO-NOT-ECHO-SECRET')); assert.equal(h.events.some(e => e.kind === 'process-exited'), false);
});
test('wire rejects unknown responses, oversized stderr/stdout, truncated/invalid lines without echo', t => {
  for (const kind of ['stdout', 'stderr', 'invalid', 'unknown-id', 'truncated']) {
    const h = session(t, 'codex', false, { bytes: 128, stderr: 64 }); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    const wire = new CodexWire(child, h.s); wire.onMessage = () => {};
    if (kind === 'stdout') child.stdout.write('x'.repeat(129));
    if (kind === 'stderr') child.stderr.write('secret'.repeat(12));
    if (kind === 'invalid') child.stdout.write('{invalid\n');
    if (kind === 'unknown-id') child.stdout.write('{"id":42,"result":{}}\n');
    if (kind === 'truncated') { child.stdout.write('{'); child.emit('exit', 1); }
    assert.equal(h.recovery(), 1, kind); assert.equal(h.events.length, 0);
  }
});
test('read-only roles never receive native write policy', t => {
  const { s } = session(t); s.writer = false;
  assert.equal(codexThreadOptions(s).permissions, READ_PROFILE); assert.equal(codexTurnOptions(s, 'test').permissions, READ_PROFILE); assert.equal(codexTurnOptions(s, 'test').sandboxPolicy, undefined);
  assert.deepEqual(claudeOptions(s, null, {}, () => {}).tools, ['Read', 'Glob', 'Grep', 'AskUserQuestion']);
});
test('Claude file approval binds exact input, rechecks symlinks, rejects outside paths and stale result UUID', async t => {
  const h = session(t, 'claude-code'); const input = { file_path: join(h.input.context.cwd, 'one.txt'), content: 'bounded file' };
  const promise = claudePermission(h.s, 'Write', input, permissionOptions()); await h.s.reply('allow', h.s.pending.id);
  const answer = await promise; assert.deepEqual(answer, { behavior: 'allow', updatedInput: input, toolUseID: 'tool' }); assert.equal(answer.updatedPermissions, undefined);
  const changed = session(t, 'claude-code'); const target = join(changed.input.context.cwd, 'target'); writeFileSync(target, 'a');
  claudePermission(changed.s, 'Edit', { file_path: target, old_string: 'a', new_string: 'b' }, permissionOptions());
  rmSync(target); symlinkSync('/nonexistent', target); await assert.rejects(changed.s.reply('allow', changed.s.pending.id), /TOOL_PATH_FORBIDDEN/);
  const outside = session(t, 'claude-code'); assert.equal((await claudePermission(outside.s, 'Write', { file_path: '/elsewhere', content: '' }, permissionOptions())).behavior, 'deny'); assert.equal(outside.recovery(), 1);
  const stale = session(t, 'claude-code'); assert.throws(() => decodeClaude(stale.s, claudeResult(stale.s.id, 'stale-uuid')), /RESULT_TURN_MISMATCH/);
});
test('Codex exact duplicate terminal has no duplicate effect; conflicting terminal and inherited config reject', t => {
  const h = session(t); const terminal = { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } } };
  decodeCodex(h.s, terminal); decodeCodex(h.s, terminal); assert.equal(h.events.filter(e => e.kind === 'settled').length, 1);
  assert.throws(() => decodeCodex(h.s, { ...terminal, params: { ...terminal.params, threadId: 'foreign' } }), /EVENT_REUSE/);
  const home = h.input.context.artifactDirectory; codexIsolatedConfig(home, h.input.context.cwd);
  writeFileSync(join(home, 'config.toml'), ''); assert.throws(() => codexIsolatedConfig(home, h.input.context.cwd), /CODEX_CONFIG_NOT_ISOLATED/); rmSync(join(home, 'config.toml'));
  symlinkSync('/nonexistent', join(h.input.context.cwd, '.codex')); assert.throws(() => codexIsolatedConfig(home, h.input.context.cwd), /CODEX_CONFIG_NOT_ISOLATED/);
});
test('version mismatch and arbitrary stored handle fail before any native effect', async t => {
  const h = session(t); let spawned = 0;
  const codex = createCodexAdapter({ probe() { throw new Error('version mismatch'); }, spawnProcess() { spawned++; } });
  await assert.rejects(codex.execute({ ...h.input, effect: { ...h.input.effect, op: 'node.launch' } })); assert.equal(spawned, 0);
  const claude = createClaudeAdapter({ load: async () => ({ version: 'future', cliVersion: '2.1.263', query() { spawned++; } }) });
  await assert.rejects(claude.execute({ ...h.input, effect: { ...h.input.effect, op: 'node.launch' } })); assert.equal(spawned, 0);
  for (const adapter of [codex, claude]) await assert.rejects(adapter.execute({ ...h.input, handle: { id: 'unowned' }, effect: { ...h.input.effect, op: 'node.resume' } }));
});

test('N2 SDK PreToolUse guards default-permitted tools independently of canUseTool and session/role widening', async t => {
  for (const root of [false, true]) {
    const h = session(t, 'claude-code', root); const cwd = h.input.context.cwd; writeFileSync(join(cwd, 'input.txt'), 'task');
    const options = claudeOptions(h.s, null, {}, () => {}); const matchers = options.hooks.PreToolUse;
    assert.equal(matchers.length, 1); assert.equal(matchers[0].matcher, undefined); // every tool, not only permission prompts
    const hook = matchers[0].hooks[0];
    const call = (tool_name, tool_input, extra = {}, signal = new AbortController().signal) => hook({ hook_event_name: 'PreToolUse', session_id: h.s.id, cwd, tool_name, tool_input, ...extra }, 'tool', { signal });
    for (const [name, input] of [['Read', { file_path: join(cwd, 'input.txt') }], ['Glob', { pattern: '*.txt' }], ['Grep', { pattern: 'task' }], ['AskUserQuestion', sdkQuestion]]) assert.deepEqual(await call(name, input), { continue: true });
    for (const [name, input] of [['Read', { file_path: join(h.input.context.artifactDirectory, 'result.md') }], ['Glob', { pattern: '../*' }], ['Grep', { pattern: 'x', paths: [cwd] }], ['Unknown', {}], ['Bash', { command: 'anything' }]]) assert.equal((await call(name, input)).hookSpecificOutput.permissionDecision, 'deny');
    const write = await call('Write', { file_path: join(cwd, 'new.txt'), content: 'task' }); assert.equal(write.continue === true, !root);
    assert.equal((await call('Read', { file_path: join(cwd, 'input.txt') }, { session_id: 'foreign' })).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await call('Read', { file_path: join(cwd, 'input.txt') }, {}, AbortSignal.abort())).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await call('Read', { file_path: join(cwd, 'input.txt') }, { agent_id: 'child' })).hookSpecificOutput.permissionDecision, 'deny');
    h.s.active = false; assert.equal((await call('Read', { file_path: join(cwd, 'input.txt') })).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(h.s.permissionPromises.size, 0); assert.equal(h.events.length, 0); // canUseTool was never called
  }
});

test('N1 changed active Codex profile fails before turn submission and disabled remote control is explicit', async t => {
  const h = session(t); const home = join(h.input.context.artifactDirectory, '../home'); mkdirSync(home, { mode: 0o700 });
  const methods = []; let killed = false;
  const adapter = createCodexAdapter({ probe: () => {}, env: { HOME: home, CODEX_HOME: home }, spawnProcess(_cmd, args) {
    const config = {}; for (let i = 0; i < args.length; i++) if (args[i] === '-c') { const value = args[++i]; const split = value.indexOf('='); config[value.slice(0, split)] = JSON.parse(value.slice(split + 1).replace(/("(?:\\.|[^"\\])*")\s*=/g, '$1:')); }
    const child = new EventEmitter(); child.pid = 12345; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { killed = true; return true; };
    child.stdin.on('data', data => { const request = JSON.parse(data); methods.push(request.method); if (request.method === 'initialized') return;
      const result = request.method === 'initialize' ? { userAgent: 'codex-cli/0.153.4' } : request.method === 'config/read' ? { config } : { ...codexStart(h.input.context.cwd, 'fixture'), activePermissionProfile: { id: 'foreign', extends: null } };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'));
    }); return child;
  } });
  await assert.rejects(adapter.execute({ ...h.input, effect: { ...h.input.effect, op: 'node.launch' } })); assert.ok(methods.includes('thread/start')); assert.ok(!methods.includes('turn/start')); assert.equal(killed, true);
  decodeCodex(h.s, { method: 'remoteControl/status/changed', params: { status: 'disabled' } });
  assert.throws(() => decodeCodex(h.s, { method: 'remoteControl/status/changed', params: { status: 'enabled' } }), /REMOTE_CONTROL_FORBIDDEN/);
});

test('N2 missing native hook-registration receipt refuses before any prompt delivery', async t => {
  const h = session(t, 'claude-code'); const home = join(h.input.context.artifactDirectory, '../home'); mkdirSync(home, { mode: 0o700 });
  let queue; let closed = false;
  const adapter = createClaudeAdapter({ env: { HOME: home, CLAUDE_CONFIG_DIR: home }, load: async () => ({ version: '0.3.263', cliVersion: '2.1.263', query({ prompt }) {
    queue = prompt; return { initializationResult: async () => ({ hooks_applied: false }), close() { closed = true; } };
  } }) });
  await assert.rejects(adapter.execute({ ...h.input, effect: { ...h.input.effect, op: 'node.launch' } }));
  assert.equal(queue.values.length, 0); assert.equal(closed, true); assert.equal(h.events.some(event => event.kind === 'settled'), false);
});
