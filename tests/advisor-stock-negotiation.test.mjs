import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { createMcpHandler, serveMcp } from '../scripts/advisor-runtime/mcp.mjs';

const initialize = protocolVersion => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'native-client', version: '1' } } });
const facade = { tools: [], call() { assert.fail('Negotiation must never enter the runtime facade'); } };

for (const version of ['2024-11-05', '2025-03-26', '2025-06-18']) {
  test(`stock preserves mutually supported ${version}`, async () => {
    assert.equal((await createMcpHandler(null, facade)(initialize(version))).result.protocolVersion, version);
  });
}
for (const version of ['2025-11-25', '2099-01-01']) {
  test(`stock negotiates supported version for ${version}; strict entry unchanged`, async () => {
    const handler = createMcpHandler(null, facade);
    const response = await handler(initialize(version));
    assert.equal(response.result.protocolVersion, '2025-06-18');
    assert.deepEqual(response.result.capabilities, { tools: {} });
    assert.equal(await handler({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.deepEqual((await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).result.tools, []);
    assert.equal((await createMcpHandler(null)(initialize(version))).error.message, 'UNSUPPORTED_PROTOCOL');
  });
}
test('malformed stock version rejects without initializing or calling facade', async () => {
  for (const value of [null, 42, {}, [], '', 'x'.repeat(65)]) {
    const handler = createMcpHandler(null, facade);
    assert.equal((await handler(initialize(value))).error.message, 'UNSUPPORTED_PROTOCOL');
    assert.equal((await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).error.message, 'NOT_INITIALIZED');
  }
});
test('actual stock framing negotiates then lists tools without a runtime', async () => {
  let output = '';
  const sink = new Writable({ write(chunk, _, done) { output += chunk; done(); } });
  const wire = [initialize('2025-11-25'), { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }].map(JSON.stringify).join('\n') + '\n';
  await serveMcp(null, Readable.from([wire]), sink, createMcpHandler(null, facade));
  const responses = output.trim().split('\n').map(JSON.parse);
  assert.deepEqual(responses.map(r => r.id), [1, 2]);
  assert.equal(responses[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(responses[1].result.tools, []);
});
