import { validateResultArtifact } from '../../advisor-core/result-artifact.mjs';
import { createHash } from 'node:crypto';
import { childWorkSettled } from '../pi-detach-bootstrap.mjs';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, boundedRead, demand, privateDirectory } from '../security.mjs';

/** Service lifetime owns observation. Pi clients never hold execution callbacks. */
export function createPiDetachAdapter(port) {
  demand(port?.version === 1 && typeof port.prepare === 'function' && typeof port.launch === 'function', 'BRIDGE_PORT_VERSION');
  const sessions = new Map();
  return {
    async readLive(run, handle) {
      const live = sessions.get(`${run}/worker`);
      demand(!handle || live?.handle.id === handle.id, 'BRIDGE_HANDLE_MISMATCH');
      return live ? (await live.driver.readLive(400)).slice(-32768) : null;
    },
    capabilities: { 'node.launch': true, 'node.reply': true, 'node.task': true, 'node.cancel': true },
    async execute({ effect, handle, context, recordHandle, emit }) {
      const key = `${effect.scope.run}/${effect.scope.node}`;
      if (effect.op === 'node.cancel') {
        const live = sessions.get(key);
        demand(live && live.handle.id === handle.id, 'BRIDGE_HANDLE_MISMATCH');
        context.assertActive();
        await live.driver.interrupt();
        return { accepted: true };
      }
      const prior = sessions.get(key);
      const intent = effect.op === 'node.launch' ? effect.payload.packet.execution : prior?.intent;
      demand(intent?.v === 1 && intent.sourceDirectory === join(context.artifactDirectory, 'source'), 'BRIDGE_INTENT_MISMATCH');
      demand(effect.op === 'node.launch' ? !prior : prior && prior.handle.id === handle.id, 'BRIDGE_HANDLE_MISMATCH');
      privateDirectory(intent.sourceDirectory);
      // Every admitted attempt owns fresh capture bytes. A reply that does not
      // rewrite its artifact must stall, never inherit the prior BLOCKED result.
      atomicWrite(join(intent.sourceDirectory, 'result.md'), '');
      atomicWrite(join(context.artifactDirectory, "output.log"), "");
      const childState = intent.environment.ADVISOR_BRIDGE_CHILD_STATE;
      if (childState) {
        demand(childState === join(context.artifactDirectory, '../../../children', createHash('sha256').update(effect.scope.run).digest('hex').slice(0, 20)), 'BRIDGE_CHILD_SCOPE_MISMATCH');
        privateDirectory(childState);
        const grant = join(childState, 'child-grant.json');
        if (!existsSync(grant)) writeFileSync(grant, JSON.stringify({ v: 1, cwd: context.cwd, stateRoot: childState }), { flag: 'wx', mode: 0o600 });
      }
      let boundHandle;
      const driver = await port.launch({ id: effect.scope.run, cwd: context.cwd, intent,
        ...(effect.op !== 'node.launch' ? { reply: effect.payload.text } : {}),
        hooks: {
          ...(handle ? { expectedHandle: handle, expectedGeneration: effect.executionObservation?.generation } : {}),
          assertActive: context.assertActive,
          ...(childState ? { childrenSettled: () => childWorkSettled(childState) } : {}),
          recordHandle(value) { recordHandle(value); boundHandle = value; },
          recoveryRequired: context.recoveryRequired,
          settled(state, output, generation) {
            context.assertActive();
            atomicWrite(join(context.artifactDirectory, 'output.log'), output.slice(-32768));
            let validation;
            try {
              const captured = boundedRead(intent.sourceDirectory, 'result.md', 65536);
              demand(captured.eof, 'RESULT_TOO_LARGE');
              atomicWrite(context.resultPath, captured.text);
              validation = validateResultArtifact(captured.text);
            } catch {
              // Missing/unreadable bytes cannot inherit a previous attempt's PASS.
              atomicWrite(context.resultPath, '');
            }
            // Actual terminal UI blocking has no typed safe reply. Artifact
            // BLOCKED from a settled turn is classified by the core itself.
            emit({ id: `${effect.id}-settled`, kind: 'settled', attempt: effect.attempt, data: {
              observation: { handleId: boundHandle.id, generation },
              status: /^FAIL(?:ED)?\b/i.test(validation?.status ?? '') ? 'failed' : state === 'done' || state === 'idle' ? 'done' : 'stalled',
              reason: state === 'blocked' ? 'Herdr UI requires direct inspection; typed reply unavailable' : 'Herdr turn settled; authoritative result captured', verified: false,
            } });
            return Boolean(['done', 'idle'].includes(state) && validation?.valid && validation.classification === 'terminal' && !/^FAIL(?:ED)?\b/i.test(validation.status ?? ''));
          },
        },
      });
      demand(boundHandle, 'HANDLE_REQUIRED');
      sessions.set(key, { intent, handle: boundHandle, driver });
      return { accepted: true };
    },
  };
}
