export const PI_DETACH_CLIENT_VERSION: 1;
export function createPiDetachClient(path: string): { request(sessionId: string, action: string, payload: object): Promise<unknown> };
