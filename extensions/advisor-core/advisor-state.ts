import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { advisorStateRoot, advisorIdentity, advisorPaths, readAdvisorCheckpoint, readAdvisorSession, type AdvisorMode } from '../../scripts/advisor-core/advisor-state.mjs';
export { advisorStateRoot };
export type { AdvisorMode };
export type WorkerHarness = 'pi' | 'native';
export interface AdvisorSessionState {
  workstream: string;
  sessionId: string;
  initializedAt: string;
  workerHarness: WorkerHarness;
  mode?: AdvisorMode;
}
export function isWorkerHarness(value: unknown): value is WorkerHarness { return value === 'pi' || value === 'native'; }
export function restoredEntryState(ctx: ExtensionContext): AdvisorSessionState | undefined {
  for (const entry of ctx.sessionManager.getBranch().toReversed()) {
    if (entry.type !== 'custom' || entry.customType !== 'advisor-session') continue;
    const data = entry.data as Partial<AdvisorSessionState> | undefined;
    if (typeof data?.workstream === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.workstream) && data.workstream.length <= 48 && data.sessionId === ctx.sessionManager.getSessionId() && typeof data.initializedAt === 'string') {
      return { workstream: data.workstream, sessionId: data.sessionId, initializedAt: data.initializedAt, workerHarness: isWorkerHarness(data.workerHarness) ? data.workerHarness : 'pi', ...(data.mode === 'cos' ? { mode: 'cos' as const } : {}) };
    }
  }
  return undefined;
}
export async function restoredState(ctx: ExtensionContext, sessionId = ctx.sessionManager.getSessionId()): Promise<AdvisorSessionState | undefined> {
  return restoredEntryState(ctx) ?? readAdvisorSession({ root: await advisorStateRoot(ctx.cwd), identity: advisorIdentity('pi', sessionId) });
}
/** Session metadata is a pointer, never proof of checkpoint ownership or liveness. */
export async function advisorCheckpoint(ctx: ExtensionContext) {
  const state = await restoredState(ctx);
  if (!state) return undefined;
  const root = await advisorStateRoot(ctx.cwd);
  const identity = advisorIdentity('pi', state.sessionId);
  const path = advisorPaths(root, state.workstream, identity).workstream;
  try {
    const checkpoint = readAdvisorCheckpoint({ root, workstream: state.workstream, identity });
    return { state: { ...state, ...(checkpoint.mode === 'cos' ? { mode: 'cos' as const } : {}) }, path, content: checkpoint.content, digest: checkpoint.digest };
  } catch (error) {
    return { state, path, problem: `Checkpoint missing, corrupt or foreign-owned; operational state is unknown. Recover explicitly before worker effects. ${String(error)}` };
  }
}
