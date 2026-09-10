export interface ChildScope {
  v: 2;
  cwd: string;
  stateRoot: string;
  allowedRoots: string[];
  parent: { stateRoot: string; sessionId: string; scope: { workstream: string; run: string; node: string; ownerEpoch: number } };
  family: { v: 1; id: string; rootStateRoot: string; workstream: string; workerHarness?: 'pi' | 'native' };
  /** Provenance only. The stable parent scope is not frozen to this attempt. */
  issuedAttempt: number;
}
export function readChildScope(options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<ChildScope | null>;
