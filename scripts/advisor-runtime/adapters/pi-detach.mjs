import { validateResultArtifact } from '../../advisor-core/result-artifact.mjs';
import { canonicalJson } from '../../advisor-core/command-contract.mjs';
import { childWorkSettled, closeChildService } from '../pi-detach-bootstrap.mjs';
import { readChildGrant } from '../child-scope.mjs';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, artifactRead, demand, privateDirectory } from '../security.mjs';

/** Report statuses that end an attempt on their own; anything else with live descendants is a checkpoint. */
const TERMINAL_REPORT = /^(?:PASS|DONE|FAIL(?:ED)?|BLOCKED)\b/i;

/** Copy the worker's own result bytes into the runtime-owned artifact. Missing/unreadable bytes never inherit a prior attempt. */
function captureResult(intent, context) {
  try {
    const captured = artifactRead(intent.sourceDirectory, 'result.md');
    atomicWrite(context.resultPath, captured.text);
    return validateResultArtifact(captured.text);
  } catch {
    atomicWrite(context.resultPath, '');
    return undefined;
  }
}

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
    capabilities: { 'node.launch': true, 'node.reply': true, 'node.task': true, 'node.cancel': true, 'team.assign': true, 'team.message': true, 'node.message': true, 'node.reconcile': true },
    async execute({ effect, handle, context, recordHandle, emit }) {
      const key = `${effect.scope.run}/${effect.scope.node}`;
      if (['team.message', 'node.message'].includes(effect.op)) {
        const live = sessions.get(key);
        demand(live && live.handle.id === handle.id, 'BRIDGE_HANDLE_MISMATCH');
        if (typeof live.driver.message !== 'function') return { accepted: true, delivery: { status: 'rejected', session: handle.session, generation: effect.payload.target.generation, state: 'unsupported' } };
        context.assertActive();
        const delivery = await live.driver.message({ text: effect.payload.text, target: effect.payload.target });
        return { accepted: true, delivery };
      }
      if (effect.op === 'node.cancel') {
        const live = sessions.get(key);
        demand(live && live.handle.id === handle.id, 'BRIDGE_HANDLE_MISMATCH');
        context.assertActive();
        const childState = live.intent.environment.ADVISOR_BRIDGE_CHILD_STATE;
        // Escape is the only input. The node stays cancel-pending until Herdr
        // shows the same occupant settled afterwards; process exit stays unclaimed.
        let cancelled = false;
        await live.driver.interrupt({
          async beforeInterrupt() { if (childState) await context.cancelChildren(childState); },
          settled(state, output, generation, providerSession) {
            context.assertActive();
            if (cancelled) return;
            context.assertSettlement(live.handle.id, generation, true);
            atomicWrite(join(context.artifactDirectory, 'output.log'), output.slice(-32768));
            captureResult(live.intent, context);
            emit({ id: `${effect.id}-cancelled`, kind: 'settled', attempt: effect.attempt, data: {
              observation: { handleId: live.handle.id, generation },
              status: 'cancelled', reason: `Escape delivered; the agent settled ${state} in its pane; process exit unconfirmed`, verified: false,
            } });
            cancelled = true;
          },
          // The turn settled naturally before cancellation began: nothing to emit, no Escape was sent.
          superseded() {},
          recoveryRequired: context.recoveryRequired,
        });
        return { accepted: true };
      }
      const prior = sessions.get(key);
      const reconciling = effect.op === 'node.reconcile';
      let intent = effect.op === 'node.launch' || reconciling ? effect.payload.packet.execution : prior?.intent;
      if (intent && context.execution) intent = { ...intent, keepAlive: context.execution.keepAlive };
      demand(intent?.v === 1 && intent.sourceDirectory === join(context.artifactDirectory, 'source'), 'BRIDGE_INTENT_MISMATCH');
      demand(effect.op === 'node.launch' ? !prior : reconciling ? Boolean(handle) : prior && prior.handle.id === handle.id, 'BRIDGE_HANDLE_MISMATCH');
      privateDirectory(intent.sourceDirectory);
      // Every admitted attempt owns fresh capture bytes. A reply that does not
      // rewrite its report has no report, never inherits the prior attempt's report.
      const childState = intent.environment.ADVISOR_BRIDGE_CHILD_STATE;
      if (!reconciling) {
      atomicWrite(join(intent.sourceDirectory, 'result.md'), '');
      atomicWrite(join(context.artifactDirectory, "output.log"), "");
      atomicWrite(join(context.artifactDirectory, 'request.json'), JSON.stringify(effect.op === 'node.reply' ? { id: effect.payload.requestId, answered: true } : {}));
      if (childState) {
        const expected = await context.reserveChild();
        demand(childState === expected.stateRoot, 'BRIDGE_CHILD_SCOPE_MISMATCH');
        privateDirectory(childState);
        const grant = join(childState, 'child-grant.json');
        if (!existsSync(grant)) writeFileSync(grant, JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
        demand(canonicalJson(readChildGrant(childState, context.cwd)) === canonicalJson(expected), 'PI_DETACH_CHILD_GRANT_MISMATCH');
      }
      }
      let boundHandle; let settlement;
      const driver = await port.launch({ id: effect.scope.run, cwd: context.cwd, intent,
        ...(effect.op !== 'node.launch' && !reconciling ? { reply: effect.payload.text } : {}),
        hooks: {
          ...(handle ? { expectedHandle: handle, expectedGeneration: effect.executionObservation?.generation } : {}),
          assertActive: context.assertActive,
          ...(reconciling ? { observeOnly: true, completed: effect.payload.completed || effect.payload.uncertainInput, expectedProviderSession: effect.payload.providerSession } : {}),
          ...(childState ? { childrenSettled: () => childWorkSettled(childState) } : {}),
          recordHandle(value) { recordHandle(value); boundHandle = value; },
          recoveryRequired: context.recoveryRequired,
          settled(state, output, generation, providerSession) {
            context.assertActive();
            if (settlement) return settlement;
            if (reconciling && (effect.payload.completed || effect.payload.uncertainInput)) {
              context.observeSession({ session: boundHandle.session, generation, state, ...(providerSession ? { providerSession } : {}) });
              return settlement = { terminal: ['done', 'idle'].includes(state), close: false };
            }
            context.assertSettlement(boundHandle?.id, generation);
            atomicWrite(join(context.artifactDirectory, 'output.log'), output.slice(-32768));
            const validation = captureResult(intent, context);
            const reportStatus = validation?.status ?? '';
            const finish = () => {
              // Actual terminal UI blocking has no typed safe reply. Artifact
              // BLOCKED from a settled turn is classified by the core itself.
              emit({ id: `${effect.id}-settled`, kind: 'settled', attempt: effect.attempt, data: {
                observation: { handleId: boundHandle.id, generation, ...(providerSession ? { providerSession } : {}) },
                status: state === 'done' || state === 'idle' ? /^FAIL(?:ED)?\b/i.test(reportStatus) ? 'failed' : 'done' : 'stalled',
                reason: state === 'blocked' ? 'Herdr UI requires direct inspection; typed reply unavailable' : 'Herdr turn settled; authoritative result captured', verified: false,
              } });
              const terminal = ['done', 'idle'].includes(state);
              // A finished, not-kept advisor no longer needs its reserved child service.
              // Refusal (active or uncertain child work) is retried at parent shutdown.
              if (terminal && !intent.keepAlive && childState) void closeChildService(childState).catch(() => {});
              return settlement = { terminal, close: terminal && !/^FAIL(?:ED)?\b/i.test(reportStatus) };
            };
            if (!['done', 'idle'].includes(state) || !childState || TERMINAL_REPORT.test(reportStatus)) return finish();
            // A child advisor that ends a turn without a terminal report while its own
            // descendants still run has checkpointed, not finished: their settlement wakes
            // it for another turn. Keep this attempt open and observe the same occupant.
            return childWorkSettled(childState).then(quiet => {
              context.assertActive();
              if (settlement) return settlement;
              if (quiet) return finish();
              context.observeSession({ session: boundHandle.session, generation, state, ...(providerSession ? { providerSession } : {}) });
              emit({ id: `${effect.id}-progress-${generation}`, kind: 'progress', attempt: effect.attempt, data: {
                note: `Turn settled ${state} with report status ${reportStatus || 'missing'}; descendants are still active, so this attempt stays open and settles on the final turn. Interim report: ${context.resultPath}`,
              } });
              return { terminal: false, close: false, rearm: true };
            });
          },
        },
      });
      demand(boundHandle, 'HANDLE_REQUIRED');
      prior?.driver.detach?.();
      sessions.set(key, { intent, handle: boundHandle, driver });
      const observation = typeof driver.runtimeObservation === 'function' ? await driver.runtimeObservation() : null;
      return { accepted: true, ...(observation ? { observation } : {}) };
    },
  };
}
