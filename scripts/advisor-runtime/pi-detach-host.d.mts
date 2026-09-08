import { AdvisorRuntime } from './runtime.mjs';
export function hostPiDetach(options: { stateRoot: string; cwd: string; sessionId: string; credentialPath: string; port: unknown; slots?: number; managedIdentity?: object; maxLaunches?: number; revision?: string | null; keepAlive?: boolean }): Promise<{ runtime: AdvisorRuntime; service: { socketPath: string; close(): Promise<void> } }>;
