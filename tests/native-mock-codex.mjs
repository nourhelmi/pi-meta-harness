// Deterministic test subprocess, never a model host. Protocol fixtures match 0.153.4 generated types.
import { createInterface } from 'node:readline';
import { codexStart, codexThread } from './native-fixture-shapes.mjs';
import { runFixtureFleet } from './native-mcp-fleet.mjs';
let thread = 'thread-owned'; let turn; let serial = 0; let task = ''; let settings;
// Test-only decoder for configArgs' JSON-compatible inline TOML subset. Actual
// producer parsing is separately exercised by the no-model pinned config/read probe.
const config = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '-c') {
  const value = process.argv[++i]; const split = value.indexOf('=');
  config[value.slice(0, split)] = JSON.parse(value.slice(split + 1).replace(/("(?:\\.|[^"\\])*")\s*=/g, '$1:'));
}
const item = (text = '') => ({ type: 'agentMessage', id: 'message-1', text, phase: null, memoryCitation: null, delivery: null, questions: null });
const turnObject = status => ({ id: turn, items: [], itemsView: 'full', status, error: null, startedAt: 1, completedAt: status === 'inProgress' ? null : 2, durationMs: 1 });
function send(...values) {
  const bytes = values.map(v => JSON.stringify(v) + '\n').join('');
  // Exercise split/coalesced lines through a real pipe.
  process.stdout.write(bytes.slice(0, 7)); process.stdout.write(bytes.slice(7));
}
const event = (method, params) => ({ method, params });
function finish(status = 'completed', text = '# Status\nPASS\nHermetic native result.') {
  send(event('item/completed', { threadId: thread, turnId: turn, item: item(text), completedAtMs: 2 }), event('turn/completed', { threadId: thread, turn: turnObject(status) }));
}
createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  if (!r.method) { send(event('serverRequest/resolved', { threadId: thread, requestId: r.id })); finish(); return; }
  if (r.method === 'initialize') send({ id: r.id, result: { userAgent: 'codex-cli/0.153.4', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' } });
  else if (r.method === 'initialized') return;
  else if (r.method === 'config/read') send({ id: r.id, result: { config, origins: {}, layers: null } });
  else if (r.method === 'thread/start') {
    settings = r.params;
    send(event('thread/started', { thread: codexThread(settings.cwd, settings.model) }), { id: r.id, result: codexStart(settings.cwd, settings.model, settings.permissions === 'advisor-task-read-v1') });
  } else if (r.method === 'turn/start') {
    turn = `turn-${++serial}`; task = r.params.input[0].text;
    if (task.includes('\nPacket: ')) task = JSON.parse(task.split('\nPacket: ')[1]).task;
    send(event('turn/started', { threadId: thread, turn: turnObject('inProgress') }), { id: r.id, result: { turn: turnObject('inProgress') } });
    setImmediate(() => {
      send(event('item/started', { threadId: thread, turnId: turn, item: item(), startedAtMs: 1 }), event('item/agentMessage/delta', { threadId: thread, turnId: turn, itemId: 'message-1', delta: 'Working.' }));
      if (task.includes('fleet-launch')) { void runFixtureFleet(settings.config.mcp_servers.advisor_runtime, settings.cwd, 'codex').then(text => finish('completed', text)).catch(() => process.exit(3)); }
      else if (task.includes('unknown-event')) send(event('future/event', { threadId: thread, turnId: turn }));
      else if (task.includes('nested-agent')) send(event('item/started', { threadId: thread, turnId: turn, item: { type: 'collabAgentToolCall', id: 'nested' }, startedAtMs: 1 }));
      else if (task.includes('foreign-thread')) send(event('item/agentMessage/delta', { threadId: 'foreign', turnId: turn, itemId: 'message-1', delta: 'wrong' }));
      else if (task.includes('permission')) send({ id: 'native-request', method: 'item/permissions/requestApproval', params: { threadId: thread, turnId: turn, itemId: 'message-1', environmentId: null, startedAtMs: 1, cwd: settings.cwd, reason: null, permissions: { network: { enabled: true } } } });
      else if (task.includes('question')) send({ id: 'native-request', method: 'item/tool/requestUserInput', params: { threadId: thread, turnId: turn, itemId: 'message-1', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'choice', header: 'Choice', question: 'A or B?', isOther: true, isSecret: false, options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] } });
      else if (!task.includes('hold-turn')) finish();
    });
  } else if (r.method === 'turn/interrupt') { send({ id: r.id, result: {} }); setImmediate(() => finish('interrupted')); }
  else process.exit(2);
});
