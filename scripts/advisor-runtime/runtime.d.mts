export interface RuntimeOptions {
  stateRoot: string;
  allowedRoots: string[];
  controlPaths?: string[];
  controlDirectories?: string[];
  adapters?: Record<string, unknown>;
  fault?: (point: string) => void;
}

export class AdvisorRuntime {
  constructor(options: RuntimeOptions);
  readonly stateRoot: string;
  registerPrincipal(registration: unknown): string;
  protectControlPath(path: string): string;
  revokePrincipal(principalId: string): void;
  execute(token: string, input: unknown, audience?: "operator" | "model"): Record<string, unknown>;
  request(token: string, input: unknown, audience?: "operator" | "model"): Promise<Record<string, unknown>>;
  dispatch(): Promise<void>;
  checkNode(input: { scope: { workstream: string; run: string; node: string; ownerEpoch: number }; command: string; args?: string[]; producer?: string; timeout?: number }): Record<string, unknown>;
  assertClosable(): void;
  close(): void;
}
