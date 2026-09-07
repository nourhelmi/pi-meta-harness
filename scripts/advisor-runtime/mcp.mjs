import { LIMITS, MUTATIONS, OPERATIONS, fields } from './contract.mjs';
import { callSocket } from './service.mjs';
import { RuntimeError, demand } from './security.mjs';

const toolName = op => `advisor_${op.replaceAll('.', '_')}`;
export const runtimeTools = OPERATIONS.map(op => ({
  name: toolName(op), description: `Scoped advisor runtime ${op}. Requires an exact trusted principal grant. No implicit delegation or scheduling.`,
  inputSchema: { type: 'object', additionalProperties: false, required: ['v', 'scope', 'payload', ...(MUTATIONS.includes(op) ? ['commandId', 'expectedRevision'] : [])],
    properties: { v: { const: 1 }, scope: { type: 'object', additionalProperties: false, required: ['workstream', 'run', 'node', 'ownerEpoch'], properties: { workstream: { type: 'string' }, run: { type: 'string' }, node: { type: 'string' }, ownerEpoch: { type: 'integer', minimum: 1 } } }, payload: { type: 'object' }, ...(MUTATIONS.includes(op) ? { commandId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 } } : {}) } },
}));

/** JSON-RPC/MCP operational transport only; credentials remain in its private host. */
export function createMcpHandler(credential) {
  let initialized = false;
  return async input => {
    const requestId = typeof input?.id === 'string' || Number.isSafeInteger(input?.id) ? input.id : null;
    try {
      fields(input, ['jsonrpc', 'method'], ['id', 'params']); demand(input.jsonrpc === '2.0', 'INVALID_JSONRPC');
      if (input.method === 'notifications/initialized') { demand(initialized && !Object.hasOwn(input, 'id'), 'INVALID_NOTIFICATION'); return null; }
      demand(requestId !== null, 'REQUEST_ID_REQUIRED');
      let result;
      if (input.method === 'initialize') {
        fields(input.params, ['protocolVersion', 'capabilities', 'clientInfo']);
        demand(['2024-11-05', '2025-03-26', '2025-06-18'].includes(input.params.protocolVersion), 'UNSUPPORTED_PROTOCOL');
        initialized = true;
        result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'advisor-runtime', version: '1.0.0' } };
      } else {
        demand(initialized, 'NOT_INITIALIZED');
        if (input.method === 'tools/list') {
          fields(input.params ?? {}, []);
          const grants = await callSocket(credential, { v: 1, op: 'capabilities' }, 'model');
          demand(grants.ok, grants.error ?? 'UNAUTHORIZED');
          result = { tools: runtimeTools.filter(tool => grants.value.operations.some(op => toolName(op) === tool.name)) };
        }
        else if (input.method === 'tools/call') {
          fields(input.params, ['name', 'arguments']);
          const op = OPERATIONS.find(op => toolName(op) === input.params.name); demand(op, 'UNKNOWN_TOOL');
          demand(!Object.hasOwn(input.params.arguments, 'op'), 'EXTRA_FIELD');
          const response = await callSocket(credential, { ...input.params.arguments, op }, 'model');
          result = { content: [{ type: 'text', text: JSON.stringify(response) }], isError: !response.ok };
        } else throw new RuntimeError('METHOD_NOT_FOUND');
      }
      return { jsonrpc: '2.0', id: requestId, result };
    } catch (error) { return { jsonrpc: '2.0', id: requestId, error: { code: -32600, message: error instanceof RuntimeError ? error.code : 'INVALID_REQUEST' } }; }
  };
}

/** Bounded newline framing, sequential requests; no readline's unbounded line buffer. */
export async function serveMcp(credential, input = process.stdin, output = process.stdout) {
  const handle = createMcpHandler(credential);
  let pending = Buffer.alloc(0); let count = 0;
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    demand(pending.length <= LIMITS.envelope * 2, 'ENVELOPE_TOO_LARGE');
    let newline;
    while ((newline = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
      demand(line.length <= LIMITS.envelope && ++count <= LIMITS.requests, 'REQUEST_LIMIT');
      let request;
      try { request = JSON.parse(line.toString('utf8')); } catch { throw new RuntimeError('INVALID_JSON'); }
      const result = await handle(request);
      if (result) { const encoded = JSON.stringify(result) + '\n'; demand(Buffer.byteLength(encoded) <= LIMITS.reply, 'RESPONSE_TOO_LARGE'); output.write(encoded); }
    }
  }
  demand(pending.length === 0, 'TRUNCATED_REQUEST');
}
