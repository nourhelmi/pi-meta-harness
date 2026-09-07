import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { claudeResult } from './native-fixture-shapes.mjs';
import { runFixtureFleet } from './native-mcp-fleet.mjs';

export function mockClaude(calls = []) {
  return async () => ({ version: '0.3.263', cliVersion: '2.1.263', query({ prompt, options }) {
    calls.push({ options });
    const values = []; let waiter; let closed = false; let child; let serial = 0; let inputUuid;
    const push = message => { const value = { uuid: randomUUID(), session_id: options.sessionId, ...message }; if (waiter) { waiter({ value, done: false }); waiter = null; } else values.push(value); };
    const finish = (result = '# Status\nPASS\nHermetic native result.') => { push({ ...claudeResult(options.sessionId, inputUuid), result, uuid: randomUUID() }); push({ type: 'system', subtype: 'session_state_changed', state: 'idle' }); };
    // Exercise the adapter's actual custom process callback; no SDK or model is launched.
    child = options.spawnClaudeCodeProcess({ command: 'mock-sdk', args: [], env: {}, cwd: options.cwd });
    push({ type: 'system', subtype: 'init', claude_code_version: '2.1.263', cwd: options.cwd, model: 'observed-fixture', tools: options.tools, agents: [], skills: [], plugins: [], mcp_servers: Object.keys(options.mcpServers).map(name => ({ name, status: 'connected' })), permissionMode: 'default', capabilities: ['interrupt_receipt_v1'], apiKeySource: 'none', slash_commands: [], output_style: 'default' });
    void (async () => {
      for await (const message of prompt) {
        calls.push({ input: message }); serial++; inputUuid = message.uuid;
        let text = message.message.content;
        if (text.includes('\nPacket: ')) text = JSON.parse(text.split('\nPacket: ')[1]).task;
        push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working.' } } });
        if (text.includes('fleet-launch')) finish(await runFixtureFleet(options.mcpServers.advisor_runtime, options.cwd, 'claude-code'));
        else if (text.includes('unknown-event')) push({ type: 'future-event' });
        else if (text.includes('nested-agent')) push({ type: 'system', subtype: 'task_started', subagent_type: 'Agent', spawn_depth: 1 });
        else if (text.includes('foreign-thread')) push({ type: 'result', session_id: 'foreign' });
        else if (text.includes('permission') || text.includes('question')) {
          const asking = text.includes('question');
          const response = await options.canUseTool(asking ? 'AskUserQuestion' : 'Write', asking ? { questions: [{ question: 'A or B?', header: 'Choice', multiSelect: false, options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] } : { file_path: options.cwd + '/test.txt', content: 'test' }, { signal: new AbortController().signal, requestId: `request-${serial}`, toolUseID: `tool-${serial}` });
          calls.push({ response }); if (!closed) finish();
        } else if (!text.includes('hold-turn')) finish();
      }
    })();
    return { [Symbol.asyncIterator]() { return this; }, next() { if (values.length) return Promise.resolve({ value: values.shift(), done: false }); if (closed) return Promise.resolve({ done: true }); return new Promise(resolve => { waiter = resolve; }); },
      async initializationResult() { return { hooks_applied: true }; },
      async interrupt() { calls.push({ interrupt: true }); setImmediate(finish); return { still_queued: [] }; },
      close() { closed = true; waiter?.({ done: true }); waiter = null; setImmediate(() => child.emit('exit', 0)); },
    };
  } });
}
export function mockClaudeProcess() { const p = new EventEmitter(); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.kill = () => { p.emit('exit', 0); return true; }; return p; }
