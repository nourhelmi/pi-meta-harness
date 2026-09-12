export type AdvisorMode = 'advisor' | 'cos';
export interface AdvisorIdentity { host: 'pi' | 'codex' | 'claude-code'; sessionId: string }
export interface AdvisorPaths { root: string; workstream: string; session: string; events: string; lock: string }
export interface CheckpointInput { root: string; workstream: string; identity: AdvisorIdentity }
export interface Checkpoint { paths: AdvisorPaths; content: string; digest: string; mode: AdvisorMode; identity: AdvisorIdentity }
export interface AdvisorState { workstream: string; sessionId: string; initializedAt: string; workerHarness: 'pi' | 'native'; mode: AdvisorMode }
export function advisorStateRoot(cwd: string): Promise<string>;
export function advisorIdentity(host: string, sessionId: string): AdvisorIdentity;
export function nativeAdvisorIdentity(env?: NodeJS.ProcessEnv): AdvisorIdentity;
export function advisorPaths(root: string, workstream: string, identity: AdvisorIdentity): AdvisorPaths;
export function readAdvisorCheckpoint(input: CheckpointInput): Checkpoint;
export function advisorCheckpointOwner(input: CheckpointInput): (AdvisorIdentity & { mode: AdvisorMode }) | undefined;
export function readAdvisorSession(input: { root: string; identity: AdvisorIdentity }): AdvisorState | undefined;
export function claimAdvisorCheckpoint(input: CheckpointInput & { workerHarness?: 'pi' | 'native'; mode?: AdvisorMode; transferFrom?: AdvisorIdentity }): Checkpoint & { state: AdvisorState };
export function updateAdvisorCheckpoint(input: CheckpointInput & { expectedDigest: string; content: string }): Checkpoint;
