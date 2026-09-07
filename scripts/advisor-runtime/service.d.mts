export interface RuntimeCredential {
  v: 1;
  socketPath: string;
  token: string;
}

export interface RuntimeService {
  socketPath: string;
  close(): Promise<void>;
}

export function startService(runtime: { stateRoot: string }, options?: { keepAlive?: boolean }): Promise<RuntimeService>;
export function writeCredential(path: string, credential: { socketPath: string; token: string }, runtime: { stateRoot: string; protectControlPath(path: string): string }): void;
export function readStoredCredential(path: string): RuntimeCredential;
export function readCredential(path: string): RuntimeCredential;
export function callSocket(
  credential: RuntimeCredential,
  command: unknown,
  audience?: "operator" | "model",
): Promise<unknown>;
