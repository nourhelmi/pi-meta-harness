import type { AgentRouterControl } from './agent-router-control.mjs';

export interface AgentRouterConfiguration {
  version: 1;
  enabled: boolean;
  configPath: string;
  modulePath?: string;
}

export function agentRouterConfigPath(env?: NodeJS.ProcessEnv): string;
export function readAgentRouterConfig(options?: { env?: NodeJS.ProcessEnv; configPath?: string }): AgentRouterConfiguration;
export function agentRouterEnabled(options?: { env?: NodeJS.ProcessEnv; configPath?: string }): boolean;
export function loadAgentRouter(config: AgentRouterConfiguration): Promise<{ route: Function; renew: Function; release: Function }>;
export function createRoutedExecutionPort(port: any, options?: { env?: NodeJS.ProcessEnv; configPath?: string; control?: () => AgentRouterControl | null; renewIntervalMs?: number }): any;
