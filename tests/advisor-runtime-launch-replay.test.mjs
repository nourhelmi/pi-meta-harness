import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostPiDetach } from '../scripts/advisor-runtime/pi-detach-host.mjs';
import { createPiDetachClient } from '../scripts/advisor-runtime/pi-detach-client.mjs';
import { callSocket } from '../scripts/advisor-runtime/service.mjs';

test('a lost launch reply replays the same admission while other launches proceed', { timeout: 5000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-replay-')));
  const cwd = join(root, 'work'); mkdirSync(cwd);
  const stateRoot = join(root, 'state'); mkdirSync(stateRoot, { mode: 0o700 });
  const credentialPath = join(stateRoot, 'pi.json');
  let prepareCount = 0; let launches = 0; let pending = 0; let first = true;
  let releaseFirst, sawPending, enteredFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const firstEntered = new Promise(resolve => { enteredFirst = resolve; });
  const pendingSeen = new Promise(resolve => { sawPending = resolve; });
  const port = {
    version: 1,
    async prepare(params, sourceDirectory) {
      prepareCount++;
      if (params.prompt === 'first') { enteredFirst(); await gate; }
      return { v: 1, command: 'pi --stub', prompt: params.prompt, role: 'builder', runtime: 'pi', model: 'fixture', thinking: 'none', maxTurns: null, requiredSkills: [], harness: 'pi', keepAlive: false, label: 'stub', resultDiscovery: null, resultPolicy: 'runtime-capture', sourceDirectory,
        environment: { ADVISOR_RUNTIME_DESCRIPTOR: '', PI_DETACH_RUNTIME_BRIDGE: '', ADVISOR_BRIDGE_WORKER_DIR: sourceDirectory, ADVISOR_RUNTIME_CANONICAL_OWNER: '1' } };
    },
    async launch({ hooks }) {
      launches++;
      hooks.recordHandle({ id: `stub-${launches}`, session: `stub-${launches}` });
      hooks.settled('done', 'done', 1);
      return { async interrupt() {}, async readLive() { return 'done'; } };
    },
  };
  const host = await hostPiDetach({ stateRoot, cwd, sessionId: 'test-replay', credentialPath, port, slots: 4, keepAlive: false, env: { AGENT_ROUTER_CONFIG: join(root, 'router-disabled.json') } });
  t.after(async () => { releaseFirst(); try { await host.service.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  const transport = async (credential, command, audience) => {
    if (command.payload?.toolCallId === 'first' && first) {
      first = false;
      const original = callSocket(credential, command, audience);
      // The server is still preparing, but the client has lost this socket.
      await firstEntered;
      void original.catch(() => {});
      throw Object.assign(new Error('TRANSPORT_TIMEOUT'), { code: 'TRANSPORT_TIMEOUT' });
    }
    const response = await callSocket(credential, command, audience);
    if (response.error === 'BRIDGE_ADMISSION_PENDING') { pending++; sawPending(); }
    return response;
  };
  const client = createPiDetachClient(credentialPath, { transport, retryDelayMs: 5, admissionTimeoutMs: 3000 });
  const payload = id => ({ tool: 'bg_agent', toolCallId: id, cwd, params: { prompt: id } });
  const recovered = client.request('test-replay', 'call', payload('first'));
  const other = Promise.all(['second', 'third'].map(id => client.request('test-replay', 'call', payload(id))));
  await pendingSeen;
  await assert.rejects(client.request('test-replay', 'call', { ...payload('first'), params: { prompt: 'changed' } }), /COMMAND_ID_REUSE/);
  releaseFirst();
  const [firstResult, others] = await Promise.all([recovered, other]);
  assert.equal(new Set([firstResult.runId, ...others.map(value => value.runId)]).size, 3);
  assert.equal((await client.request('test-replay', 'call', payload('first'))).runId, firstResult.runId);
  await host.runtime.dispatch();
  assert.equal(pending > 0, true);
  assert.equal(prepareCount, 3);
  assert.equal(launches, 3, 'no duplicate worker after the lost reply');
  const unresolved = createPiDetachClient(credentialPath, { transport: async () => ({ ok: false, error: 'BRIDGE_ADMISSION_PENDING' }), admissionTimeoutMs: 0 });
  await assert.rejects(unresolved.request('test-replay', 'call', payload('unresolved')), /PI_DETACH_LAUNCH_UNCONFIRMED: inspect bg_list before another launch/);
  assert.equal(launches, 3, 'unconfirmed admission is never reported as a definite rejection');
  const absent = createPiDetachClient(join(root, 'absent.json'));
  await assert.rejects(absent.request('test-replay', 'call', payload('absent')), /PI_DETACH_BRIDGE_UNAVAILABLE/);
  const unsent = createPiDetachClient(credentialPath, { transport: async () => { throw Object.assign(new Error('TRANSPORT_ERROR'), { code: 'TRANSPORT_ERROR', submitted: false }); } });
  await assert.rejects(unsent.request('test-replay', 'call', payload('unsent')), /PI_DETACH_BRIDGE_UNAVAILABLE/);
});
