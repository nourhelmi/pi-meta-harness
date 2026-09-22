import type { AgentRouterConfiguration } from './agent-router.mjs';
import type { ChildScope } from './child-scope.mjs';

export interface RouterControlStatus {
  version: 1;
  sessionId: string;
  enabled: boolean;
  generation: number;
  templatePath: string | null;
  error?: string;
}
export interface JevRouterDefaults {
  version: 1;
  enabled: boolean;
  configPath: string | null;
}
export interface RouterControlCapture {
  readonly enabled: boolean;
  readonly generation: number;
  readonly snapshot: Readonly<AgentRouterConfiguration> | null;
  readonly templatePath: string | null;
  readonly snapshotSha256: string | null;
  readonly error?: string;
}
export interface AgentRouterControl {
  status(): RouterControlStatus;
  capture(): RouterControlCapture;
  snapshot(): Readonly<AgentRouterConfiguration>;
  set(value: { enabled: boolean; expectedGeneration: number }): Promise<RouterControlStatus>;
  seedChild(selection: RouterControlCapture, intent: { environment?: Record<string, string> }, scope?: { childState?: string }): void;
}
export function readJevRouterDefaults(env?: NodeJS.ProcessEnv): JevRouterDefaults;
export function writeJevRouterDefaults(value: JevRouterDefaults, env?: NodeJS.ProcessEnv): JevRouterDefaults;
export function createAgentRouterControl(options: {
  stateRoot: string;
  sessionId: string;
  allowedRoots: string[];
  allowInitialize?: boolean;
  childGrant?: ChildScope | { v: 1 } | null;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  assertOwner?: () => void;
}): AgentRouterControl | null;
