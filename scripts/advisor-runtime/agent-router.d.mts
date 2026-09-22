export interface AgentRouterConfiguration {
  version: 1;
  enabled: boolean;
  configPath: string;
  modulePath?: string;
}

export function agentRouterConfigPath(env?: NodeJS.ProcessEnv): string;
export function readAgentRouterConfig(options?: { env?: NodeJS.ProcessEnv; configPath?: string }): AgentRouterConfiguration;
export function agentRouterEnabled(options?: { env?: NodeJS.ProcessEnv; configPath?: string }): boolean;
export function createRoutedExecutionPort(port: any, options?: { env?: NodeJS.ProcessEnv; configPath?: string; renewIntervalMs?: number }): any;
