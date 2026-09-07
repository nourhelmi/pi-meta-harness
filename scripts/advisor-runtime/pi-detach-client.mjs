import { callSocket, readCredential } from './service.mjs';
export const PI_DETACH_CLIENT_VERSION = 1;
export function createPiDetachClient(descriptorPath) {
  return {
    async request(sessionId, action, payload) {
      let result;
      try { result = await callSocket(readCredential(descriptorPath), { v: 1, op: 'pi.detach', sessionId, action, payload }, 'model'); }
      catch { throw new Error('PI_DETACH_BRIDGE_UNAVAILABLE'); }
      if (!result?.ok) throw new Error(result?.error ?? 'PI_DETACH_BRIDGE_INVALID_RESPONSE');
      return result.value ?? result.receipt;
    },
  };
}
