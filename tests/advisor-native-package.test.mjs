import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { packNative } from '../scripts/pack-advisor-native.mjs';
import { projectInstall } from '../scripts/advisor-runtime/install.mjs';

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'np-'))); const project = join(base, 'project with spaces'); mkdirSync(project, { mode: 0o700 });
  const descriptor = join(base, 'descriptor.json'); const token = 'a'.repeat(64); writeFileSync(descriptor, JSON.stringify({ v: 1, token, socketPath: join(base, 'runtime.sock') }), { mode: 0o600 });
  t.after(() => rmSync(base, { force: true, recursive: true })); return { base, project, descriptor, token };
}
for (const host of ['codex', 'claude-code']) test(`${host}: owned fragment install/uninstall/restore preserves unrelated settings and refuses tampering`, t => {
  const h = fixture(t); const path = join(h.project, host === 'codex' ? '.codex/config.toml' : '.mcp.json'); mkdirSync(dirname(path), { recursive: true });
  const unrelated = host === 'codex' ? '# user comment\nmodel = "unrelated"\n' : '{"custom":true,"mcpServers":{"foreign":{"command":"foreign"}}}\n'; writeFileSync(path, unrelated);
  assert.equal(projectInstall('install', host, h.project, h.descriptor).state, 'installed');
  assert.ok(!readFileSync(path, 'utf8').includes(h.token));
  const add = text => host === 'codex' ? text + '\n# concurrent unrelated change\n' : JSON.stringify({ ...JSON.parse(text), unrelatedAdded: 42 });
  writeFileSync(path, add(readFileSync(path, 'utf8')));
  assert.equal(projectInstall('uninstall', host, h.project).state, 'uninstalled');
  assert.match(readFileSync(path, 'utf8'), host === 'codex' ? /concurrent unrelated/ : /unrelatedAdded/);
  assert.equal(projectInstall('restore', host, h.project).state, 'installed');
  const installed = readFileSync(path, 'utf8'); writeFileSync(path, installed.replace('mcp-env', 'tampered'));
  assert.throws(() => projectInstall('uninstall', host, h.project), /OWNED_FRAGMENT_TAMPERED/);
  assert.equal(readFileSync(path, 'utf8'), installed.replace('mcp-env', 'tampered'));
  writeFileSync(path, installed); projectInstall('uninstall', host, h.project);
  const skill = join(h.project, host === 'codex' ? '.agents/skills/advisor-runtime/SKILL.md' : '.claude/skills/advisor-runtime/SKILL.md');
  symlinkSync('/nonexistent', skill); assert.throws(() => projectInstall('restore', host, h.project), /SYMLINK/);
});
test('reinstall requires uninstall before changing descriptor, then installs the new owned fragment', t => {
  const h = fixture(t); projectInstall('install', 'codex', h.project, h.descriptor);
  const alternate = join(h.base, 'alternate.json'); writeFileSync(alternate, readFileSync(h.descriptor), { mode: 0o600 });
  assert.throws(() => projectInstall('install', 'codex', h.project, alternate), /UNINSTALL_BEFORE_REINSTALL/);
  projectInstall('uninstall', 'codex', h.project); projectInstall('install', 'codex', h.project, alternate);
  assert.ok(readFileSync(join(h.project, '.codex/config.toml'), 'utf8').includes(alternate));
});
test('installer rejects unsafe descriptors, traversal-by-symlink, foreign fragments and state overlap', t => {
  const h = fixture(t); chmodSync(h.descriptor, 0o644); assert.throws(() => projectInstall('install', 'codex', h.project, h.descriptor), /UNSAFE_FILE/); chmodSync(h.descriptor, 0o600);
  mkdirSync(join(h.project, '.codex')); writeFileSync(join(h.project, '.codex/config.toml'), '[mcp_servers.advisor_runtime]\ncommand="foreign"');
  assert.throws(() => projectInstall('install', 'codex', h.project, h.descriptor), /FOREIGN_FRAGMENT/);
  const link = join(h.base, 'linked project'); symlinkSync(h.project, link); assert.throws(() => projectInstall('install', 'codex', link, h.descriptor), /EXPLICIT_REAL_PROJECT/);
  const inside = join(h.project, 'descriptor.json'); writeFileSync(inside, readFileSync(h.descriptor), { mode: 0o600 }); assert.throws(() => projectInstall('install', 'claude-code', h.project, inside), /DESCRIPTOR_OUTSIDE_PROJECT/);
});

test('actual tarball installed in isolated spaced HOME/prefix runs CLI/service/MCP/SQLite without repo or Pi/Herdr access', { timeout: 120000 }, async t => {
  const h = fixture(t); const home = join(h.base, 'fake home with spaces'); const prefix = join(h.base, 'prefix with spaces'); const work = join(h.base, 'work'); const state = join(h.base, 's');
  for (const path of [home, prefix, work]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(work, 'input.txt'), 'INSTALLED_TASK_READ');
  const env = { PATH: process.env.PATH, HOME: home, NPM_CONFIG_USERCONFIG: join(home, '.npmrc'), NPM_CONFIG_CACHE: join(home, 'cache'), NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false' };
  const packed = packNative(process.env.NATIVE_PACKAGE_ARTIFACT ?? join(h.base, 'tarball with spaces'));
  assert.ok(!packed.files.some(path => /extensions|bb-plugin|herdr|node_modules/.test(path)));
  const install = spawnSync('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--omit=optional', '--offline', '--no-audit', '--no-fund', packed.tarball], { env, cwd: home, encoding: 'utf8', timeout: 60000 });
  assert.equal(install.status, 0, install.stderr);
  const pkg = join(prefix, 'node_modules/@nourhelmi/advisor-native'); const cli = join(prefix, 'node_modules/.bin/advisor-runtime'); const native = join(prefix, 'node_modules/.bin/advisor-native');
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')); assert.equal(manifest.optionalDependencies['@anthropic-ai/claude-agent-sdk'], '0.3.263');
  for (const file of packed.files.filter(path => /\.(mjs|md|json)$/.test(path))) assert.ok(!readFileSync(join(pkg, file), 'utf8').includes('/Users/nour'), file);
  // Only node and basic OS bins. No Codex/Pi/Herdr/global node modules in this child environment.
  const bins = join(home, 'bin'); mkdirSync(bins); symlinkSync(process.execPath, join(bins, 'node')); const cleanEnv = { HOME: home, PATH: `${bins}:/usr/bin:/bin`, LANG: 'C' };
  assert.equal(process.platform, 'darwin', 'This isolation proof is macOS-only; do not claim an untested OS.');
  const repo = realpathSync(new URL('..', import.meta.url).pathname);
  const profile = `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(repo)}) (subpath ${JSON.stringify(join(process.env.HOME, '.pi'))}) (subpath ${JSON.stringify(join(process.env.HOME, '.agents'))}))`;
  const executable = '/usr/bin/sandbox-exec'; const flags = ['-p', profile, process.execPath];
  const run = (file, args, input) => spawnSync(executable, [...flags, file, ...args], { env: cleanEnv, cwd: home, encoding: 'utf8', input, timeout: 10000 });
  const deniedRead = run('-e', [`require('node:fs').readFileSync(${JSON.stringify(join(repo, 'package.json'))})`]); assert.notEqual(deniedRead.status, 0); assert.match(deniedRead.stderr, /EPERM|EACCES/);
  const doctor = run(native, ['doctor']); assert.equal(doctor.status, 0, doctor.stderr); const health = JSON.parse(doctor.stdout); assert.equal(health.codex, null); assert.equal(health.claude, null); assert.ok(health.issues.some(i => i.includes('0.3.263')));
  const init = run(native, ['init', state, work, 'codex']); assert.equal(init.status, 0, init.stderr);
  // The OS sandbox denies this source repository and user agent directories (OS/prefix/temp access remains).
  const service = spawn(executable, [...flags, cli, 'serve', join(state, 'bootstrap.json')], { env: cleanEnv, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; service.stderr.on('data', chunk => stderr += chunk); t.after(() => { if (service.exitCode === null) service.kill('SIGKILL'); });
  const ready = await Promise.race([once(service.stdout, 'data'), once(service, 'exit').then(() => { throw new Error(`service exited: ${stderr}`); })]); assert.equal(JSON.parse(String(ready[0])).ready, true);
  // Async clients let the real foreground service answer while this test runs.
  const call = async (args, input) => {
    const child = spawn(executable, [...flags, cli, ...args], { env: cleanEnv, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] }); let out = ''; let err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c); child.stdin.end(input); const [code] = await once(child, 'exit'); assert.equal(code, 0, err); return out;
  };
  const created = JSON.parse(await call(['call', join(state, 'operator.json')], readFileSync(join(state, 'create-run.json')))); assert.equal(created.ok, true);
  const envelope = { v: 1, op: 'progress', scope: { workstream: 'work', run: 'run', node: 'root', ownerEpoch: 1 }, payload: {} };
  const progress = JSON.parse(await call(['call', join(state, 'operator.json')], JSON.stringify(envelope))); assert.equal(progress.value.cwd, work); assert.equal(progress.value.export.pending, false, stderr);
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'installed-proof', version: '1' } } };
  const mcpOut = await call(['mcp', join(state, 'advisor.json')], [initialize, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'advisor_progress', arguments: { v: 1, scope: envelope.scope, payload: {} } } }].map(v => JSON.stringify(v)).join('\n') + '\n');
  const messages = mcpOut.trim().split('\n').map(line => JSON.parse(line));
  const tools = messages.find(message => message.id === 2).result.tools; assert.ok(tools.some(tool => tool.name === 'advisor_node_launch')); assert.ok(!tools.some(tool => tool.name === 'advisor_root_create'));
  assert.equal(JSON.parse(messages.find(message => message.id === 3).result.content[0].text).value.cwd, work);
  for (const host of ['codex', 'claude-code']) {
    const installed = run(native, ['install', host, h.project, join(state, 'advisor.json')]); assert.equal(installed.status, 0, installed.stderr);
    const planned = run(native, ['entry-plan', host, h.project, join(state, 'bootstrap.json')]); assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout); assert.ok(!plan.args.includes('--sandbox'));
    assert.ok(!planned.stdout.includes(JSON.parse(readFileSync(join(state, 'advisor.json'))).token));
    if (host === 'codex') assert.equal(plan.config.permissions['advisor-task-read-v1'].filesystem[work], 'read');
    else {
      const spec = JSON.parse(plan.args[plan.args.indexOf('--settings') + 1]).hooks.PreToolUse[0].hooks[0];
      const event = path => JSON.stringify({ hook_event_name: 'PreToolUse', cwd: h.project, session_id: 'dummy', tool_name: 'Read', tool_input: { file_path: path } });
      const allowed = run(spec.args[0], spec.args.slice(1), event(join(work, 'input.txt'))); assert.equal(allowed.status, 0); assert.deepEqual(JSON.parse(allowed.stdout), { continue: true });
      const denied = run(spec.args[0], spec.args.slice(1), event(join(state, 'bootstrap.json'))); assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
    }
    // Native binaries are absent here: the installed wrapper must stop before any model input.
    const missing = run(native, ['enter', host, h.project, join(state, 'bootstrap.json')]); assert.equal(missing.status, 1); assert.match(missing.stderr, /VERSION_UNSUPPORTED/);
    assert.equal(run(native, ['uninstall', host, h.project]).status, 0); assert.equal(run(native, ['restore', host, h.project]).status, 0);
  }
  assert.ok(existsSync(join(state, 'runtime.sqlite'))); assert.match(readFileSync(join(state, 'traces/run.jsonl'), 'utf8'), /run.created/);
  assert.ok(!mcpOut.includes(JSON.parse(readFileSync(join(state, 'advisor.json'))).token));
  const denied = run(native, ['init', join(work, 'unsafe-state'), work, 'codex']); assert.notEqual(denied.status, 0); assert.match(denied.stderr, /STATE_WORKSPACE_OVERLAP/);
  const credentialBytes = readFileSync(join(state, 'operator.json'));
  service.kill('SIGINT'); assert.equal((await once(service, 'exit'))[0], 0, stderr);
  // Actual installed process restart: same bootstrap, no credential replacement, exact replay.
  const restarted = spawn(executable, [...flags, cli, 'serve', join(state, 'bootstrap.json')], { env: cleanEnv, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  let restartError = ''; restarted.stderr.on('data', chunk => restartError += chunk);
  t.after(() => { if (restarted.exitCode === null) restarted.kill('SIGKILL'); });
  const restartReady = await Promise.race([once(restarted.stdout, 'data'), once(restarted, 'exit').then(() => { throw new Error(`restart exited: ${restartError}`); })]);
  assert.equal(JSON.parse(String(restartReady[0])).ready, true);
  assert.deepEqual(readFileSync(join(state, 'operator.json')), credentialBytes);
  const replay = JSON.parse(await call(['call', join(state, 'operator.json')], readFileSync(join(state, 'create-run.json')))); assert.equal(replay.replayed, true);
  restarted.kill('SIGINT'); assert.equal((await once(restarted, 'exit'))[0], 0, restartError);
  const bootstrapPath = join(state, 'bootstrap.json'); const originalBootstrap = readFileSync(bootstrapPath);
  const changedBootstrap = JSON.parse(originalBootstrap); changedBootstrap.principals[0].principal.operations = ['progress']; writeFileSync(bootstrapPath, JSON.stringify(changedBootstrap));
  const changed = run(cli, ['serve', bootstrapPath]); assert.equal(changed.status, 1); assert.match(changed.stderr, /BOOTSTRAP_MISMATCH/); writeFileSync(bootstrapPath, originalBootstrap);
  const revoke = run('-e', [`const {AdvisorRuntime}=require(${JSON.stringify(join(pkg, 'scripts/advisor-runtime/runtime.mjs'))});const r=new AdvisorRuntime({stateRoot:${JSON.stringify(state)},allowedRoots:[${JSON.stringify(work)}]});r.revokePrincipal('operator');r.close();`]); assert.equal(revoke.status, 0, revoke.stderr);
  const revoked = run(cli, ['serve', bootstrapPath]); assert.equal(revoked.status, 1); assert.match(revoked.stderr, /BOOTSTRAP_PRINCIPAL_REVOKED/);
  assert.deepEqual(readFileSync(join(state, 'operator.json')), credentialBytes);
  assert.ok(!readdirSync(prefix).includes('.pi')); assert.ok(!existsSync(join(home, '.pi')));
});
