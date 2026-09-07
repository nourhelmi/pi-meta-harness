import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { hostPiDetach } from '../../scripts/advisor-runtime/pi-detach-host.mjs';
import { callSocket, readCredential } from '../../scripts/advisor-runtime/service.mjs';
import { createPiDetachClient } from '../../scripts/advisor-runtime/pi-detach-client.mjs';

const detach = process.env.PI_DETACH_TEST_PACKAGE;
assert.ok(detach, 'PI_DETACH_TEST_PACKAGE must identify the owned detach revision');
const portModule = await import(pathToFileURL(join(detach, 'src/execution-port.ts')).href);
const { createPaneManager } = await import(pathToFileURL(join(detach, 'src/herdr/panes.ts')).href);
const { registerBgAgentTool, BgAgentParameters } = await import(pathToFileURL(join(detach, 'src/tools/bg-agent.ts')).href);
const { registerBgStopTool } = await import(pathToFileURL(join(detach, 'src/tools/bg-stop.ts')).href);
const { registerBgListTool } = await import(pathToFileURL(join(detach, 'src/tools/bg-list.ts')).href);
const { registerBgOutputTool } = await import(pathToFileURL(join(detach, 'src/tools/bg-output.ts')).href);
const phase = process.env.BRIDGE_PHASE;
if (!phase) {
 const root = realpathSync(mkdtempSync('/tmp/pibr-'));
 mkdirSync(join(root, 'work'), { mode: 0o700 });
 for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], ['worktree', 'add', '--detach', join(root, 'registered')]]) {
  const git = spawnSync('git', ['-C', join(root, 'work'), ...args], { encoding: 'utf8' }); assert.equal(git.status, 0, git.stderr);
 }
 symlinkSync(root, join(root, 'work', 'outside-alias'));

 for (const next of ['exercise', 'restart']) {
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, BRIDGE_PHASE: next, BRIDGE_ROOT: root }, encoding: 'utf8', timeout: 30000 });
  process.stdout.write(child.stdout); process.stderr.write(child.stderr);
  assert.equal(child.status, 0, `${next} process failed`);
 }
 console.log('PASS: actual process death/restart retains recovery-required; no relaunch');
 process.exit(0);
}
const root = process.env.BRIDGE_ROOT!;
const stateRoot = join(root, 'state'); const cwd = join(root, 'work');
const descriptor = join(root, 'pi.json');
const profile = join(root, 'profiles.json');
writeFileSync(profile, JSON.stringify({ defaultAgent: 'pi', profiles: { foreman: { agent: 'pi', cliArgs: ['--advisor-worker-allow-subagents'], maxTurns: 6 }, reviewer: { agent: 'pi', skill: 'role-reviewer', maxTurns: 4, requireAnchor: true, resultDiscovery: 'advisor-worker' } } }));
process.env.PI_DETACH_AGENT_PROFILES = profile;
process.env.PI_DETACH_RUNTIME_BRIDGE = resolve('scripts/advisor-runtime/pi-detach-client.mjs');
process.env.ADVISOR_RUNTIME_DESCRIPTOR = descriptor;
const calls: string[][] = [];
let counter = 1;
let failPrompt = false;
let stallPrompt = false;
let fastPrompt = false;
let failSplit = false;
const occupants = new Map<string, any>();
const waits: any[] = [];
const ok = (json: unknown, stdout = '') => ({ ok: true, code: 0, json, stdout, stderr: '' });
const dbRows = (table: string) => { const db = new DatabaseSync(join(stateRoot, 'runtime.sqlite'), { readOnly: true }); try { return db.prepare(`SELECT * FROM ${table}`).all() as any[]; } finally { db.close(); } };
const cli = {
 async exec(args: string[]) {
  calls.push(args);
  if (args[0] === 'pane' && args[1] === 'split') {
   const claimed = dbRows('effects').filter(row => row.state === 'claimed');
   assert.ok(claimed.length, 'claimed outbox before pane acquisition');
   const receipts = dbRows('receipts');
   assert.ok(claimed.every(row => receipts.some(receipt => receipt.id === JSON.parse(row.data).commandId)), 'receipt committed before acquisition');
   if (failSplit) { failSplit = false; return { ok: false, code: 1, stdout: "", stderr: "", errorCode: "timeout" }; }
   return ok({ pane_id: `w1:p${++counter}` });
  }
  if (args[1] === 'process-info') return ok({ result: { process_info: { foreground_processes: [{ name: 'zsh' }] } } });
  if (args[1] === 'start') {
   const pane = args[args.indexOf('--pane') + 1];
   occupants.set(pane, { pane_id: pane, name: args[2], agent_session: { source: "fixture", agent: "pi", kind: "id", value: `session-${counter}` }, state_change_seq: 1, status: 'idle' });
   return ok(occupants.get(pane));
  }
  if (args[0] === 'agent' && args[1] === 'get') return ok(occupants.get(args[2]));
  if (args[1] === 'prompt') {
   const occupant = occupants.get(args[2]);
   const recordedEffect = dbRows('effects').find(row => row.handle && JSON.parse(row.handle).id.includes(occupant.agent_session.value));
   assert.ok(recordedEffect, 'qualified handle committed before first prompt');
   if (stallPrompt) { stallPrompt = false; return { ok: false, code: 1, stdout: '', stderr: '', errorCode: 'agent_prompt_stalled' }; }
   if (failPrompt) { failPrompt = false; occupant.status = 'working'; occupant.state_change_seq += 1; return { ok: false, code: 1, stdout: '', stderr: '', errorCode: 'timeout' }; }
   // Real Herdr without --wait only acknowledges submission: the old startup
   // idle snapshot can still satisfy an immediately registered settlement wait.
   const nextState = fastPrompt ? 'done' : 'working'; fastPrompt = false;
   const started = new Promise<void>(resolveStarted => setImmediate(() => {
    if (nextState === 'done') {
     const source = JSON.parse(recordedEffect.data).payload.packet.execution.sourceDirectory;
     writeFileSync(join(source, 'result.md'), '# Status\nPASS\nFast post-submission completion.');
    }
    occupant.status = nextState; occupant.state_change_seq += nextState === 'done' ? 2 : 1; resolveStarted();
   }));
   if (args.includes('--wait')) {
    await started;
    const states = args.filter((_, i) => args[i - 1] === '--until');
    if (!states.includes(nextState)) return { ok: false, code: 1, stdout: '', stderr: '', errorCode: 'timeout' };
    assert.equal(args[args.indexOf('--timeout') + 1], '5000', 'transition gate stays inside existing prompt budget');
   }
   return ok(occupant);
  }
  if (args[1] === 'read') return ok({}, 'captured deterministic output');
  return ok({});
 },
 spawnWaiter(args: string[]) {
  let done: (value: unknown) => void = () => {};
  const promise = new Promise(resolve => { done = resolve; });
  const waiter = { args, promise, kill() {}, resolve: done }; waits.push(waiter);
  const occupant = occupants.get(args[2]);
  if (occupant?.status === args[4]) done(ok({ ...occupant }));
  return waiter;
 },
};
const port = portModule.createAgentExecutionPort({ cli, ctx: { paneId: 'w1:p1' }, panes: createPaneManager(cli, { paneId: 'w1:p1' }), env: { PI_DETACH_AGENT_PROFILES: profile, PATH: process.env.PATH } });
const { runtime, service } = await hostPiDetach({ stateRoot, cwd, sessionId: 'owning-pi-session', credentialPath: descriptor, port, slots: 1, managedIdentity: { fixture: true }, maxLaunches: 64 });
const client = createPiDetachClient(descriptor);
const req = (action: string, payload: object) => client.request('owning-pi-session', action, payload);
if (phase === 'restart') {
 const runs: any = await req('list', {});
 assert.ok(runs.some((row: any) => row.node?.runtimeState === 'recovery-required'));
 await runtime.dispatch();
 assert.equal(calls.filter(args => ['split', 'start', 'prompt'].includes(args[1])).length, 0);
 console.log('PASS: restart recovery from prior process SQLite/lock boundary');
 process.exit(0);
}
const tools = new Map<string, any>();
const pi = { registerTool(tool: any) { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool); } };
const registry = { start() { throw new Error('LEGACY_FALLBACK'); }, get() { return undefined; }, list() { return []; }, stop() { throw new Error('LEGACY_STOP'); } };
for (const register of [registerBgAgentTool, registerBgStopTool, registerBgListTool, registerBgOutputTool]) register(pi, registry);
const ctx = { cwd, sessionManager: { getSessionId() { return 'owning-pi-session'; } } };
const invoke = (name: string, id: string, params: object, context = ctx) => tools.get(name).execute(id, params, undefined, undefined, context);
const params = { role: 'reviewer', prompt: 'Bounded deterministic task', model: 'openai/example', thinking: 'high', maxTurns: 7, requiredSkills: ['pi-lens-lsp-navigation'], acceptance: ['one prompt'], keepAlive: true, promoteAfterMs: 0 };
const launched = await invoke('bg_agent', 'actual-tool-call', params);
const runId = launched.details.runId;
assert.equal(launched.details.reusable, true, 'keepAlive intent remains visible through the public bridge result');
await runtime.dispatch();
await new Promise(resolveTurn => setImmediate(resolveTurn));
assert.equal((await req('get', { runId }) as any).runtimeState, 'running', 'submission ACK must not let startup idle end observation');
assert.match((await invoke('bg_output', 'running-output', { runId })).content[0].text, /captured deterministic output/);
assert.equal((await invoke('bg_list', 'running-list', {})).details.runs.find((r: any) => r.id === runId).status, 'running');
assert.ok(runId.startsWith('pib-'));
assert.equal(calls.filter(args => args[1] === 'prompt').length, 1);
const before = JSON.stringify(calls);
const replay = await invoke('bg_agent', 'actual-tool-call', params);
assert.deepEqual(replay, launched, 'exact public replay is the durable prior tool outcome');
assert.equal(JSON.stringify(calls), before);
await assert.rejects(invoke('bg_agent', 'actual-tool-call', { ...params, prompt: 'changed' }), /COMMAND_ID_REUSE/);
await assert.rejects(invoke('bg_agent', 'foreign', params, { ...ctx, sessionManager: { getSessionId() { return 'foreign'; } } }), /SESSION_MISMATCH/);
await assert.rejects(invoke('bg_agent', 'custom-path', { ...params, resultPath: '/arbitrary' }));
await assert.rejects(invoke('bg_agent', 'wrong-cwd', { ...params, cwd: root }));
await assert.rejects(invoke('bg_agent', 'takeover', { name: 'unowned-live-agent', prompt: 'wrong' }), /TARGET_FORBIDDEN/);
await assert.rejects(invoke('bg_agent', 'busy', { name: runId, prompt: 'steer' }), /UNSUPPORTED/);
const node: any = await req('get', { runId });
const intent = node.packet.execution;
assert.equal(intent.maxTurns, 7); assert.equal(intent.model, params.model); assert.equal(intent.thinking, 'high');
assert.deepEqual(intent.requiredSkills, params.requiredSkills); assert.equal(intent.keepAlive, true);
assert.equal(intent.resultDiscovery, 'advisor-worker'); assert.match(intent.prompt, /TURN CAP: 7/);
assert.match(intent.command, /--provider openai --model example --thinking high/);
assert.equal(intent.resultPolicy, 'runtime-capture');
assert.equal(intent.environment.PI_DETACH_AGENT_PROFILES, profile);
assert.equal(intent.environment.ADVISOR_RUNTIME_DESCRIPTOR, '');
assert.equal(intent.environment.ADVISOR_BRIDGE_WORKER_DIR, intent.sourceDirectory);
console.log('PASS: real facade/core/outbox/port; receipt and handle ordering; replay/authority/intent fidelity');
async function settle(runId: string, markdown: string | null) {
 const node: any = await req('get', { runId });
 if (markdown !== null) writeFileSync(join(node.packet.execution.sourceDirectory, 'result.md'), markdown, { mode: 0o600 });
 const pane = JSON.parse(node.handle.id)[0];
 const occupant = occupants.get(pane); occupant.status = 'done'; occupant.state_change_seq += 1;
 const waiter = waits.findLast(w => w.args[2] === pane && w.args[4] === 'done'); assert.ok(waiter); waiter.resolve(ok(occupant));
 for (let i = 0; i < 30; i++) { await new Promise(resolve => setTimeout(resolve, 10)); const next: any = await req('get', { runId }); if (next.snapshot.state !== 'running') return next; }
 throw new Error('settlement not observed');
}
let blocked = await settle(runId, '# Status\nBLOCKED\nNeed a decision.');
assert.equal(blocked.status, 'blocked');
const beforeReplyRejection = calls.length;
await assert.rejects(invoke('bg_agent', 'changed-reply-keepalive', { name: runId, prompt: 'same task', keepAlive: false }), /INTENT_CHANGE_UNSUPPORTED/);
assert.equal(calls.length, beforeReplyRejection);
const priorHarness = process.env.PI_DETACH_WORKER_HARNESS;
process.env.PI_DETACH_WORKER_HARNESS = 'native';
const reply = { name: runId, prompt: 'Use option A', keepAlive: true, promoteAfterMs: 0 };
await invoke('bg_agent', 'actual-reply-call', reply); await runtime.dispatch();
assert.equal(calls.filter(args => args[1] === 'prompt').length, 2);
await assert.rejects(invoke('bg_agent', 'actual-reply-call', { ...reply, prompt: 'Changed reply body' }), /COMMAND_ID_REUSE/);
assert.equal(readFileSync(join(blocked.packet.execution.sourceDirectory, 'result.md'), 'utf8'), '', 'reply invalidates the prior attempt result before prompting');
await invoke('bg_agent', 'actual-reply-call', reply); await runtime.dispatch();
assert.equal(calls.filter(args => args[1] === 'prompt').length, 2);
if (priorHarness === undefined) delete process.env.PI_DETACH_WORKER_HARNESS; else process.env.PI_DETACH_WORKER_HARNESS = priorHarness;
console.log('PASS: BLOCKED replies preserve admitted keepAlive and ignore changed root harness defaults');
const done = await settle(runId, '# Status\nPASS\n\n# Claims\nDeterministic bytes.');
assert.equal(done.status, 'done'); assert.equal(done.verified, false);
const unacked: any = await req('wait', { runId });
const reconnected = createPiDetachClient(descriptor);
assert.deepEqual(await reconnected.request('owning-pi-session', 'wait', { runId }), unacked);
for (const d of unacked) await req('ack', { runId, deliveryId: d.id });
assert.deepEqual(await req('wait', { runId }), []);
assert.match((await invoke('bg_output', 'output', { runId })).content[0].text, /captured deterministic output/);
assert.match((await invoke('bg_list', 'list', {})).content[0].text, new RegExp(runId));
const handleBeforeTask = done.handle;
const taskCommand = { v: 1, op: 'node.task', scope: done.snapshot.scope, commandId: 'task-negative', expectedRevision: done.revision, payload: { attempt: done.snapshot.attempt, handleId: done.handle.id, generation: done.executionObservation.generation, text: 'Bounded task' } };
const effectsBeforeTaskNegatives = dbRows('effects').length;
for (const command of [
 { ...taskCommand, expectedRevision: done.revision - 1 },
 { ...taskCommand, payload: { ...taskCommand.payload, attempt: 99 } },
 { ...taskCommand, payload: { ...taskCommand.payload, generation: 99 } },
 { ...taskCommand, payload: { ...taskCommand.payload, handleId: 'foreign-handle' } },
 { ...taskCommand, scope: { ...taskCommand.scope, ownerEpoch: 99 } },
 { ...taskCommand, scope: { ...taskCommand.scope, node: 'invented-node' } },
 { ...taskCommand, payload: { ...taskCommand.payload, requestId: 'fabricated-block' } },
]) assert.equal((await callSocket(readCredential(descriptor), command, 'model') as any).ok, false);
assert.equal(dbRows('effects').length, effectsBeforeTaskNegatives, 'revision/attempt/generation/handle/epoch/node/request negatives produce no effect');
await invoke('bg_agent', 'terminal-followup', { name: runId, prompt: 'Bounded repair: verify the second artifact', promoteAfterMs: 0 }); await runtime.dispatch();
const followup: any = await req('get', { runId });
assert.deepEqual(followup.handle, handleBeforeTask);
assert.equal(followup.snapshot.attempt, done.snapshot.attempt + 1);
assert.equal(readFileSync(join(intent.sourceDirectory, 'result.md'), 'utf8'), '');
assert.equal((await settle(runId, '# Status\nPASS\nFresh bounded repair.')).status, 'done');

for (const [status, artifact] of [['stalled', null], ['stalled', ''], ['stalled', '# Status\nIN PROGRESS'], ['failed', '# Status\nFAIL']] as const) {
 const result = await invoke('bg_agent', `artifact-${status}-${String(artifact).length}`, params); await runtime.dispatch();
 assert.equal((await settle(result.details.runId, artifact)).status, status);
}
const unique = new Set<string>();
for (let i = 0; i < 33; i++) {
 const launched = await invoke('bg_agent', `breadth-${i}`, { prompt: 'Bounded plain Pi task', cwd: i % 2 ? join(root, 'registered') : cwd, promoteAfterMs: 0 });
 assert.ok(!unique.has(launched.details.runId)); unique.add(launched.details.runId); await runtime.dispatch();
 const fresh: any = await req('get', { runId: launched.details.runId });
 assert.equal(fresh.packet.execution.command, 'pi');
 assert.equal(fresh.packet.cwd, i % 2 ? join(root, 'registered') : cwd);
 assert.equal((await settle(launched.details.runId, '# Status\nPASS\nUnique bounded launch.')).status, 'done');
}
await assert.rejects(invoke('bg_agent', 'unauthorized-alias', { ...params, cwd: join(cwd, 'outside-alias') }), /FORBIDDEN/);
assert.equal(unique.size, 33);
const terminalTarget = [...unique][0];
const terminalNode: any = await req('get', { runId: terminalTarget });
// Freeform launches are not kept by default; terminal task must reject them.
await assert.rejects(invoke('bg_agent', 'not-kept-task', { name: terminalTarget, prompt: 'No implicit keepAlive' }), /UNSUPPORTED/);
const staleTerminal: any = await req('get', { runId });
occupants.get(JSON.parse(staleTerminal.handle.id)[0]).state_change_seq += 2;
const promptsBeforeTerminalTask = calls.filter(a => a[1] === 'prompt').length;
await invoke('bg_agent', 'stale-terminal-task', { name: runId, prompt: 'Reject changed terminal generation', promoteAfterMs: 0 }); await runtime.dispatch();
assert.equal(calls.filter(a => a[1] === 'prompt').length, promptsBeforeTerminalTask);
assert.equal((await req('get', { runId }) as any).runtimeState, 'recovery-required');
console.log('PASS: 33 sequential unique exact scopes; own cwd and registered Git worktree; unrelated alias rejection');
const foreman = await invoke('bg_agent', 'foreman-supervision', { role: 'foreman', prompt: 'Integrate own visible child', keepAlive: true, promoteAfterMs: 0 }); await runtime.dispatch();
const parentNode: any = await req('get', { runId: foreman.details.runId });
const childState = parentNode.packet.execution.environment.ADVISOR_BRIDGE_CHILD_STATE;
assert.ok(childState && !childState.startsWith(parentNode.packet.execution.sourceDirectory));
const parentPane = JSON.parse(parentNode.handle.id)[0];
writeFileSync(join(parentNode.packet.execution.sourceDirectory, 'result.md'), '# Status\nPASS\nOld premature parent bytes.');
const parentOccupant = occupants.get(parentPane); parentOccupant.status = 'done'; parentOccupant.state_change_seq += 1;
waits.findLast(w => w.args[2] === parentPane && w.args[4] === 'done').resolve(ok(parentOccupant));
await new Promise(r => setTimeout(r, 300));
assert.equal((await req('get', { runId: foreman.details.runId }) as any).snapshot.state, 'running', 'indeterminate child service cannot settle parent from old PASS');
let childHooks: any;
const childPort = { version: 1, prepare: port.prepare, async launch({ hooks }: any) { childHooks = hooks; hooks.recordHandle({ id: 'owned-child', session: 'child-session' }); return { interrupt() {}, readLive: async () => 'child running' }; } };
const childHost = await hostPiDetach({ stateRoot: childState, cwd, sessionId: 'child-session', credentialPath: join(childState, 'pi.json'), port: childPort, slots: 1 });
const childClient = createPiDetachClient(join(childState, 'pi.json'));
const childRequest = (action: string, payload: object) => childClient.request('child-session', action, payload);
const childLaunch: any = await childRequest('call', { tool: 'bg_agent', toolCallId: 'child-tool', cwd, params: { prompt: 'Bounded child task' } }); await childHost.runtime.dispatch();
writeFileSync(join(childState, 'startup.json'), JSON.stringify({ identity: { sessionId: 'child-session' } }), { mode: 0o600 });
await new Promise(r => setTimeout(r, 300));
assert.equal((await req('get', { runId: foreman.details.runId }) as any).snapshot.state, 'running', 'live child keeps same parent supervisor');
const childNode: any = await childRequest('get', { runId: childLaunch.runId });
writeFileSync(join(childNode.packet.execution.sourceDirectory, 'result.md'), '# Status\nPASS\nFresh child bytes.');
childHooks.settled('done', 'child output', 2);
await new Promise(r => setTimeout(r, 300));
assert.equal((await req('get', { runId: foreman.details.runId }) as any).snapshot.state, 'running', 'child completion cannot reuse the old parent turn');
writeFileSync(join(parentNode.packet.execution.sourceDirectory, 'result.md'), '# Status\nPASS\nFresh integrated parent result.');
parentOccupant.state_change_seq += 2;
for (let i = 0; i < 100; i++) { if ((await req('get', { runId: foreman.details.runId }) as any).snapshot.state === 'terminal') break; await new Promise(r => setTimeout(r, 10)); }
assert.equal((await req('get', { runId: foreman.details.runId }) as any).status, 'done');
for (const d of await childRequest('wait', { runId: childLaunch.runId }) as any[]) await childRequest('ack', { runId: childLaunch.runId, deliveryId: d.id });
await childHost.service.close();
console.log('PASS: separate child service; indeterminate/live child cannot settle foreman; terminal child permits parent delivery');
const unavailableBefore = calls.length;
const savedDescriptor = process.env.ADVISOR_RUNTIME_DESCRIPTOR;
process.env.ADVISOR_RUNTIME_DESCRIPTOR = join(root, 'absent.json');
await assert.rejects(invoke('bg_agent', 'unavailable', params), /UNAVAILABLE/);
process.env.ADVISOR_RUNTIME_DESCRIPTOR = savedDescriptor;
const clientModule = process.env.PI_DETACH_RUNTIME_BRIDGE;
writeFileSync(join(root, 'incompatible.mjs'), 'export const PI_DETACH_CLIENT_VERSION = 99;');
process.env.PI_DETACH_RUNTIME_BRIDGE = join(root, 'incompatible.mjs');
await assert.rejects(invoke('bg_agent', 'incompatible', params), /VERSION/);
process.env.PI_DETACH_RUNTIME_BRIDGE = clientModule;
assert.equal(calls.length, unavailableBefore, 'unavailable/incompatible bridges have zero Herdr effects');
await assert.rejects(hostPiDetach({ stateRoot: join(root, 'invalid-port'), cwd, sessionId: 'x', credentialPath: join(root, 'invalid.json'), port: { version: 99 } }), /PORT_VERSION/);
const concurrent = await Promise.all([invoke('bg_agent', 'concurrent-one', params), invoke('bg_agent', 'concurrent-two', params)]);
await runtime.dispatch();
assert.notEqual(concurrent[0].details.runId, concurrent[1].details.runId);
for (const result of concurrent) await settle(result.details.runId, '# Status\nPASS');
fastPrompt = true;
const native = await invoke('bg_agent', 'native-fidelity', { ...params, harness: 'native', model: 'openai-codex/example', thinking: 'low', keepAlive: false }); await runtime.dispatch();
await new Promise(resolveTurn => setImmediate(resolveTurn));
const nativeNode: any = await req('get', { runId: native.details.runId });
assert.equal(nativeNode.packet.execution.harness, 'native'); assert.equal(nativeNode.packet.execution.keepAlive, false);
assert.match(nativeNode.packet.execution.command, /^codex --model example -c model_reasoning_effort=low/);
assert.equal(nativeNode.status, 'done', 'fast post-submission completion is captured without requiring a later working state');
const beforeClosedTask = calls.length;
await assert.rejects(invoke('bg_agent', 'closed-task', { name: native.details.runId, prompt: 'Must not reuse a closed worker' }), /UNSUPPORTED/);
assert.equal(calls.length, beforeClosedTask);
assert.ok(calls.some(args => args[0] === 'pane' && args[1] === 'close'), 'keepAlive false closes only after validated settlement');
const credentialRun = (await invoke('bg_agent', 'credential-launch', params)).details.runId; await runtime.dispatch();
const credentialNode: any = await req('get', { runId: credentialRun });
writeFileSync(join(stateRoot, 'runs', credentialRun, 'worker', 'result.md'), '# Status\nBLOCKED');
const credentialEffect = dbRows('effects').find(row => row.run === credentialRun);
(runtime as any).ingest(credentialEffect.id, { id: 'fixture-credential-request', kind: 'blocked', attempt: 1, data: { requestId: 'credential-request', kind: 'credential', text: 'Out of band login required' } });
const credentialBefore = calls.length;
await assert.rejects(invoke('bg_agent', 'credential-reply', { name: credentialRun, prompt: 'fixture nonsecret reply' }), /CREDENTIAL_REPLY_FORBIDDEN/);
assert.equal(calls.length, credentialBefore);
const deliveryRun = (await invoke('bg_agent', 'delivery-launch', params)).details.runId; await runtime.dispatch();
for (const row of await req('list', {}) as any[]) if (row.node) for (const delivery of await req('wait', { runId: row.runId, timeoutMs: 0 }) as any[]) await req('ack', { runId: row.runId, deliveryId: delivery.id });
const { registerBridgeDelivery } = await import(pathToFileURL(join(detach, 'src/runtime-bridge.ts')).href);
function consumer() {
 const handlers = new Map<string, Function>(); const messages: any[] = []; const errors: string[] = [];
 registerBridgeDelivery({ on(name: string, handler: Function) { handlers.set(name, handler); }, sendMessage(message: any) { messages.push(message); handlers.get('session_shutdown')!(); } });
 const context = { ...ctx, isIdle: () => true, ui: { notify(message: string) { errors.push(message); } } };
 return { messages, errors, start() { handlers.get('session_start')!({}, context); }, stop() { handlers.get('session_shutdown')!(); } };
}
const oldConsumer = consumer(); oldConsumer.start(); oldConsumer.stop();
const newConsumer = consumer(); newConsumer.start();
await settle(deliveryRun, '# Status\nPASS');
for (let i = 0; i < 200 && !newConsumer.messages.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(oldConsumer.messages.length, 0); assert.deepEqual(newConsumer.errors, []);
assert.equal(newConsumer.messages[0]?.details.runId, deliveryRun);
const lostAck = consumer(); lostAck.start();
for (let i = 0; i < 200 && !lostAck.messages.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
assert.deepEqual(lostAck.messages[0]?.details, newConsumer.messages[0]?.details, 'reload before ack redelivers stable identity through actual delivery pump');
assert.deepEqual(lostAck.errors, []);
failPrompt = true;
const ambiguous = await invoke('bg_agent', 'ambiguous-launch', params); await runtime.dispatch();
assert.equal((await req('get', { runId: ambiguous.details.runId }) as any).runtimeState, 'recovery-required');
const ambiguousPrompts = calls.filter(args => args[1] === 'prompt').length;
await invoke('bg_agent', 'ambiguous-launch', params); await runtime.dispatch();
assert.equal(calls.filter(args => args[1] === 'prompt').length, ambiguousPrompts);
stallPrompt = true;
const noProgress = await invoke('bg_agent', 'no-progress-launch', params); await runtime.dispatch();
assert.equal((await req('get', { runId: noProgress.details.runId }) as any).runtimeState, 'recovery-required');
assert.equal(dbRows('events').filter(row => row.run === noProgress.details.runId).some(row => JSON.parse(row.data).type === 'node.settled'), false, 'no-progress prompt cannot fabricate settlement');
const noProgressPrompts = calls.filter(args => args[1] === 'prompt').length;
await invoke('bg_agent', 'no-progress-launch', params); await runtime.dispatch();
assert.equal(calls.filter(args => args[1] === 'prompt').length, noProgressPrompts, 'no-progress prompt never resends');
const stale = await invoke('bg_agent', 'stale-handle-launch', params); await runtime.dispatch();
const staleNode: any = await req('get', { runId: stale.details.runId });
const stalePane = JSON.parse(staleNode.handle.id)[0]; occupants.get(stalePane).state_change_seq = 0;
const keysBefore = calls.filter(args => args[1] === 'send-keys').length;
await invoke('bg_stop', 'stale-handle-stop', { runId: stale.details.runId }); await runtime.dispatch();
assert.equal(calls.filter(args => args[1] === 'send-keys').length, keysBefore);
assert.equal((await req('get', { runId: stale.details.runId }) as any).runtimeState, 'recovery-required');
const staleReply = await invoke('bg_agent', 'stale-reply-launch', params); await runtime.dispatch();
const blockedForReply = await settle(staleReply.details.runId, '# Status\nBLOCKED');
const replyPane = JSON.parse(blockedForReply.handle.id)[0];
assert.equal(blockedForReply.executionObservation.generation, occupants.get(replyPane).state_change_seq);
occupants.get(replyPane).state_change_seq += 2; // Another completed turn in the same native session.
const promptsBeforeStaleReply = calls.filter(args => args[1] === 'prompt').length;
await invoke('bg_agent', 'stale-reply-call', { name: staleReply.details.runId, prompt: 'old answer', promoteAfterMs: 0 }); await runtime.dispatch();
assert.equal(calls.filter(args => args[1] === 'prompt').length, promptsBeforeStaleReply);
assert.equal((await req('get', { runId: staleReply.details.runId }) as any).runtimeState, 'recovery-required');
console.log('PASS: real delivery pump reload/lost-ack identity; ambiguous prompt and stale-generation stop have no retry');
failSplit = true;
const splitsBeforeAmbiguity = calls.filter(args => args[1] === 'split').length;
const acquisition = await invoke('bg_agent', 'ambiguous-acquisition', params); await runtime.dispatch();
assert.equal(calls.filter(args => args[1] === 'split').length, splitsBeforeAmbiguity + 1, 'ambiguous split cannot enter legacy alternate-target retry');
assert.equal((await req('get', { runId: acquisition.details.runId }) as any).runtimeState, 'recovery-required');
console.log('PASS: unknown pane acquisition never retries an alternate split target');
const cancelRun = (await invoke('bg_agent', 'cancel-launch', params)).details.runId;
await runtime.dispatch();
const cancellation = await invoke('bg_stop', 'actual-stop-call', { runId: cancelRun }); await runtime.dispatch();
assert.equal(cancellation.details.stopped, false);
const cancel: any = await req('get', { runId: cancelRun });
assert.equal(cancel.snapshot.state, 'running'); assert.ok(cancel.snapshot.cancel); assert.equal(cancel.processExited, undefined);
assert.equal(calls.filter(args => args[1] === 'send-keys' && args[3] === 'esc').length, 1);
await invoke('bg_stop', 'actual-stop-call', { runId: cancelRun }); await runtime.dispatch();
assert.equal(calls.filter(args => args[1] === 'send-keys' && args[3] === 'esc').length, 1);
assert.equal(dbRows('events').some(row => JSON.parse(row.data).data?.status === 'cancelled'), false);
for (let i = 0; ; i++) {
 const count = (await req('list', {}) as any[]).length;
 if (count >= 64) break;
 const result = await invoke('bg_agent', `bound-${i}`, { prompt: 'Finite resource bound', promoteAfterMs: 0 }); await runtime.dispatch();
 await settle(result.details.runId, '# Status\nPASS');
}
const effectsAtBound = calls.filter(args => ['split', 'start', 'prompt'].includes(args[1])).length;
await assert.rejects(invoke('bg_agent', 'over-finite-bound', params), /LAUNCH_LIMIT/);
assert.equal(calls.filter(args => ['split', 'start', 'prompt'].includes(args[1])).length, effectsAtBound);
const foreignToken = runtime.registerPrincipal({ id: 'foreign-fixture', kind: 'advisor', scopes: [done.snapshot.scope].map(({ ownerEpoch, ...scope }: any) => scope), operations: ['node.task'] });
assert.equal((await callSocket({ ...readCredential(descriptor), token: foreignToken }, { v: 1, op: 'pi.detach', sessionId: 'owning-pi-session', action: 'list', payload: {} }, 'model') as any).ok, false);
runtime.revokePrincipal('foreign-fixture');
assert.equal((await callSocket({ ...readCredential(descriptor), token: foreignToken }, taskCommand, 'model') as any).error, 'UNAUTHORIZED');
console.log('PASS: captured result/BLOCKED reply/missing-blank-IN-PROGRESS-FAIL/cancel truth/list-output-stop/reconnect delivery');
// Explicit fixture process death: the next process proves recovery, not cleanup-as-cancel.
process.exit(0);
