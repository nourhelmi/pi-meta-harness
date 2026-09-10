// Real execution port + Herdr driver, deterministic transport only (no provider/process launch).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostPiDetach } from '../../scripts/advisor-runtime/pi-detach-host.mjs';
import { createPiDetachClient } from '../../scripts/advisor-runtime/pi-detach-client.mjs';
import { callSocket } from '../../scripts/advisor-runtime/service.mjs';
import { readChildScope } from '../../scripts/advisor-runtime/pi-detach-bootstrap.mjs';

const detach = process.env.PI_DETACH_TEST_PACKAGE!;
assert.ok(detach);
const { createAgentExecutionPort } = await import(pathToFileURL(join(detach, 'src/execution-port.ts')).href);
const { createPaneManager } = await import(pathToFileURL(join(detach, 'src/herdr/panes.ts')).href);
const base = realpathSync(mkdtempSync('/tmp/pirec-'));
const cwd = join(base, 'work'); mkdirSync(cwd, { mode: 0o700 });
const profile = join(base, 'profiles.json');
writeFileSync(profile, JSON.stringify({ defaultAgent: 'pi', profiles: { advisor: { agent: 'pi', cliArgs: ['--advisor-worker-allow-subagents'] }, specialist: { agent: 'pi' }, foreman: { agent: 'pi', cliArgs: ['--advisor-worker-allow-subagents'] } } }));
process.env.PI_DETACH_AGENT_PROFILES = profile;
delete process.env.PI_DETACH_WORKER_HARNESS;
let paneNumber = 0;
const services: any[] = [];
const ok = (json: unknown = {}, stdout = '') => ({ ok: true, code: 0, json, stdout, stderr: '' });
async function until(check: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 240; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(label);
}
async function start(stateRoot: string, sessionId: string, limit = 32) {
  const calls: string[][] = []; const occupants = new Map<string, any>(); const waits: any[] = [];
  const rows = (table: string) => { const db = new DatabaseSync(join(stateRoot, 'runtime.sqlite'), { readOnly: true }); try { return db.prepare(`SELECT * FROM ${table}`).all() as any[]; } finally { db.close(); } };
  const cli = {
    async exec(args: string[]) {
      calls.push(args);
      if (args[1] === 'split') {
        const effects = rows('effects').filter(row => row.state === 'claimed');
        assert.ok(effects.length, 'committed claim precedes visible pane acquisition');
        assert.ok(effects.every(row => rows('receipts').some(receipt => receipt.id === JSON.parse(row.data).commandId)));
        return ok({ pane_id: `w1:p${++paneNumber}` });
      }
      if (args[1] === 'process-info') return ok({ result: { process_info: { foreground_processes: [{ name: 'zsh', argv0: 'zsh' }] } } });
      if (args[1] === 'start') {
        const pane = args[args.indexOf('--pane') + 1];
        occupants.set(pane, { pane_id: pane, name: args[2], agent: 'pi', status: 'idle', state_change_seq: 1, agent_session: { source: 'fixture', agent: 'pi', kind: 'id', value: `session-${pane}` } });
        return ok({ result: { agent: occupants.get(pane) } });
      }
      if (args[1] === 'get') return ok({ result: { agent: occupants.get(args[2]) } });
      if (args[1] === 'prompt') {
        const occupant = occupants.get(args[2]);
        assert.ok(rows('effects').some(row => row.handle && JSON.parse(JSON.parse(row.handle).id)[0] === occupant.pane_id), 'handle committed before prompt');
        occupant.status = 'working'; occupant.state_change_seq++;
        return ok(occupant);
      }
      if (args[1] === 'read') return ok({}, 'bounded fixture output');
      return ok();
    },
    spawnWaiter(args: string[]) {
      let resolve!: (value: any) => void;
      const promise = new Promise(done => { resolve = done; });
      const waiter = { args, promise, resolve, kill() {} }; waits.push(waiter);
      const occupant = occupants.get(args[2]); if (occupant?.status === args[4]) resolve(ok(occupant));
      return waiter;
    },
  };
  const port = createAgentExecutionPort({ cli, ctx: { paneId: 'w1:p0' }, panes: createPaneManager(cli, { paneId: 'w1:p0' }), env: { PATH: process.env.PATH, PI_DETACH_AGENT_PROFILES: profile, ADVISOR_BRIDGE_CHILD_STATE: stateRoot } });
  const host = await hostPiDetach({ stateRoot, cwd, sessionId, credentialPath: join(stateRoot, 'pi.json'), port, managedIdentity: { fixture: true, workstream: 'recursive-fixture', workerHarness: 'native' }, maxLaunches: limit });
  writeFileSync(join(stateRoot, 'startup.json'), JSON.stringify({ identity: { sessionId } }), { mode: 0o600 });
  const client = createPiDetachClient(join(stateRoot, 'pi.json'));
  const request = (action: string, payload: any = {}) => client.request(sessionId, action, payload) as Promise<any>;
  const launched = async (key: string, role: string = 'advisor', prompt = 'Bounded visible work') => {
    const value = await request('call', { tool: 'bg_agent', toolCallId: key, cwd, params: { role, prompt, keepAlive: true } });
    await host.runtime.dispatch();
    const node = await request('get', { runId: value.runId });
    assert.notEqual(node.runtimeState, 'recovery-required', JSON.stringify({ calls, effects: rows('effects') })); assert.ok(node.handle);
    return node;
  };
  const observe = (node: any, status = 'done', body = '# Status\nPASS\n# Claims\nfixture') => {
    writeFileSync(join(node.packet.execution.sourceDirectory, 'result.md'), body);
    const pane = JSON.parse(node.handle.id)[0]; const occupant = occupants.get(pane);
    occupant.status = status; occupant.state_change_seq++;
    waits.findLast(wait => wait.args[2] === pane && wait.args[4] === status)?.resolve(ok(occupant));
  };
  const terminal = (node: any) => until(async () => (await request('get', { runId: node.snapshot.scope.run })).snapshot.state === 'terminal', 'expected observed terminal');
  const ack = async (node: any) => { for (const delivery of await request('wait', { runId: node.snapshot.scope.run, timeoutMs: 0 })) await request('ack', { runId: node.snapshot.scope.run, deliveryId: delivery.id }); };
  const own = { ...host, stateRoot, sessionId, request, launched, observe, terminal, ack, calls, rows, occupants };
  services.push(own); return own;
}

const root = await start(join(base, 'root'), 'root', 12);
const a = await root.launched('advisor-a');
const aState = a.packet.execution.environment.ADVISOR_BRIDGE_CHILD_STATE;
process.env.ADVISOR_BRIDGE_CHILD_STATE = aState; // Regression: old execution port suppressed every subsequent grant.
const child = await start(aState, 'child', 1); // Must NOT mint/use this local ceiling.
const b = await child.launched('advisor-b');
const bState = b.packet.execution.environment.ADVISOR_BRIDGE_CHILD_STATE;
const grandchild = await start(bState, 'grandchild', 1);
const leaf = await grandchild.launched('leaf', 'specialist');
assert.equal(leaf.packet.execution.environment.ADVISOR_BRIDGE_CHILD_STATE, '');
assert.equal(dirname(aState), dirname(bState), 'flat family control storage at every depth');
for (const service of services) assert.ok(Buffer.byteLength(join(service.stateRoot, 'runtime.sock')) <= 100);
for (const [parent, node, childState] of [[root, a, aState], [child, b, bState]] as const) {
  const data = await readChildScope({ cwd, env: { ADVISOR_BRIDGE_CHILD_STATE: childState } });
  assert.equal(data!.parent.stateRoot, parent.stateRoot); assert.equal(data!.parent.sessionId, parent.sessionId);
  assert.deepEqual(data!.parent.scope, node.snapshot.scope); assert.equal(data!.issuedAttempt, 1);
  assert.equal(data!.family.rootStateRoot, root.stateRoot); assert.equal(data!.family.workerHarness, 'native');
  assert.equal(data!.family.workstream, 'recursive-fixture'); assert.equal('authority' in data!, false);
  assert.equal(node.packet.execution.environment.PI_DETACH_WORKER_HARNESS, 'native');
  assert.equal(node.packet.execution.environment.ADVISOR_WORKSTREAM, 'recursive-fixture');
  assert.equal(parent.calls.filter(args => args[1] === 'split').length, 1);
}
assert.equal(leaf.parentOutcome.parent.scope.run, b.snapshot.scope.run);
assert.equal((await child.request('get', { runId: b.snapshot.scope.run })).childService.stateRoot, bState);
assert.ok(grandchild.rows('events').every(row => JSON.parse(row.data).lineage.run === b.snapshot.scope.run));
assert.equal((await grandchild.request('family.budget')).used, 3);
console.log('PASS recursive real port: root → advisor → advisor → specialist; visible acquisition, stable parent scope, flat sockets, inherited harness, canonical linkage');

// Existing graph repair accounting stays in its original service and stable outcome.
const graph = { graphId: 'child-graph', advisorSessionId: child.sessionId, parentOutcome: b.parentOutcome.parent, maxRepairLoops: 1, nodes: [{ id: 'outcome', task: 'Bounded outcome', dependsOn: [] }] };
await child.request('graph.evidence', { graph, node: 'outcome', runId: b.snapshot.scope.run });
await assert.rejects(child.request('graph.evidence', { graph: { ...graph, parentOutcome: { ...graph.parentOutcome, stateRoot: '/foreign' } }, node: 'outcome' }), /GRAPH_PARENT_SCOPE_MISMATCH/);
await assert.rejects(root.request('graph.evidence', { graph: { ...graph, advisorSessionId: root.sessionId }, node: 'outcome' }), /GRAPH_PARENT_SCOPE_MISMATCH/);
root.observe(a); child.observe(b);
await new Promise(resolve => setTimeout(resolve, 300));
assert.equal((await root.request('get', { runId: a.snapshot.scope.run })).snapshot.state, 'running');
grandchild.observe(leaf); await grandchild.terminal(leaf);
assert.equal((await grandchild.request('supervision')).settled, true, 'settlement does not wait for acknowledgements');
await assert.rejects(grandchild.service.close(), /SHUTDOWN_DELIVERY/);
await new Promise(resolve => setTimeout(resolve, 300));
assert.equal((await child.request('get', { runId: b.snapshot.scope.run })).snapshot.state, 'running', 'old advisor PASS is not integration');
child.observe(b); await child.terminal(b); root.observe(a); await root.terminal(a);
const grantBefore = readFileSync(join(bState, 'child-grant.json'), 'utf8');
await child.request('call', { tool: 'bg_agent', toolCallId: 'kept-repair', cwd, params: { name: b.snapshot.scope.run, prompt: 'repair' } }); await child.runtime.dispatch();
assert.equal(readFileSync(join(bState, 'child-grant.json'), 'utf8'), grantBefore, 'kept followup does not reissue or freeze the parent at attempt one');
child.observe(b); await child.terminal(b);
const evidence = await child.request('graph.evidence', { graph, node: 'outcome', runId: b.snapshot.scope.run });
assert.equal(evidence.node.budget.used, 1); assert.equal(evidence.node.boundAttempt, 2);
assert.deepEqual(evidence.parentOutcome.scope, a.snapshot.scope); assert.equal(evidence.node.proof, 'unknown', 'nested maker evidence is not independent verification');
await assert.rejects(child.request('call', { tool: 'bg_agent', toolCallId: 'excess-repair', cwd, params: { name: b.snapshot.scope.run, prompt: 'third task' } }), /GRAPH_REPAIR_LIMIT/);
assert.equal((await child.request('family.budget')).used, 5, 'failed continuing admission is conservatively consumed, not refunded');
console.log('PASS kept advisor followup: stable grant, issuance attempt distinct, original graph repair budget and captured history retained');

// Cancellation uses three real driver Escapes; ancestors cannot settle ahead of descendants.
await root.request('call', { tool: 'bg_agent', toolCallId: 'a-next', cwd, params: { name: a.snapshot.scope.run, prompt: 'next' } }); await root.runtime.dispatch();
const b2 = await child.launched('b-next'); const b2State = b2.packet.execution.environment.ADVISOR_BRIDGE_CHILD_STATE;
const last = await start(b2State, 'last', 1); const leaf2 = await last.launched('leaf-next', 'specialist');
await root.request('call', { tool: 'bg_stop', toolCallId: 'cancel-tree', cwd, params: { runId: a.snapshot.scope.run } }); await root.runtime.dispatch();
await until(async () => last.calls.some(args => args[1] === 'send-keys'), 'leaf Escape delivered');
root.observe(a, 'idle'); child.observe(b2, 'idle');
await new Promise(resolve => setTimeout(resolve, 300));
assert.equal((await root.request('get', { runId: a.snapshot.scope.run })).snapshot.state, 'running');
assert.equal((await child.request('get', { runId: b2.snapshot.scope.run })).snapshot.state, 'running');
await assert.rejects(last.launched('after-seal', 'specialist'), /FAMILY_ADMISSION_SEALED/);
last.observe(leaf2, 'idle'); await last.terminal(leaf2); await child.terminal(b2); await root.terminal(a);
for (const [service, node] of [[root, a], [child, b2], [last, leaf2]] as const) {
  const final = await service.request('get', { runId: node.snapshot.scope.run });
  assert.equal(final.status, 'cancelled'); assert.equal(final.processExited, undefined);
  assert.equal(service.calls.filter(args => args[1] === 'send-keys' && args[3] === 'esc').length, 1);
  assert.equal(service.calls.some(args => args[1] === 'close'), false);
}
await root.request('call', { tool: 'bg_stop', toolCallId: 'cancel-tree', cwd, params: { runId: a.snapshot.scope.run } });
assert.equal(root.calls.filter(args => args[1] === 'send-keys').length, 1);
assert.equal((await root.request('supervision')).settled, true);
await assert.rejects(root.service.close(), /SHUTDOWN_DELIVERY/);
console.log('PASS downward cancellation: sealed descendant admission, three observed post-Escape settlements, no process-exit claims, acknowledgement separate');

// Narrow capabilities cannot call parent control or change exact scopes / workspace / grant.
const grant = JSON.parse(grantBefore);
const capability = { v: 1 as const, socketPath: join(root.stateRoot, 'runtime.sock'), token: grant.authority.token };
assert.equal((await callSocket(capability, { v: 1, op: 'pi.detach', sessionId: root.sessionId, action: 'list', payload: {} }, 'model') as any).error, 'UNAUTHORIZED');
assert.equal((await callSocket(capability, { v: 1, op: 'family', action: 'seal', payload: { scope: a.snapshot.scope } }, 'model') as any).error, 'FAMILY_SCOPE_FORBIDDEN');
assert.equal((await callSocket({ ...capability, token: '0'.repeat(64) }, { v: 1, op: 'family', action: 'budget', payload: {} }, 'model') as any).error, 'FAMILY_UNAUTHORIZED');
const path = join(bState, 'child-grant.json');
for (const mutate of [(g: any) => { g.parent.scope.run = 'foreign'; }, (g: any) => { g.family.id = '0'.repeat(32); }, (g: any) => { g.cwd = base; }, (g: any) => { g.allowedRoots.push(base); }, (g: any) => { g.issuedAttempt = 99; }]) {
  const altered = JSON.parse(grantBefore); mutate(altered); writeFileSync(path, JSON.stringify(altered));
  await assert.rejects(readChildScope({ cwd, env: { ADVISOR_BRIDGE_CHILD_STATE: bState } }));
  writeFileSync(path, grantBefore);
}
chmodSync(path, 0o644); await assert.rejects(readChildScope({ cwd, env: { ADVISOR_BRIDGE_CHILD_STATE: bState } }), /UNSAFE_FILE/); chmodSync(path, 0o600);
console.log('PASS narrow family capabilities: no parent runtime control, foreign cancel scope/credential/grant/workspace/provenance tampering rejected');

// Root cumulative allowance survives new graphs/services and concurrent last-slot reservations.
const budget = await root.request('family.budget');
for (let i = budget.used; i < 11; i++) { const n = await root.launched(`fill-${i}`, 'specialist'); root.observe(n); await root.terminal(n); }
const concurrent = await Promise.allSettled([root.launched('last-slot-one', 'specialist'), root.launched('last-slot-two', 'specialist')]);
assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
const winner = (concurrent.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
root.observe(winner); await root.terminal(winner);
assert.deepEqual(await root.request('family.budget'), { maxLaunches: 12, used: 12, remaining: 0 });
const winnerKey = concurrent[0].status === 'fulfilled' ? 'last-slot-one' : 'last-slot-two';
await root.launched(winnerKey, 'specialist');
assert.equal((await root.request('family.budget')).used, 12);
console.log('PASS root atomic accounting: continuations consume, services cannot reset, concurrent last slot cannot overspend, replay charges once');

for (const service of services) for (const row of await service.request('list')) if (row.node) await service.ack({ snapshot: { scope: { run: row.runId } } });
await root.service.close();
for (const service of services) assert.equal(existsSync(join(service.stateRoot, 'service.lock')), false, 'typed shutdown composes through flat family children');
console.log('PASS typed recursive close: all acknowledged services closed without process signals or fabricated cancellation');
console.log(`EVIDENCE ${base}`);
process.exit(0);
