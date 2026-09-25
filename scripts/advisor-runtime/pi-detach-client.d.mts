export const PI_DETACH_CLIENT_VERSION: 1;
export function createPiDetachClient(path: string, options?: { transport?: (credential: import('./service.mjs').RuntimeCredential, command: unknown, audience: 'model') => Promise<unknown>; admissionTimeoutMs?: number; retryDelayMs?: number }): { request(sessionId: string, action: string, payload: object): Promise<unknown> };
