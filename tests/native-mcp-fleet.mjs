// A deterministic protocol actor, not an LLM. Exercises the root's actual scoped MCP subprocess.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
export async function runFixtureFleet(config, cwd, adapter) {
  const child = spawn(config.command, config.args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let serial = 0; const pending = new Map(); let closed = false;
  const rejectPending = () => { closed = true; for (const entry of pending.values()) entry.reject(new Error('fixture MCP exited')); pending.clear(); };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { const message = JSON.parse(line); const entry = pending.get(message.id); pending.delete(message.id); entry?.resolve(message); } catch { rejectPending(); child.kill('SIGTERM'); } });
  child.once('error', rejectPending); child.once('exit', rejectPending);
  child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const rpc = (method, params) => new Promise((resolve, reject) => { if (closed) return reject(new Error('fixture MCP closed')); const id = ++serial; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const scope = node => ({ workstream: 'work', run: 'run', node, ownerEpoch: 1 });
  const tool = async (op, payload = {}, node = 'root', extra = {}) => {
    const response = await rpc('tools/call', { name: `advisor_${op.replaceAll('.', '_')}`, arguments: { v: 1, scope: scope(node), payload, ...extra } });
    assert.ok(!response.error, JSON.stringify(response)); return JSON.parse(response.result.content[0].text);
  };
  const mutation = async (op, payload, node = 'root') => {
    for (let tries = 0; tries < 8; tries++) {
      const state = await tool('progress', {}, node); assert.equal(state.ok, true);
      const extra = { commandId: randomUUID(), expectedRevision: state.value.revision };
      const result = await tool(op, payload, node, extra);
      if (result.error === 'STALE_REVISION') continue;
      assert.equal(result.ok, true, JSON.stringify(result)); return { result, extra };
    }
    throw new Error('fixture CAS bound');
  };
  try {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'root-fixture', version: '1' } });
    const list = (await rpc('tools/list', {})).result.tools; assert.ok(list.some(t => t.name === 'advisor_node_launch')); assert.ok(!list.some(t => t.name === 'advisor_root_create'));
    await mutation('packet.admit', { node: 'maker', packet: { role: 'builder', task: 'complete', acceptance: ['synthetic shared runtime proof'], riskTier: 'high', cwd, adapter, model: 'fixture', thinking: 'high' } });
    const launch = await mutation('node.launch', { node: 'maker' });
    const replay = await tool('node.launch', { node: 'maker' }, 'root', launch.extra); assert.equal(replay.replayed, true);
    for (let i = 0; i < 32; i++) {
      const deliveries = await tool('wait', { timeoutMs: 1000, limit: 32 }); assert.equal(deliveries.ok, true);
      let done = false;
      for (const delivery of deliveries.value) { done ||= delivery.status === 'done'; await mutation('delivery.ack', { deliveryId: delivery.id }); }
      if (done) {
        const artifact = await tool('artifact.read', { path: 'result.md', offset: 0, maxBytes: 16384 }, 'maker'); assert.equal(artifact.ok, true); return `Root synthesized durable maker evidence: ${artifact.value.text}`;
      }
    }
    throw new Error('fixture wait bound');
  } finally { clearTimeout(timer); child.stdin.end(); lines.close(); child.kill('SIGTERM'); }
}
