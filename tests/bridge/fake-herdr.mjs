// Deterministic CLI endpoint, never a live Herdr or model witness.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const root = process.env.BRIDGE_FAKE_ROOT;
if (!root) throw new Error('FIXTURE_REQUIRED');
const a = process.argv.slice(2);
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(a) + '\n');
const read = pane => JSON.parse(readFileSync(join(root, `${pane.replace(':', '-')}.json`), 'utf8'));
const save = v => writeFileSync(join(root, `${v.pane_id.replace(':', '-')}.json`), JSON.stringify(v));
const ok = v => { console.log(JSON.stringify(v)); };
if (a[0] === 'pane' && a[1] === 'split') {
  const database = process.env.BRIDGE_FAKE_DATABASE;
  const db = new DatabaseSync(database, { readOnly: true });
  const claimed = db.prepare("SELECT * FROM effects WHERE state='claimed'").all();
  if (!claimed.length || claimed.some(e => !db.prepare('SELECT id FROM receipts WHERE id=?').get(JSON.parse(e.data).commandId))) throw new Error('RECEIPT_CLAIM_BEFORE_ACQUISITION');
  db.close();
  const counter = join(root, 'counter');
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 2;
  writeFileSync(counter, String(n)); ok({ pane_id: `w1:p${n}` });
} else if (a[1] === 'process-info') ok({ result: { process_info: { foreground_processes: [{ name: 'zsh' }] } } });
else if (a[1] === 'start') {
  const v = { pane_id: a[a.indexOf('--pane') + 1], name: a[2], agent_session: { source: 'fixture', agent: 'pi', kind: 'id', value: 'fixture-worker' }, status: 'idle', state_change_seq: 1 };
  save(v); ok(v);
} else if (a[0] === 'agent' && a[1] === 'get') ok(read(a[2]));
else if (a[1] === 'prompt') {
  const v = read(a[2]);
  const db = new DatabaseSync(process.env.BRIDGE_FAKE_DATABASE, { readOnly: true });
  const effect = db.prepare("SELECT * FROM effects WHERE state='claimed' AND handle IS NOT NULL").get();
  if (!effect || !JSON.parse(effect.handle).id.includes(v.name)) throw new Error('HANDLE_BEFORE_PROMPT');
  const source = JSON.parse(effect.data).payload.packet?.execution.sourceDirectory;
  db.close();
  if (source) writeFileSync(join(source, 'result.md'), '# Status\nPASS\nDeterministic fake endpoint.');
  v.status = 'done'; v.state_change_seq += 2; save(v); ok(v);
} else if (a[1] === 'wait') {
  if (read(a[2]).status === a[a.indexOf('--until') + 1]) ok(read(a[2]));
  else await new Promise(resolve => { process.on('SIGTERM', () => process.exit(0)); setTimeout(resolve, 15000); });
} else if (a[1] === 'read') console.log('fresh fixture output');
else ok({});
