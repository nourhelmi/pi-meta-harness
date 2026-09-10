export function managedBridgeEnabled(env?: NodeJS.ProcessEnv): boolean;
export function configPath(env?: NodeJS.ProcessEnv): string;
export function validateNode(executable: string): string;
export function installedRevision(detachPath: string, hostPath: string): string;
export function closeChildService(childState: string): Promise<'closed' | 'absent'>;
export function closeChildServices(stateRoot: string, reserved?: string[]): Promise<string[]>;
export { readChildScope, type ChildScope } from './child-scope.mjs';
