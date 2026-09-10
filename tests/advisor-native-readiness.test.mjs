import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AdvisorRuntime } from '../scripts/advisor-runtime/runtime.mjs';
import { OPERATIONS } from '../scripts/advisor-runtime/contract.mjs';
import { NativeSession } from '../scripts/advisor-runtime/adapters/common.mjs';
const scope = node => ({ workstream: 'work', run: 'run', node, ownerEpoch: 1 });
function fixture(t, finalText) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nv-'))); const cwd = join(base, 'work'); mkdirSync(cwd); const inputs = new Map();
  const adapter = { capabilities: { 'node.launch': true }, async execute(input) {
    inputs.set(input.effect.scope.node, input);
    if (finalText !== undefined) {
      const session = new NativeSession(input, 'codex');
      input.recordHandle({ id: session.id, requiresExit: true });
      session.startTurn(); session.finish('done', finalText);
    } else {
      input.recordHandle({ id: randomUUID(), requiresExit: true });
      writeFileSync(input.context.resultPath, '# Status\nPASS\n\n## Claims\nFixture.\n## Evidence\nDeterministic host.\n## Files\nNone.\n## Decisions\nNone.\n## Remaining Risk\nSynthetic.\n', { mode: 0o600 });
      input.emit({ id: randomUUID(), kind: 'settled', attempt: 1, data: { status: 'done', reason: 'fixture', verified: false } });
    }
    return { accepted: true };
  } };
  const runtime = new AdvisorRuntime({ stateRoot: join(base, 'state'), allowedRoots: [cwd], adapters: { workers: { fixture: adapter } } });
  const token = runtime.registerPrincipal({ id: 'operator', kind: 'operator', scopes: ['root', 'maker', 'second'].map(node => ({ workstream: 'work', run: 'run', node })), operations: OPERATIONS });
  const progress = node => runtime.execute(token, { v: 1, op: 'progress', scope: scope(node), payload: {} }).value;
  const send = (op, payload, node = 'root') => runtime.execute(token, { v: 1, op, scope: scope(node), payload, commandId: randomUUID(), expectedRevision: op === 'workstream.create' ? 0 : progress(node).revision });
  assert.equal(send('workstream.create', { cwd, host: 'codex' }).ok, true);
  for (const node of ['maker', 'second']) assert.equal(send('packet.admit', { node, packet: { role: 'builder', task: 'fixture', acceptance: ['fixture'], riskTier: 'high', cwd, adapter: 'fixture', model: 'fixture', thinking: 'high' } }).ok, true);
  const exit = node => inputs.get(node).emit({ id: randomUUID(), kind: 'process-exited', attempt: 1, data: { code: 0 } });
  t.after(() => { try { for (const node of inputs.keys()) if (progress(node).processExited === undefined) exit(node); for (const d of runtime.execute(token, { v: 1, op: 'wait', scope: scope('root'), payload: { timeoutMs: 0, limit: 128 } }).value) send('delivery.ack', { deliveryId: d.id }); runtime.close(); } finally { rmSync(base, { recursive: true, force: true }); } });
  return { runtime, send, progress, exit, inputs };
}
test('session-only native handles retain shutdown fences, not workspace writer locks', async t => {
  const h = fixture(t); assert.equal(h.send('node.launch', { node: 'maker' }).ok, true); await h.runtime.dispatch();
  assert.equal(h.progress('maker').snapshot.state, 'terminal'); assert.equal(h.progress('maker').handle.pid, undefined);
  assert.throws(() => h.runtime.close(), /SHUTDOWN_ACTIVE/);
  assert.equal(h.send('node.launch', { node: 'second' }).ok, true); await h.runtime.dispatch();
  assert.throws(() => h.runtime.close(), /SHUTDOWN_ACTIVE/);
  h.exit('maker'); h.exit('second');
});
test('trusted readiness rechecks the attested result at dependent wave admission', async t => {
  const h = fixture(t); assert.equal(h.send('graph.admit', { graph: 'graph', waves: [['maker'], ['second']], dependencies: { maker: [], second: ['maker'] }, maxParallel: 1, maxRepairLoops: 0, topology: 'flat-root' }).ok, true);
  assert.equal(h.send('wave.launch', { wave: 1 }).ok, true); await h.runtime.dispatch(); h.exit('maker');
  assert.equal(h.send('wave.launch', { wave: 2 }).error, 'UPSTREAM_NOT_VERIFIED');
  const path = h.inputs.get('maker').context.resultPath; const result = readFileSync(path);
  h.runtime.verifyNode({ scope: scope('maker'), expectedRevision: h.progress('maker').revision, resultSha256: createHash('sha256').update(result).digest('hex'), evidenceSha256: 'a'.repeat(64) });
  writeFileSync(path, '# Status\nPASS\nChanged after verification.\n'); assert.equal(h.send('wave.launch', { wave: 2 }).error, 'VERIFIED_RESULT_CHANGED');
  writeFileSync(path, result); assert.equal(h.send('wave.launch', { wave: 2 }).ok, true); await h.runtime.dispatch(); h.exit('second');
});
test('empty native success remains a blank result and stalls instead of fabricated evidence', async t => {
  const h = fixture(t, ' \n\t');
  assert.equal(h.send('node.launch', { node: 'maker' }).ok, true);
  await h.runtime.dispatch();
  assert.equal(h.progress('maker').status, 'stalled');
  assert.equal(h.progress('maker').verified, false);
  assert.equal(readFileSync(h.inputs.get('maker').context.resultPath, 'utf8'), '');
  h.exit('maker');
});
