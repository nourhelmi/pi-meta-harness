// Deterministic Herdr protocol endpoint for the stock product test. Never runs a CLI/model.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const root = process.env.STOCK_FAKE_ROOT;
assert.ok(root);
const args = process.argv.slice(2);
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(args) + '\n');
const rootInfo = JSON.parse(readFileSync(join(root, 'root.json'), 'utf8'));
const paneFile = pane => join(root, `${pane.replace(':', '-')}.json`);
const read = pane => JSON.parse(readFileSync(paneFile(pane), 'utf8'));
const save = agent => writeFileSync(paneFile(agent.pane_id), JSON.stringify(agent));
const ok = value => console.log(JSON.stringify(value));
const database = () => new DatabaseSync(join(root, 'state', readdirSync(join(root, 'state'))[0], 'runtime.sqlite'), { readOnly: true });
if (args[0] === 'agent' && args[1] === 'get' && args[2] === rootInfo.agent.pane_id) ok({ result: { agent: rootInfo.agent } });
else if (args[1] === 'process-info') {
  const pane = args[args.indexOf('--pane') + 1];
  if (pane === rootInfo.agent.pane_id) ok({ result: { process_info: rootInfo.info } });
  else {
    const agent = existsSync(paneFile(pane)) ? read(pane) : null;
    ok({ result: { process_info: agent?.agent === 'codex' ? { pane_id: pane, shell_pid: 10, foreground_process_group_id: 20, foreground_processes: [{ name: 'codex', argv0: 'codex', pid: agent.pid }] } : { foreground_processes: [{ name: 'zsh' }] } } });
  }
} else if (args[0] === 'pane' && args[1] === 'split') {
  const db = database();
  const claimed = db.prepare("SELECT * FROM effects WHERE state='claimed'").all();
  assert.ok(claimed.length);
  assert.ok(claimed.every(e => db.prepare('SELECT id FROM receipts WHERE id=?').get(JSON.parse(e.data).commandId)), 'receipt before acquisition'); db.close();
  const counter = join(root, 'counter');
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 2;
  writeFileSync(counter, String(n)); ok({ pane_id: `w1:p${n}` });
} else if (args[1] === 'start') {
  const pane = args[args.indexOf('--pane') + 1]; const kind = args[args.indexOf('--kind') + 1];
  const agent = { pane_id: pane, name: args[2], agent: kind, terminal_id: `terminal-${pane}`, pid: 100 + Number(pane.split('p')[1]), status: 'idle', state_change_seq: 1 };
  if (kind !== 'codex') agent.agent_session = { source: `herdr:${kind}`, agent: kind, kind: 'id', value: `worker-${pane}` };
  save(agent); ok({ result: { agent } });
} else if (args[0] === 'agent' && args[1] === 'get') ok({ result: { agent: read(args[2]) } });
else if (args[1] === 'prompt') {
  const agent = read(args[2]); const db = database();
  const effect = db.prepare("SELECT * FROM effects WHERE state='claimed' AND handle IS NOT NULL").all().find(e => JSON.parse(JSON.parse(e.handle).id)[0] === agent.pane_id);
  assert.ok(effect, 'committed qualified handle before prompt');
  const run = JSON.parse(db.prepare('SELECT data FROM runs WHERE id=?').get(effect.run).data);
  const intent = run.nodes.worker.packet.execution; db.close();
  assert.equal(intent.environment.ADVISOR_RUNTIME_CANONICAL_OWNER, '1');
  assert.equal(intent.environment.ADVISOR_RUNTIME_DESCRIPTOR, ''); assert.equal(intent.environment.PI_DETACH_RUNTIME_BRIDGE, '');
  assert.ok(!Object.keys(intent.environment).some(k => /TOKEN|CONNECTION|GRANT|STOCK_/.test(k)));
  const behavior = JSON.parse(readFileSync(join(root, 'behavior.json'), 'utf8'));
  if (behavior.artifact !== undefined) writeFileSync(join(intent.sourceDirectory, 'result.md'), behavior.artifact);
  agent.agent_session ??= { source: `herdr:${agent.agent}`, agent: agent.agent, kind: 'id', value: `worker-${agent.pid}` };
  agent.status = behavior.status; agent.state_change_seq += 2; save(agent); ok({ result: { agent } });
} else if (args[1] === 'wait') {
  const pane = args[2]; const until = args[args.indexOf('--until') + 1];
  const end = Date.now() + 15000;
  await new Promise(resolve => {
    const check = () => {
      const agent = read(pane);
      if (agent.status === until || Date.now() >= end) { clearInterval(timer); ok({ result: { agent } }); resolve(); }
    };
    const timer = setInterval(check, 20); check();
  });
} else if (args[1] === 'send-keys') {
  assert.equal(args[3], 'esc'); const agent = read(args[2]); agent.status = 'idle'; agent.state_change_seq += 1; save(agent); ok({ result: { agent } });
} else if (args[1] === 'read') console.log('captured stock fixture output');
else ok({});
