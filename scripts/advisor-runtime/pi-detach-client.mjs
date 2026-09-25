import { callSocket, readCredential } from './service.mjs';
import { unwrapAgentMessage } from './messaging-client.mjs';
export const PI_DETACH_CLIENT_VERSION = 1;
export function createPiDetachClient(descriptorPath, { transport = callSocket, admissionTimeoutMs = 60_000, retryDelayMs = 100 } = {}) {
  return {
    async request(sessionId, action, payload) {
      // Retry only the same fresh launch call ID: a timed-out socket does not
      // cancel server preparation, and a new tool call ID would launch twice.
      const launch = action === 'call' && payload?.tool === 'bg_agent' && !payload.params?.name;
      const deadline = Date.now() + admissionTimeoutMs;
      let result; let uncertain = false;
      for (;;) {
        try { result = await transport(readCredential(descriptorPath), { v: 1, op: 'pi.detach', sessionId, action, payload }, 'model'); }
        catch (error) {
          const code = error?.code ?? error?.message;
          if (!launch || !['TRANSPORT_TIMEOUT', 'TRANSPORT_ERROR', 'TRUNCATED_RESPONSE', 'ENOENT'].includes(code) || !uncertain && (code === 'ENOENT' || error?.submitted === false)) throw new Error('PI_DETACH_BRIDGE_UNAVAILABLE');
          result = { ok: false, error: 'BRIDGE_ADMISSION_PENDING' };
        }
        if (!launch || result?.error !== 'BRIDGE_ADMISSION_PENDING') break;
        uncertain = true;
        if (Date.now() >= deadline) throw new Error('PI_DETACH_LAUNCH_UNCONFIRMED: inspect bg_list before another launch');
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
      if (action === 'message') return unwrapAgentMessage(payload, result);
      if (!result?.ok) throw new Error(result?.error ?? 'PI_DETACH_BRIDGE_INVALID_RESPONSE');
      return result.value ?? result.receipt;
    },
  };
}
