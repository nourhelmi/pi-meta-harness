import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hostPiDetach } from '../scripts/advisor-runtime/pi-detach-host.mjs';
import { createPiDetachClient } from '../scripts/advisor-runtime/pi-detach-client.mjs';

const safe = ['BRIDGE_INVALID_INPUT', 'BRIDGE_CUSTOM_ARTIFACT_UNSUPPORTED', 'BRIDGE_EXPLICIT_COMMAND_UNSUPPORTED', 'BRIDGE_FOLLOWUP_REQUIRES_BINDING', 'BRIDGE_EMPTY_PROMPT', 'BRIDGE_INVALID_SKILL'];
for (const thrown of [...safe.map(code => new Error(code)), new Error('secret command /private/credential'), new Error('BRIDGE_CUSTOM_ARTIFACT_UNSUPPORTED secret'), new Error('toString'), 'BRIDGE_EMPTY_PROMPT', { message: 'BRIDGE_EMPTY_PROMPT' }]) {
  const expected = thrown instanceof Error && safe.includes(thrown.message) ? thrown.message : 'BRIDGE_PREPARATION_REJECTED';
  test(`preparation rejection ${String(thrown)} is bounded and replayable`, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-error-')));
    const cwd = join(root, 'work'); mkdirSync(cwd);
    const stateRoot = join(root, 'state'); mkdirSync(stateRoot, { mode: 0o700 });
    const credentialPath = join(root, 'client.json');
    let prepares = 0;
    const host = await hostPiDetach({ stateRoot, cwd, sessionId: 'test-launch', credentialPath, keepAlive: false, port: {
      version: 1,
      async prepare() { prepares++; throw thrown; },
      async launch() { assert.fail('rejected preparation must never execute'); },
    }});
    t.after(async () => { await host.service.close(); rmSync(root, { recursive: true, force: true }); });
    const client = createPiDetachClient(credentialPath);
    const payload = { tool: 'bg_agent', toolCallId: 'same-call', cwd, params: { prompt: 'task' } };
    for (let i = 0; i < 2; i++) await assert.rejects(client.request('test-launch', 'call', payload), error => { assert.equal(error.message, expected); return true; });
    assert.equal(prepares, 1, 'same call replays its rejection instead of preparing again');
    await host.runtime.dispatch();
    const db = new DatabaseSync(join(stateRoot, 'runtime.sqlite'), { readOnly: true });
    try {
      for (const table of ['runs', 'effects', 'events', 'deliveries']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
      const binding = JSON.parse(db.prepare('SELECT data FROM pi_bindings').get().data);
      assert.equal(binding.action, 'rejected');
      assert.deepEqual(binding.response, { ok: false, error: expected });
      assert.ok(!JSON.stringify(binding).includes('secret'));
    } finally { db.close(); }
    await assert.rejects(client.request('test-launch', 'call', { ...payload, params: { prompt: 'changed' } }), /COMMAND_ID_REUSE/);
  });
}
