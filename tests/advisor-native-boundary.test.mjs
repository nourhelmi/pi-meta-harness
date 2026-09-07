import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { permissionConfig, configArgs, READ_PROFILE, WRITE_PROFILE, preToolGuard, providerEnvironment } from '../scripts/advisor-runtime/native-boundary.mjs';

function setup(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'native-boundary-')));
  for (const name of ['work', 'control', 'auth-home', 'artifacts']) mkdirSync(join(base, name), { mode: 0o700 });
  const cwd = join(base, 'work'); writeFileSync(join(cwd, 'input.txt'), 'TASK_ONLY\n');
  for (const name of ['control', 'auth-home']) writeFileSync(join(base, name, 'dummy.txt'), 'ARTIFICIAL_PRIVATE_FIXTURE\n', { mode: 0o600 });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, cwd, home: join(base, 'auth-home'), controls: [join(base, 'control'), join(base, 'auth-home'), join(base, 'artifacts')] };
}
const run = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c); child.on('error', reject);
  child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ command, args, code, signal, out, err }); });
});

test('N1 actual pinned Codex sandbox allows task read/write and denies sibling, alias, readonly writes and network', { skip: process.platform !== 'darwin' }, async t => {
  const h = setup(t); const env = { HOME: h.home, CODEX_HOME: h.home, PATH: process.env.PATH, LANG: 'en_US.UTF-8' };
  const version = await run('codex', ['--version'], { env }); assert.equal(version.out.trim(), 'codex-cli 0.153.4');
  const config = permissionConfig(h.cwd, h.controls); const evidence = [version];
  const sandbox = async (profile, args) => { const result = await run('codex', ['sandbox', ...configArgs(config), '-P', profile, '-C', h.cwd, '--', ...args], { env, cwd: h.cwd }); evidence.push(result); return result; };
  const allowed = await sandbox(READ_PROFILE, ['/bin/cat', join(h.cwd, 'input.txt')]); assert.equal(allowed.code, 0, allowed.err); assert.equal(allowed.out, 'TASK_ONLY\n');
  const nodeRead = await sandbox(READ_PROFILE, [process.execPath, '-e', "process.stdout.write(require('node:fs').readFileSync('input.txt','utf8'))"]); assert.equal(nodeRead.code, 0, nodeRead.err); assert.equal(nodeRead.out, 'TASK_ONLY\n');
  const written = await sandbox(WRITE_PROFILE, ['/bin/sh', '-c', 'printf WRITTEN > output.txt']); assert.equal(written.code, 0, written.err); assert.equal(readFileSync(join(h.cwd, 'output.txt'), 'utf8'), 'WRITTEN');
  for (const name of ['control', 'auth-home']) {
    const denied = await sandbox(WRITE_PROFILE, ['/bin/cat', join(h.base, name, 'dummy.txt')]); assert.notEqual(denied.code, 0); assert.ok(!denied.out.includes('ARTIFICIAL_PRIVATE_FIXTURE'));
  }
  symlinkSync(join(h.base, 'control'), join(h.cwd, 'alias'));
  const alias = await sandbox(WRITE_PROFILE, ['/bin/cat', join(h.cwd, 'alias/dummy.txt')]); assert.notEqual(alias.code, 0); assert.ok(!alias.out.includes('ARTIFICIAL_PRIVATE_FIXTURE'));
  const readonly = await sandbox(READ_PROFILE, ['/bin/sh', '-c', 'printf FORBIDDEN > readonly.txt']); assert.notEqual(readonly.code, 0);
  let requests = 0; const server = createServer((_req, res) => { requests++; res.end('LOCAL_FIXTURE'); }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const baseline = await run('/usr/bin/curl', ['--max-time', '2', '-sS', url], { env }); evidence.push(baseline); assert.equal(baseline.out, 'LOCAL_FIXTURE');
  const network = await sandbox(WRITE_PROFILE, ['/usr/bin/curl', '--max-time', '2', '-sS', url]); assert.notEqual(network.code, 0); assert.equal(requests, 1);
  if (process.env.NATIVE_BOUNDARY_EVIDENCE_DIR) {
    mkdirSync(process.env.NATIVE_BOUNDARY_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.NATIVE_BOUNDARY_EVIDENCE_DIR, 'codex-sandbox-proof.json'), JSON.stringify({ config, evidence, requests, modelCalls: 0 }, null, 2));
  }
});

test('N2 all-invocation Claude hook protects reads, scans, writes, compound inputs and question/MCP boundaries', t => {
  const h = setup(t); const policy = { cwd: h.cwd, writer: true, root: false };
  const call = (name, input, extra = {}) => preToolGuard(policy, { hook_event_name: 'PreToolUse', cwd: h.cwd, tool_name: name, tool_input: input, ...extra });
  const allow = result => assert.deepEqual(result, { continue: true });
  const deny = result => assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
  allow(call('Read', { file_path: join(h.cwd, 'input.txt') }));
  allow(call('Glob', { pattern: '*.txt' })); allow(call('Grep', { pattern: 'TASK', path: h.cwd }));
  allow(call('Write', { file_path: join(h.cwd, 'new/file.txt'), content: 'task' }));
  for (const tool of ['Read', 'Write']) deny(call(tool, { file_path: join(h.home, 'dummy.txt'), ...(tool === 'Write' ? { content: 'no' } : {}) }));
  deny(call('Read', { file_path: '../work/input.txt' })); deny(call('Read', { file_path: join(h.cwd, 'input.txt'), files: [join(h.home, 'dummy.txt')] }));
  deny(call('Grep', { pattern: 'x', path: h.home })); deny(call('Glob', { pattern: '../**' })); deny(call('Grep', { pattern: 'x', '-n': {} }));
  deny(call('UnknownFileTool', {})); deny(call('Bash', { command: 'cat anything' })); deny(call('Read', { file_path: join(h.cwd, 'input.txt') }, { agent_id: 'nested' }));
  symlinkSync(h.home, join(h.cwd, 'alias')); deny(call('Read', { file_path: join(h.cwd, 'alias/dummy.txt') })); deny(call('Glob', { pattern: '**/*' })); deny(call('Grep', { pattern: 'x' }));
  const questions = { questions: [{ question: 'Choose?', header: 'Choice', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] };
  allow(call('AskUserQuestion', questions));
  const root = { ...policy, root: true, writer: false }; const event = { hook_event_name: 'PreToolUse', cwd: h.cwd, tool_name: 'mcp__advisor_runtime__advisor_progress', tool_input: { v: 1, scope: {}, payload: {} } };
  allow(preToolGuard(root, event)); deny(preToolGuard(policy, event));
  deny(preToolGuard(root, { ...event, tool_name: 'Write', tool_input: { file_path: join(h.cwd, 'new.txt'), content: 'no' } }));
});

test('N3 managed provider state must be explicit and disjoint before creation', t => {
  const h = setup(t); const artifacts = join(h.base, 'artifacts');
  assert.throws(() => providerEnvironment('codex', { HOME: h.home }, h.cwd, artifacts), /MANAGED_PROVIDER_HOME_REQUIRED/);
  assert.throws(() => providerEnvironment('codex', { HOME: h.home, CODEX_HOME: join(h.cwd, 'not-created') }, h.cwd, artifacts), /CONTROL_WORKSPACE_OVERLAP/);
  assert.throws(() => providerEnvironment('claude-code', { HOME: h.home, CLAUDE_CONFIG_DIR: join(artifacts, 'auth') }, h.cwd, artifacts), /CONTROL_WORKSPACE_OVERLAP/);
  const safe = providerEnvironment('codex', { HOME: h.home, CODEX_HOME: h.home }, h.cwd, artifacts, h.controls);
  assert.ok(safe.controls.includes(h.home));
});
