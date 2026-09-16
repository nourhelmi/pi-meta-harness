import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { hostPiDetach } from '../scripts/advisor-runtime/pi-detach-host.mjs';
import { createPiDetachClient } from '../scripts/advisor-runtime/pi-detach-client.mjs';
import { contentSurface, reportSummary } from '../scripts/advisor-runtime/evidence.mjs';

const report = status => `# Status\n${status}\n# Claims\n${'bounded claim '.repeat(200)}\n# Evidence\nWorker-local check, not host proof.\n# Remaining Risk\nExternal environment unknown.\n`;
async function fixture(t, keepAlive = true) {
  const base = realpathSync(mkdtempSync('/tmp/outcome-proof-')); const work = join(base, 'work'); mkdirSync(work);
  const git = args => { const r = spawnSync('git', ['-C', work, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git(['init', '-q']); writeFileSync(join(work, 'check.mjs'), "import assert from 'node:assert/strict'; assert.equal(2 + 2, 4);\n");
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  const launches = []; const port = { version: 1,
    async prepare(params, sourceDirectory) { return { v: 1, command: 'fixture', prompt: params.prompt, role: params.role ?? 'builder', runtime: 'pi', model: 'fixture', thinking: 'none', maxTurns: null, requiredSkills: [], harness: 'pi', keepAlive: params.keepAlive ?? keepAlive, label: 'fixture', resultDiscovery: null, resultPolicy: 'runtime-capture', sourceDirectory,
      environment: { ADVISOR_RUNTIME_DESCRIPTOR: '', PI_DETACH_RUNTIME_BRIDGE: '', ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_RUNTIME_CANONICAL_OWNER: '1' } }; },
    async launch({ hooks, intent, reply }) {
      hooks.recordHandle(hooks.expectedHandle ?? { id: 'same-worker', session: 'same-session' });
      if (hooks.observeOnly) return { async readLive() { return 'output'; }, async runtimeObservation() { return { session: 'same-session', generation: hooks.expectedGeneration, state: 'done' }; } };
      launches.push({ hooks, intent, reply });
      return { async interrupt(observer) { launches.at(-1).cancel = observer; }, async readLive() { return 'output'; } };
    }
  };
  const stateRoot = join(base, 'state'); const options = { stateRoot, cwd: work, sessionId: 'owner', credentialPath: join(stateRoot, 'pi.json'), port, keepAlive: false };
  let host = await hostPiDetach(options); const client = createPiDetachClient(options.credentialPath);
  const request = (action, payload = {}) => client.request('owner', action, payload);
  let serial = 0;
  const launch = async (params = {}, toolCallId = `call-${++serial}`) => { const accepted = await request('call', { tool: 'bg_agent', toolCallId, cwd: work, params: { prompt: 'Cohesive task', ...params } }); await host.runtime.dispatch(); return accepted.runId; };
  const settle = status => { const { hooks, intent } = launches.at(-1); if (status !== null) writeFileSync(join(intent.sourceDirectory, 'result.md'), status === 'malformed' ? '???' : report(status)); return hooks.settled('done', 'output', launches.length * 2); };
  const ack = async runId => { for (const delivery of await request('wait', { runId, timeoutMs: 0 })) await request('ack', { runId, deliveryId: delivery.id }); };
  const restart = async () => { await host.service.close(); host = await hostPiDetach(options); };
  t.after(async () => { try { for (const run of await request('list')) await ack(run.runId); await host.service.close(); } catch {} rmSync(base, { force: true, recursive: true }); });
  return { work, stateRoot, launches, request, launch, settle, ack, restart, runtime: () => host.runtime, client, port };
}

for (const role of ['builder', 'foreman', 'checker']) test(`active ${role} does not veto same-checkout launches or follow-up tasks`, async t => {
  const f = await fixture(t); const owner = await f.launch({ role }); const original = f.launches[0];
  const leaf = await f.launch({ role: 'builder' }); f.settle('PASS');
  assert.equal((await f.request('get', { runId: owner })).snapshot.state, 'running');
  await f.launch({ name: leaf, prompt: 'Continue the leaf outcome' });
  assert.equal((await f.request('get', { runId: leaf })).attempt, 2);
  assert.equal((await f.request('get', { runId: owner })).snapshot.state, 'running');
  f.settle('PASS');
  writeFileSync(join(original.intent.sourceDirectory, 'result.md'), report('PASS'));
  original.hooks.settled('done', 'owner output', 2);
  await f.ack(owner); await f.ack(leaf);
});

test('an unbound failed checker does not veto replacement work or repairs', async t => {
  const f = await fixture(t); const launch = f.port.launch; let failedLaunches = 0;
  f.port.launch = async input => {
    if (input.intent.role === 'checker') { failedLaunches++; throw new Error('fixture: unproven launch before handle binding'); }
    return launch(input);
  };
  const failed = await f.launch({ role: 'checker', prompt: 'READ ONLY review' }, 'failed-checker');
  const failure = await f.request('get', { runId: failed });
  assert.equal(failure.status, 'recovery-required'); assert.equal(failure.handle, null);
  assert.equal(failure.result, null); assert.equal(failure.continuation, 'none');
  const replacement = await f.launch({ role: 'builder' }); f.settle('PASS');
  await f.launch({ name: replacement, prompt: 'Apply review repairs' }); f.settle('PASS');
  assert.equal((await f.request('get', { runId: replacement })).attempt, 2);
  assert.equal((await f.request('get', { runId: failed })).status, 'recovery-required');
  await assert.rejects(f.launch({ name: failed, prompt: 'Retry the ambiguous checker' }), /RECOVERY_REQUIRED/);
  assert.equal(failedLaunches, 1, 'replacement work must not replay or adopt the ambiguous effect');
  await f.ack(replacement);
});

for (const status of ['PASS', 'FAIL', 'BLOCKED', 'malformed', null]) test(`captured ${status}: bounded authentic report, replay and fresh same-worker evidence`, async t => {
  const f = await fixture(t); const runId = await f.launch({}, 'initial'); f.settle(status);
  const first = await f.request('get', { runId }); const sealed = await f.request('result', { toolCallId: 'initial', seal: true });
  assert.equal(first.result?.proof ?? 'unknown', 'unknown'); assert.equal(first.result?.tested ?? null, null);
  if (status === null) { assert.equal(first.result, null); assert.equal(first.status, 'done'); return; }
  assert.match(first.result.path, /result-1-[a-f0-9]{64}\.md$/); assert.equal(readFileSync(first.result.path, 'utf8'), status === 'malformed' ? '???' : report(status));
  assert.equal('claims' in first.result, false, 'no claim projection survives'); assert.equal(sealed.result.path, first.result.path);
  const delivery = (await f.request('wait', { runId, timeoutMs: 0 })).find(d => d.kind === 'settled'); assert.equal(delivery.result.path, first.result.path);
  const old = f.launches[0]; writeFileSync(join(old.intent.sourceDirectory, 'result.md'), report('FAIL'));
  old.hooks.settled('done', 'duplicate', 2); assert.equal((await f.request('get', { runId })).result.sha256, first.result.sha256, 'duplicate callback cannot recapture');
  if (status === 'malformed') { writeFileSync(first.result.path, 'tampered'); assert.equal((await f.request('wait', { runId, timeoutMs: 0 })).find(d => d.kind === 'settled').result.integrity, 'invalid'); assert.equal(first.result.valid, false); assert.equal(first.result.status, 'unknown'); return; }
  assert.equal(first.continuation, 'task');
  await f.launch({ name: runId, prompt: 'Scoped follow-up' }, 'next');
  assert.equal(f.launches.length, 2); assert.equal((await f.request('get', { runId })).result, null);
  assert.throws(() => old.hooks.settled('done', 'stale', 4), /ATTEMPT_MISMATCH/);
  await f.launch({ name: runId, prompt: 'Scoped follow-up' }, 'next'); assert.equal(f.launches.length, 2, 'replay cannot prompt again');
  f.settle('PASS'); const fresh = await f.request('get', { runId }); assert.equal(fresh.result.attempt, 2); assert.notEqual(fresh.result.path, first.result.path);
  assert.equal(readFileSync(first.result.path, 'utf8'), status === 'malformed' ? '???' : report(status), 'old immutable capture remains accessible');
  const replay = await f.request('result', { toolCallId: 'initial', seal: true }); assert.equal(replay.attempt, 2); assert.equal(replay.result.path, fresh.result.path);
  assert.equal(f.launches[1].reply, 'Scoped follow-up');
});

test('optional dependency consumes host proof, retains captures but invalidates proof on owner reload, and fences identity', async t => {
  const f = await fixture(t, false); const runId = await f.launch(); f.settle('PASS');
  const graph = { graphId: 'outcome', advisorSessionId: 'owner', nodes: [{ id: 'maker', task: 'Implement and check', dependsOn: [] }, { id: 'checker', task: 'Close only the remaining uncertainty', dependsOn: ['maker'] }] };
  const evidence = (node, runId) => f.request('graph.evidence', { graph, node, ...(runId ? { runId } : {}) });
  assert.equal((await evidence('checker')).dependencies[0].reason, 'missing binding');
  await evidence('maker', runId); assert.equal((await evidence('checker')).dependencies[0].proof, 'unknown');
  const node = await f.request('get', { runId });
  const proof = f.runtime().checkNode({ scope: node.snapshot.scope, command: process.execPath, args: ['check.mjs'], producer: 'independent-host-check' });
  assert.equal(proof.proof, 'verified'); assert.equal(JSON.parse(readFileSync(proof.path)).outcome, 'PASS');
  const checkBytes = readFileSync(proof.path); writeFileSync(proof.path, 'tampered'); assert.equal((await evidence('checker')).dependencies[0].proof, 'unknown'); writeFileSync(proof.path, checkBytes);
  const consumed = await evidence('checker'); assert.equal(consumed.dependencies[0].proof, 'verified'); assert.equal(consumed.dependencies[0].result.tested.surface.sha256, proof.surface.sha256); assert.ok(consumed.prompt.includes(node.result.path));
  assert.equal(consumed.dependencies[0].result.tested.producer, 'independent-host-check');
  // Actually use the dependency prompt in the existing worker launch path, not an isolated metadata assertion.
  const downstream = await f.launch({ role: 'checker', prompt: consumed.prompt }); assert.equal(f.launches.at(-1).intent.prompt, consumed.prompt); f.settle('PASS'); await f.ack(downstream);
  mkdirSync(join(f.work, 'nested')); assert.deepEqual(contentSurface(join(f.work, 'nested')), contentSurface(f.work), 'nested cwd hashes the complete root');
  writeFileSync(join(f.work, 'dependency.lock'), 'changed dependency'); assert.equal((await evidence('checker')).dependencies[0].proof, 'unknown'); rmSync(join(f.work, 'dependency.lock'));
  const check = readFileSync(join(f.work, 'check.mjs')); writeFileSync(join(f.work, 'check.mjs'), 'throw Error("regression")'); assert.equal((await evidence('checker')).dependencies[0].proof, 'unknown'); writeFileSync(join(f.work, 'check.mjs'), check);
  assert.equal((await evidence('checker')).dependencies[0].proof, 'verified');
  const changed = f.runtime().checkNode({ scope: node.snapshot.scope, command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('changed.txt', 'changed')"] }); assert.equal(changed.proof, 'unknown'); assert.equal(changed.unchanged, false); rmSync(join(f.work, 'changed.txt'));
  const failed = f.runtime().checkNode({ scope: node.snapshot.scope, command: process.execPath, args: ['-e', 'process.exit(1)'], producer: 'contradiction' }); assert.equal(failed.proof, 'unknown'); const contradicted = (await evidence('checker')).dependencies[0]; assert.equal(contradicted.proof, 'unknown'); assert.equal(contradicted.result.lastCheck.outcome, 'FAIL'); assert.equal(contradicted.result.lastCheck.path, failed.path);
  f.runtime().checkNode({ scope: node.snapshot.scope, command: process.execPath, args: ['check.mjs'] });
  await assert.rejects(f.client.request('foreign', 'graph.evidence', { graph, node: 'maker', runId }), /BRIDGE_SESSION_MISMATCH/);
  await assert.rejects(f.request('graph.evidence', { graph: { ...graph, advisorSessionId: 'foreign' }, node: 'maker', runId }), /GRAPH_OWNER_MISMATCH/);
  const revision = await f.request('graph.evidence', { graph: { ...graph, nodes: graph.nodes.slice(0, 1) }, node: 'maker' });
  assert.ok(revision.historicalRevisions.length > 0);
  await f.ack(runId); await f.restart();
  const reloaded = (await evidence('checker')).dependencies[0];
  assert.equal(reloaded.proof, 'unknown'); assert.equal(reloaded.result.tested, null);
  assert.equal(reloaded.result.integrity, 'intact'); assert.equal(reloaded.result.path, node.result.path);
  assert.equal(JSON.parse((await f.request('artifact', { runId, path: `check-${proof.sha256}.json` })).text).outcome, 'PASS');
  f.runtime().checkNode({ scope: node.snapshot.scope, command: process.execPath, args: ['check.mjs'] });
  assert.equal((await evidence('checker')).dependencies[0].proof, 'verified');
  writeFileSync(node.result.path, 'tampered'); const invalid = (await evidence('checker')).dependencies[0]; assert.equal(invalid.proof, 'unknown'); assert.equal(invalid.result.integrity, 'invalid');
  rmSync(node.result.path); assert.equal((await evidence('checker')).dependencies[0].result.integrity, 'missing');
});

test('kept terminal restart denies continuation and graph association never silently follows a new attempt', async t => {
  const f = await fixture(t); const runId = await f.launch(); f.settle('PASS');
  const graph = { graphId: 'attempts', advisorSessionId: 'owner', nodes: [{ id: 'constructor', task: 'Owned evidence', dependsOn: [] }] };
  const evidence = () => f.request('graph.evidence', { graph, node: 'constructor' });
  assert.equal((await evidence()).node.reason, 'missing binding'); await f.request('graph.evidence', { graph, node: 'constructor', runId });
  await f.launch({ name: runId }); assert.equal((await evidence()).node.reason, 'attempt changed'); f.settle('PASS'); await f.ack(runId);
  await f.restart(); const recovered = await f.request('get', { runId }); assert.equal(recovered.status, 'recovery-required'); assert.equal(recovered.continuation, 'none');
  await assert.rejects(f.launch({ name: runId }), /RECOVERY_REQUIRED/);
});

test('report projection preserves uncertainty and never promotes a worker assertion into proof', () => {
  assert.equal(reportSummary('not a report').valid, false);
  assert.equal(reportSummary('Status: PASS\nClaims:\nAn existing plain-label report.\nEvidence:\ncheck').status, 'PASS');
  for (const status of ['PASS', 'FAIL', 'BLOCKED']) { const summary = reportSummary(report(status)); assert.equal(summary.status, status); assert.deepEqual(Object.keys(summary).sort(), ['limitations', 'status', 'valid']); }
});

test('repair-capable checker retains its identity for a maker-repaired delta and never self-certifies it', async t => {
  const f = await fixture(t); const runId = await f.launch({ role: 'checker', prompt: 'Review initial maker change' }); f.settle('FAIL');
  const reviewed = await f.request('get', { runId }); assert.equal(reviewed.result.producer.role, 'checker');
  // The same reviewer gets only the repaired delta and its adjacent behavior, not a fresh review launch.
  await f.launch({ name: runId, prompt: 'Maker repaired finding C1; recheck C1 and adjacent boundary only' }); f.settle('PASS');
  const delta = await f.request('get', { runId }); assert.equal(delta.handle.id, reviewed.handle.id); assert.equal(delta.result.producer.role, 'checker'); assert.equal(delta.result.proof, 'unknown'); assert.equal(delta.result.attempt, 2);
  assert.match(f.launches[1].reply, /C1 and adjacent boundary only/); assert.equal(f.launches[1].intent.role, 'checker');
});

test('duplicate cancellation observation cannot recapture mutable source bytes', async t => {
  const f = await fixture(t); const runId = await f.launch();
  await f.request('call', { tool: 'bg_stop', toolCallId: 'cancel', cwd: f.work, params: { runId } }); await f.runtime().dispatch();
  const current = f.launches[0]; writeFileSync(join(current.intent.sourceDirectory, 'result.md'), report('PASS'));
  current.cancel.settled('done', 'cancelled', 2); const cancelled = await f.request('get', { runId }); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.continuation, 'none');
  writeFileSync(join(current.intent.sourceDirectory, 'result.md'), report('FAIL')); current.cancel.settled('done', 'duplicate', 2);
  assert.equal((await f.request('artifact', { runId, path: 'result.md' })).text, report('PASS')); assert.equal((await f.request('get', { runId })).result.sha256, cancelled.result.sha256);
});

test('stable graph outcome refresh preserves history, budgets and downstream provenance across same-run repairs', async t => {
  const f = await fixture(t);
  const graph = { graphId: 'stable', advisorSessionId: 'owner', maxRepairLoops: 2, contract: 'accepted-v1', nodes: [
    { id: 'maker', task: 'Implement', dependsOn: [] }, { id: 'checker', task: 'Review', dependsOn: ['maker'] },
    { id: 'delivery', task: 'Deliver', dependsOn: ['checker'] },
  ] };
  const evidence = (node, runId, attempt) => f.request('graph.evidence', { graph, node, ...(runId ? { runId } : {}), ...(attempt ? { attempt } : {}) });
  const verify = async runId => f.runtime().checkNode({ scope: (await f.request('get', { runId })).snapshot.scope, command: process.execPath, args: ['check.mjs'] });
  const maker = await f.launch(); f.settle('PASS'); const first = await f.request('get', { runId: maker });
  await evidence('maker', maker); await verify(maker);
  const reviewer = await f.launch({ role: 'checker', prompt: (await evidence('checker')).prompt }); f.settle('PASS'); await evidence('checker', reviewer); await verify(reviewer);
  assert.equal((await evidence('delivery')).dependencies[0].proof, 'verified');
  await f.launch({ name: maker, prompt: 'Repair C1 only' });
  assert.equal((await evidence('maker')).node.reason, 'attempt changed');
  assert.equal((await evidence('delivery')).dependencies[0].proof, 'unknown');
  await assert.rejects(evidence('maker', maker, 1), /ATTEMPT_MISMATCH/);
  await assert.rejects(evidence('maker', reviewer), /GRAPH_NODE_ALREADY_BOUND/);
  await assert.rejects(evidence('maker', 'unowned'), /BRIDGE_TARGET_FORBIDDEN/);
  const revised = await f.request('graph.evidence', { graph: { ...graph, contract: 'changed-acceptance' }, node: 'maker', runId: maker });
  assert.equal(revised.historicalRevisions.at(-1).links.maker.runId, maker);
  f.settle('PASS'); const refreshed = await evidence('maker', maker, 2);
  assert.equal(refreshed.node.attempt, 2); assert.equal(refreshed.node.boundAttempt, 2);
  assert.deepEqual(refreshed.node.budget, { maxRepairLoops: null, used: 1, remaining: null });
  assert.equal(refreshed.node.history[0].result.path, first.result.path);
  assert.equal(refreshed.node.history[0].result.proof, 'unknown');
  assert.equal(refreshed.node.history[0].checks[0].outcome, 'PASS');
  assert.equal(refreshed.node.history[0].checks[0].integrity, 'intact');
  assert.equal(JSON.parse((await f.request('artifact', { runId: maker, path: `check-${refreshed.node.history[0].checks[0].sha256}.json` })).text).outcome, 'PASS');
  assert.equal((await f.request('artifact', { runId: maker, path: first.result.file })).text, report('PASS'));
  await verify(maker); assert.equal((await evidence('maker')).node.proof, 'verified');
  assert.equal((await evidence('checker', reviewer)).node.proof, 'unknown', 'same-attempt rebind cannot bless old downstream proof');
  assert.equal((await evidence('delivery')).dependencies[0].result.proof, 'unknown', 'nested handoff cannot leak stale verified flag');
  await f.launch({ name: reviewer, prompt: (await evidence('checker')).prompt }); f.settle('PASS'); await evidence('checker', reviewer); await verify(reviewer);
  assert.equal((await evidence('delivery')).dependencies[0].proof, 'verified');
  const current = await f.request('get', { runId: maker }); const bytes = readFileSync(current.result.path);
  rmSync(current.result.path); assert.equal((await evidence('delivery')).dependencies[0].proof, 'unknown');
  writeFileSync(current.result.path, bytes); assert.equal((await evidence('delivery')).dependencies[0].proof, 'verified');
  await f.launch({ name: maker }); f.settle('PASS'); await evidence('maker', maker);
  assert.equal((await evidence('maker', maker)).node.budget.used, 2);
  await f.launch({ name: maker }); f.settle('PASS'); await evidence('maker', maker);
  await f.ack(maker); await f.ack(reviewer); await f.restart();
  const reloaded = await evidence('maker', maker);
  assert.equal(reloaded.node.budget.used, 3); assert.equal(reloaded.node.historyCount, 3);
  assert.equal(reloaded.node.proof, 'unknown');
});

test('rejected settlement observations never mutate captured aliases or output', async t => {
  const f = await fixture(t); const runId = await f.launch(); const active = f.launches[0];
  writeFileSync(join(active.intent.sourceDirectory, 'result.md'), report('PASS'));
  assert.throws(() => active.hooks.settled('done', 'invalid-generation', 0), /INVALID_INTEGER/);
  assert.throws(() => readFileSync(join(active.intent.sourceDirectory, '../result.md')), /ENOENT/, 'no alias may be created before validating the generation');
  assert.equal((await f.request('artifact', { runId, path: 'result.md' })).text, '');
  assert.equal((await f.request('output', { runId })).text, 'output', 'live output remains available');
  await f.request('call', { tool: 'bg_stop', toolCallId: 'cancel-race', cwd: f.work, params: { runId } }); await f.runtime().dispatch();
  active.cancel.settled('done', 'cancel-won', 2);
  const cancelled = await f.request('get', { runId });
  writeFileSync(join(active.intent.sourceDirectory, 'result.md'), report('FAIL'));
  assert.throws(() => active.hooks.settled('done', 'late-natural', 3), /NODE_TERMINAL/);
  assert.equal((await f.request('artifact', { runId, path: 'result.md' })).text, report('PASS'));
  assert.equal((await f.request('output', { runId })).text, 'cancel-won');
  assert.equal((await f.request('get', { runId })).result.sha256, cancelled.result.sha256);
});

test('UI-blocked worker cannot be reused even when a FAIL report exists', async t => {
  const f = await fixture(t); const runId = await f.launch(); const active = f.launches[0];
  writeFileSync(join(active.intent.sourceDirectory, 'result.md'), report('FAIL'));
  active.hooks.settled('blocked', 'direct UI needed', 2);
  const got = await f.request('get', { runId });
  assert.equal(got.status, 'stalled'); assert.equal(got.continuation, 'none');
});

test('host verification rejects tampered immutable capture even when mutable alias still matches', async t => {
  const f = await fixture(t, false); const runId = await f.launch(); f.settle('PASS');
  const node = await f.request('get', { runId }); writeFileSync(node.result.path, 'tampered');
  assert.throws(() => f.runtime().checkNode({ scope: node.snapshot.scope, command: process.execPath, args: ['check.mjs'] }), /RESULT_CHANGED/);
  assert.equal((await f.request('get', { runId })).result.proof, 'unknown');
});

test('same worker stale generation and old owner callbacks are fenced before new capture', async t => {
  const f = await fixture(t); const runId = await f.launch(); f.settle('PASS');
  const first = await f.request('get', { runId }); await f.launch({ name: runId });
  const next = f.launches.at(-1); writeFileSync(join(next.intent.sourceDirectory, 'result.md'), report('FAIL'));
  assert.throws(() => next.hooks.settled('done', 'stale-generation', 2), /BRIDGE_STALE_SETTLEMENT/);
  assert.equal(readFileSync(join(next.intent.sourceDirectory, '../result.md'), 'utf8'), report('PASS'));
  f.settle('PASS'); await f.ack(runId); await f.restart();
  writeFileSync(join(next.intent.sourceDirectory, 'result.md'), report('FAIL'));
  assert.throws(() => next.hooks.settled('done', 'wrong-owner', 5));
  assert.equal(readFileSync(first.result.path, 'utf8'), report('PASS'));
});

test('legacy zero repair budget never gates followups and remains accounting only', async t => {
  const f = await fixture(t); const runId = await f.launch(); f.settle('BLOCKED');
  const graph = { graphId: 'strict-outcome', advisorSessionId: 'owner', maxRepairLoops: 0, nodes: [{ id: 'maker', task: 'Complete outcome', dependsOn: [] }] };
  await f.request('graph.evidence', { graph, node: 'maker', runId });
  for (let i = 0; i < 4; i++) { await f.launch({ name: runId, prompt: `next ${i}` }); f.settle('PASS'); }
  const stale = await f.request('graph.evidence', { graph, node: 'maker' }); assert.equal(stale.node.reason, 'attempt changed');
  const fresh = await f.request('graph.evidence', { graph, node: 'maker', runId });
  assert.deepEqual(fresh.node.budget, { maxRepairLoops: null, used: 4, remaining: null });
  assert.equal(fresh.node.historyCount, 4); assert.equal(fresh.node.history[0].result.status, 'BLOCKED');
});

// Derived from the independent late-bind / repair-first / successor probes.
function outcome(f, graphId = 'followup', maxRepairLoops = 2) {
  const graph = { graphId, advisorSessionId: 'owner', maxRepairLoops, nodes: [
    { id: 'maker', task: 'Own the outcome', dependsOn: [] },
    { id: 'checker', task: 'Repair and check', dependsOn: ['maker'] },
    { id: 'delivery', task: 'Deliver current output', dependsOn: ['checker'] },
  ] };
  return {
    graph,
    evidence: (node, runId, extra = {}) => f.request('graph.evidence', { graph, node, ...(runId ? { runId } : {}), ...extra }),
    check: async runId => f.runtime().checkNode({ scope: (await f.request('get', { runId })).snapshot.scope, command: process.execPath, args: ['check.mjs'] }),
  };
}

test('public launch admission prevents late bind and continuation from laundering attempt-one inputs', async t => {
  const f = await fixture(t); const { evidence, check } = outcome(f);
  const maker = await f.launch(); f.settle('PASS'); await evidence('maker', maker); await check(maker);
  const supplied = await evidence('checker');
  const reviewer = await f.launch({ role: 'checker', prompt: supplied.prompt }); f.settle('PASS');
  const admitted = await f.request('get', { runId: reviewer });
  assert.equal(admitted.consumedInputs[0].inputs[0].attempt, 1);
  assert.equal(f.launches.at(-1).intent.prompt, supplied.prompt);
  await f.launch({ name: maker }); f.settle('PASS'); await evidence('maker', maker); await check(maker);
  await evidence('checker', reviewer); await check(reviewer);
  const late = (await evidence('checker', reviewer)).node;
  assert.equal(late.proof, 'unknown'); assert.equal(late.consumedInputs[0].attempt, 1);
  assert.equal(late.reason, 'dependency attempt or capture changed');
  await f.launch({ name: reviewer, prompt: 'Continue with only your existing context' }); f.settle('PASS');
  await evidence('checker', reviewer); await check(reviewer);
  assert.equal((await evidence('checker')).node.proof, 'unknown', 'refresh cannot manufacture new context');
  const fresh = await evidence('checker');
  await f.launch({ name: reviewer, prompt: fresh.prompt }); f.settle('PASS'); await evidence('checker', reviewer); await check(reviewer);
  assert.equal((await evidence('checker')).node.consumedInputs[0].attempt, 2);
  assert.equal((await evidence('checker')).node.proof, 'verified');
});

test('repair-first current proof supersedes an evidenced failure without requiring historical green checks', async t => {
  const f = await fixture(t, false); const { evidence, check } = outcome(f);
  writeFileSync(join(f.work, 'check.mjs'), 'process.exit(1);\n');
  const maker = await f.launch(); f.settle('PASS'); await evidence('maker', maker);
  const failed = await check(maker); assert.equal(failed.outcome, 'FAIL');
  const supplied = await evidence('checker'); assert.equal(supplied.dependencies[0].result.lastCheck.outcome, 'FAIL');
  const reviewer = await f.launch({ role: 'checker', prompt: supplied.prompt }); await evidence('checker', reviewer);
  writeFileSync(join(f.work, 'check.mjs'), "import assert from 'node:assert/strict'; assert.equal(2 + 2, 4);\n");
  f.settle('PASS'); await check(reviewer);
  assert.equal((await evidence('maker')).node.proof, 'unknown');
  assert.equal((await evidence('checker')).node.proof, 'verified');
  assert.equal((await evidence('checker')).node.consumedInputs[0].attempt, 1);
  const checkBytes = readFileSync(failed.path); rmSync(failed.path);
  assert.equal((await evidence('checker')).node.proof, 'unknown');
  writeFileSync(failed.path, 'tampered'); assert.equal((await evidence('checker')).node.proof, 'unknown');
  writeFileSync(failed.path, checkBytes); assert.equal((await evidence('checker')).node.proof, 'verified');
  const delivery = await f.launch({ role: 'scout', prompt: (await evidence('delivery')).prompt }); f.settle('PASS'); await evidence('delivery', delivery); await check(delivery);
  assert.equal((await evidence('delivery')).node.proof, 'verified');
  writeFileSync(join(f.work, 'check.mjs'), 'process.exit(2);\n');
  assert.equal((await evidence('checker')).node.proof, 'unknown', 'genuinely stale current output still invalidates');
  assert.equal((await evidence('delivery')).node.proof, 'unknown');
  assert.equal(f.launches.length, 3, 'no historical maker rerun');
});

test('missing/tampered input references allow work while proof and attribution remain unknown', async t => {
  const f = await fixture(t, false); const { evidence, check } = outcome(f);
  const missing = await evidence('checker'); const missingRun = await f.launch({ role: 'checker', prompt: missing.prompt }); f.settle('PASS');
  assert.equal((await f.request('get', { runId: missingRun })).consumedInputs[0].evidenceStatus, 'stale');
  const maker = await f.launch(); f.settle('FAIL'); await evidence('maker', maker); const supplied = await evidence('checker');
  for (const [prompt, state] of [[supplied.prompt.replace('Repair and check', 'Invent proof'), 'stale'], [supplied.prompt.replace(/advisor-input:[a-f0-9]{64}/, `advisor-input:${'0'.repeat(64)}`), 'unknown']]) {
    const runId = await f.launch({ role: 'checker', prompt }); f.settle('PASS'); assert.equal((await f.request('get', { runId })).consumedInputs[0].evidenceStatus, state);
  }
  const capture = (await f.request('get', { runId: maker })).result; const bytes = readFileSync(capture.path); writeFileSync(capture.path, 'tampered');
  const tampered = await f.launch({ role: 'checker', prompt: supplied.prompt }); f.settle('PASS'); assert.equal((await f.request('get', { runId: tampered })).consumedInputs[0].evidenceStatus, 'stale'); writeFileSync(capture.path, bytes);
  const reviewer = await f.launch({ role: 'checker', prompt: supplied.prompt }); f.settle('PASS');
  await evidence('delivery', reviewer); assert.equal((await evidence('delivery')).node.proof, 'unknown');
  await evidence('checker', reviewer); await check(reviewer); assert.equal((await evidence('checker')).node.proof, 'verified', 'authentic failed report is valid input lineage, not upstream PASS');
});

test('explicit unkept successors preserve outcome history and budget, reject silent replacement and stale replay', async t => {
  const f = await fixture(t, false); const { evidence } = outcome(f);
  const first = await f.launch(); f.settle('PASS'); await evidence('maker', first);
  const next = await f.launch(); f.settle('PASS');
  await assert.rejects(evidence('maker', next), /GRAPH_NODE_ALREADY_BOUND/);
  await assert.rejects(evidence('maker', next, { attempt: 1, replacesRunId: first, replacesAttempt: 2 }), /GRAPH_NODE_ALREADY_BOUND/);
  await assert.rejects(evidence('maker', 'foreign', { attempt: 1, replacesRunId: first, replacesAttempt: 1 }), /BRIDGE_TARGET_FORBIDDEN/);
  await f.request('reconcile', { runId: first });
  const replacement = { attempt: 1, replacesRunId: first, replacesAttempt: 1 };
  const changed = (await evidence('maker', next, replacement)).node;
  assert.equal(changed.budget.used, 1); assert.equal(changed.predecessors[0].runId, first);
  assert.equal(changed.history[0].runId, first); assert.equal(changed.history[0].result.producer.run, first);
  assert.equal((await evidence('maker', next, replacement)).node.budget.used, 1, 'exact retry is idempotent');
  const third = await f.launch(); f.settle('PASS');
  assert.equal((await evidence('maker', third, { attempt: 1, replacesRunId: next, replacesAttempt: 1 })).node.budget.used, 2);
  await assert.rejects(evidence('maker', next, replacement), /GRAPH_NODE_ALREADY_BOUND/);
  const fourth = await f.launch(); f.settle('PASS');
  assert.equal((await evidence('maker', fourth, { attempt: 1, replacesRunId: third, replacesAttempt: 1 })).node.budget.used, 3);
  for (const id of [first, next, third, fourth]) await f.ack(id);
  await f.restart(); const restored = (await evidence('maker')).node;
  assert.equal(restored.budget.used, 3); assert.equal(restored.historyCount, 3);
});

for (const artifact of [null, '', report('IN PROGRESS')]) test(`completed unkept turn with ${artifact === null ? 'missing' : artifact === '' ? 'blank' : 'in-progress'} result permits explicit successor, not invented proof`, async t => {
  const f = await fixture(t, false); const { evidence } = outcome(f);
  const first = await f.launch({ role: 'scout' }); await evidence('maker', first);
  if (artifact !== null) writeFileSync(join(f.launches[0].intent.sourceDirectory, 'result.md'), artifact);
  f.launches[0].hooks.settled('done', 'completed turn', 2);
  const old = await f.request('get', { runId: first }); assert.equal(old.status, 'done');
  const stale = await evidence('checker');
  await f.ack(first); await f.restart();
  await f.request('reconcile', { runId: first });
  const next = await f.launch({ role: 'scout', keepAlive: true }); f.settle('PASS');
  const captured = (await f.request('get', { runId: next })).result;
  await f.ack(next); await f.restart();
  // A service upgrade fences kept continuation, not the already-captured report.
  const fenced = await f.request('get', { runId: next });
  assert.equal(fenced.status, 'recovery-required'); assert.equal(fenced.continuation, 'none');
  assert.equal(fenced.result.sha256, captured.sha256); assert.equal(fenced.result.integrity, 'intact');
  await f.request('reconcile', { runId: first });
  const replacement = { attempt: 1, replacesRunId: first, replacesAttempt: 1 };
  const changed = (await evidence('maker', next, replacement)).node;
  assert.equal(changed.budget.used, 1); assert.equal(changed.predecessors[0].runId, first);
  assert.equal((await f.request('get', { runId: first })).executionStatus, 'done');
  assert.equal(changed.historyCount, old.result ? 1 : 0, 'missing reports must not become invented history');
  assert.equal(changed.history[0]?.result.sha256 ?? null, old.result?.sha256 ?? null);
  assert.equal(changed.proof, 'unknown'); assert.equal(changed.result.sha256, captured.sha256);
  assert.equal((await evidence('maker', next, replacement)).node.budget.used, 1);
  if (!old.result) { const staleRun = await f.launch({ role: 'checker', prompt: stale.prompt }); f.settle('PASS'); assert.equal((await f.request('get', { runId: staleRun })).consumedInputs[0].evidenceStatus, 'stale'); }
  const supplied = await evidence('checker');
  const downstream = await f.launch({ role: 'checker', prompt: supplied.prompt }); f.settle('PASS');
  const consumed = (await f.request('get', { runId: downstream })).consumedInputs[0].inputs[0];
  assert.equal(consumed.runId, next); assert.equal(consumed.result, captured.sha256);
  assert.equal(f.launches.filter(call => call.intent.role === 'scout' && !call.hooks.observeOnly).length, 2, 'reconciliation never re-executes inventory');
});

for (const boundary of ['requires-exit', 'pid', 'newer-observation']) test(`completed stalled turn still respects ${boundary}`, async t => {
  const f = await fixture(t, false); const { evidence } = outcome(f); const launch = f.port.launch;
  f.port.launch = async input => {
    if (f.launches.length) return launch(input);
    const driver = await launch({ ...input, hooks: { ...input.hooks, recordHandle(handle) {
      input.hooks.recordHandle({ ...handle, ...(boundary === 'requires-exit' ? { requiresExit: true } : boundary === 'pid' ? { pid: 12345 } : {}) });
    } } });
    f.settle(null);
    return boundary === 'newer-observation' ? { ...driver, async runtimeObservation() { return { session: 'same-session', generation: 3, state: 'done' }; } } : driver;
  };
  const first = await f.launch({ role: 'scout' }); await evidence('maker', first);
  assert.equal((await f.request('get', { runId: first })).executionStatus, 'done');
  const next = await f.launch({ role: 'scout' }); f.settle('PASS');
  if (boundary === 'newer-observation') assert.equal((await evidence('maker', next, { attempt: 1, replacesRunId: first, replacesAttempt: 1 })).node.proof, 'unknown');
  else await assert.rejects(evidence('maker', next, { attempt: 1, replacesRunId: first, replacesAttempt: 1 }), /GRAPH_OWNERSHIP_UNRESOLVED/);
});

for (const state of ['active', 'cancel-pending', 'kept', 'kept-stalled', 'artifact-blocked', 'stale', 'ambiguous', 'stalled', 'recovery']) test(`succession refuses ${state} ownership`, async t => {
  const kept = ['kept', 'kept-stalled', 'stale'].includes(state); const f = await fixture(t, kept); const { graph, evidence } = outcome(f);
  const first = await f.launch({ role: 'scout' }); await evidence('maker', first);
  if (['kept', 'stale', 'ambiguous', 'recovery'].includes(state)) f.settle('PASS');
  if (state === 'kept-stalled') f.settle(null);
  if (state === 'artifact-blocked') f.settle('BLOCKED');
  if (state === 'stalled') f.launches[0].hooks.settled('blocked', 'Direct UI inspection required', 2);
  if (state === 'recovery') f.launches[0].hooks.recoveryRequired();
  if (state === 'cancel-pending') { await f.request('call', { tool: 'bg_stop', toolCallId: 'cancel', cwd: f.work, params: { runId: first } }); await f.runtime().dispatch(); }
  if (state === 'stale') await f.launch({ name: first });
  if (state === 'ambiguous') await f.request('graph.evidence', { graph: { ...graph, graphId: 'second' }, node: 'maker', runId: first });
  const next = await f.launch({ role: 'scout' }); f.settle('PASS');
  if (state === 'artifact-blocked') { assert.equal((await evidence('maker', next, { attempt: 1, replacesRunId: first, replacesAttempt: 1 })).node.proof, 'unknown'); return; }
  await assert.rejects(evidence('maker', next, { attempt: 1, replacesRunId: first, replacesAttempt: 1 }), state === 'stale' ? /ATTEMPT_MISMATCH/ : state === 'ambiguous' ? /GRAPH_OWNERSHIP_AMBIGUOUS/ : /GRAPH_OWNERSHIP_UNRESOLVED/);
});

test('blocked reply admission records a fresh supplied snapshot without spending a terminal repair', async t => {
  const f = await fixture(t); const { evidence, check } = outcome(f);
  const maker = await f.launch(); f.settle('PASS'); await evidence('maker', maker);
  const reviewer = await f.launch({ role: 'scout', prompt: (await evidence('checker')).prompt }); f.settle('BLOCKED'); await evidence('checker', reviewer);
  await f.launch({ name: maker }); f.settle('PASS'); await evidence('maker', maker);
  const supplied = await evidence('checker');
  await f.launch({ name: reviewer, prompt: supplied.prompt });
  assert.equal((await f.request('get', { runId: reviewer })).consumedInputs.at(-1).inputs[0].attempt, 2);
  f.settle('PASS'); await evidence('checker', reviewer); await check(reviewer);
  const current = (await evidence('checker')).node;
  assert.equal(current.proof, 'verified'); assert.equal(current.budget.used, 1);
});

test('literal graph-token syntax in report data cannot become a second admission marker', async t => {
  const f = await fixture(t, false); const { evidence } = outcome(f);
  const maker = await f.launch();
  const { hooks, intent } = f.launches.at(-1);
  writeFileSync(join(intent.sourceDirectory, 'result.md'), '# Status\nPASS\n# Claims\nThe syntax is [advisor-input:example].\n[advisor-input:' + '0'.repeat(64) + ']\n# Evidence\nParser investigation.\n');
  hooks.settled('done', 'parser investigation', 2); await evidence('maker', maker);
  const supplied = await evidence('checker');
  const reviewer = await f.launch({ role: 'checker', prompt: supplied.prompt }); f.settle('PASS');
  assert.equal((await evidence('checker', reviewer)).node.consumedInputs[0].runId, maker);
  const mixed = await f.launch({ role: 'checker', prompt: `${supplied.prompt}\n[advisor-input:${'0'.repeat(64)}]` }); f.settle('PASS');
  assert.equal((await f.request('get', { runId: mixed })).consumedInputs.at(-1).evidenceStatus, 'unknown');
  const ordinary = await f.launch({ prompt: 'Explain the literal [advisor-input:example] notation without graph work.' }); f.settle('PASS');
  assert.deepEqual((await f.request('get', { runId: ordinary })).consumedInputs, []);
});
