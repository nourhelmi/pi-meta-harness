import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { CodexWire } from '../scripts/advisor-runtime/adapters/codex.mjs';
import { NATIVE_LIMITS } from '../scripts/advisor-runtime/adapters/common.mjs';
import { bootstrap, main } from '../scripts/advisor-runtime/native-cli.mjs';
import { entryPlan, verifyCodexConfiguration, verifyClaudeEntryVersion } from '../scripts/advisor-runtime/native-entry.mjs';
import { projectInstall } from '../scripts/advisor-runtime/install.mjs';
import { host } from '../scripts/advisor-runtime/cli.mjs';
import { AdvisorRuntime } from '../scripts/advisor-runtime/runtime.mjs';
import { READ_PROFILE, WRITE_PROFILE, assertPermissionConfig, configArgs } from '../scripts/advisor-runtime/native-boundary.mjs';

function fixture(t) {
  // Darwin's ambient temporary-directory writes would invalidate a read-only write-denial probe.
  const parent = process.platform === 'darwin' ? '/Users/Shared' : tmpdir();
  const base = realpathSync(mkdtempSync(join(parent, 'ne-')));
  const cwd = join(base, 'entry with spaces'); const work = join(base, 'work'); const state = join(base, 's');
  for (const path of [cwd, work]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(work, 'input.txt'), 'AUTHORIZED_TASK_READ');
  bootstrap(state, work, 'codex'); const bootstrapPath = join(state, 'bootstrap.json');
  const config = JSON.parse(readFileSync(bootstrapPath));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, cwd, work, state, bootstrapPath, config };
}
async function installed(t) {
  const h = fixture(t); const service = await host(h.config, {}, { bootstrapPath: h.bootstrapPath }); await service.service.close();
  for (const provider of ['codex', 'claude-code']) projectInstall('install', provider, h.cwd, join(h.state, 'advisor.json'));
  return h;
}
// Resolve the implicit default through the actual producer without a turn or model prompt.
async function selectedDefaultProfile(plan, h) {
  const running = await host(h.config, {}, { bootstrapPath: h.bootstrapPath });
  const child = spawn(plan.command, ['app-server', '--stdio', '--strict-config', ...configArgs(plan.config)], { cwd: h.cwd, env: plan.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let bytes = 0; const failures = []; const methods = []; const rpcErrors = [];
  let diagnosticBuffer = '';
  child.stdout.on('data', chunk => {
    diagnosticBuffer += chunk.toString();
    if (diagnosticBuffer.length > NATIVE_LIMITS.bytes) { child.kill('SIGTERM'); return; }
    let newline;
    while ((newline = diagnosticBuffer.indexOf('\n')) !== -1) {
      const line = diagnosticBuffer.slice(0, newline); diagnosticBuffer = diagnosticBuffer.slice(newline + 1);
      try { const message = JSON.parse(line); if (message.error) rpcErrors.push(message.error.message); } catch { /* CodexWire owns malformed-message failure. */ }
    }
  });
  const session = {
    limits: NATIVE_LIMITS, failed: false,
    count(value) { bytes += Buffer.byteLength(value); assert.ok(bytes <= NATIVE_LIMITS.bytes); },
    fail(reason) { failures.push(String(reason)); this.failed = true; child.kill('SIGTERM'); },
    guarded(fn) { try { return fn(); } catch (error) { this.fail(error); } },
    exited() {},
  };
  const wire = new CodexWire(child, session);
  wire.onMessage = message => { assert.equal(message.id, undefined, 'unexpected server request'); };
  const request = (method, params) => { methods.push(method); return wire.request(method, params); };
  try {
    const init = await request('initialize', { clientInfo: { name: 'advisor-default-profile-test', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    assert.match(init.userAgent, /0\.153\.4/); wire.send({ method: 'initialized' });
    const thread = await request('thread/start', { cwd: h.cwd, ephemeral: true, approvalPolicy: 'never' });
    assert.deepEqual(failures, []); assert.deepEqual(methods, ['initialize', 'thread/start']);
    assert.equal(thread.activePermissionProfile?.id, plan.config.default_permissions);
    return { profile: thread.activePermissionProfile.id, methods, modelCalls: 0 };
  } catch (error) {
    throw new Error(`${error.message}; dummy-home producer errors: ${rpcErrors.join('; ')}`, { cause: error });
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.kill('SIGTERM'); try { await exited; } finally { clearTimeout(timer); }
    }
    await running.service.close();
  }
}
const hook = fileURLToPath(new URL('../scripts/advisor-runtime/native-hook.mjs', import.meta.url));
const hookEvent = (cwd, name, input) => ({ hook_event_name: 'PreToolUse', cwd, session_id: 'dummy', tool_name: name, tool_input: input });

test('interactive root argv passes the actual Codex parser without sandbox-only permission flags', async t => {
  const h = await installed(t); const plan = entryPlan('codex', h.cwd, h.bootstrapPath);
  const parse = args => spawnSync(plan.command, [...args, '--help'], { cwd: h.cwd, env: plan.env, encoding: 'utf8', timeout: 10000 });
  const accepted = parse(plan.args);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Codex CLI/);
  assert.equal(plan.config.default_permissions, READ_PROFILE);
  assert.ok(plan.args.includes(`default_permissions=${JSON.stringify(READ_PROFILE)}`));
  for (const flag of ['-P', '--permission-profile', '-p', '--profile', '-s', '--sandbox', '--dangerously-bypass-approvals-and-sandbox']) {
    assert.ok(!plan.args.includes(flag), `unexpected root permission override: ${flag}`);
  }
  const rejected = parse(['-P', READ_PROFILE, ...plan.args]);
  assert.equal(rejected.status, 2, rejected.stderr);
  assert.match(rejected.stderr, /unexpected argument '-P'/);
});

test('N1/N4 installed entry reads explicit task roots without widening controls, and actual MCP config is attested', { timeout: 30000 }, async t => {
  const h = await installed(t); const plan = entryPlan('codex', h.cwd, h.bootstrapPath);
  assert.equal(plan.config.permissions[READ_PROFILE].filesystem[h.work], 'read');
  assert.equal(plan.config.permissions[WRITE_PROFILE].filesystem[h.work], 'read');
  assert.equal(plan.config.permissions[READ_PROFILE].filesystem[h.state], 'deny');
  assert.ok(!plan.args.includes('--sandbox')); assert.equal(plan.args[plan.args.indexOf('--ask-for-approval') + 1], 'never');
  assert.ok(!JSON.stringify(plan).includes(JSON.parse(readFileSync(join(h.state, 'advisor.json'))).token));
  const actual = await verifyCodexConfiguration(plan.config, plan); assert.equal(actual.checked, true);
  const selected = await selectedDefaultProfile(plan, h); assert.equal(selected.profile, READ_PROFILE);
  const evidence = [];
  for (const [path, allowed] of [[join(h.work, 'input.txt'), true], [join(h.state, 'bootstrap.json'), false]]) {
    const args = ['sandbox', ...configArgs(plan.config), '-P', selected.profile, '-C', h.cwd, '--', '/bin/cat', path];
    const result = spawnSync('codex', args, { cwd: h.cwd, env: plan.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status === 0, allowed, result.stderr); if (allowed) assert.equal(result.stdout, 'AUTHORIZED_TASK_READ');
    else assert.match(result.stderr, /Operation not permitted|Permission denied/);
    evidence.push({ args, status: result.status, stdout: allowed ? result.stdout : '', stderr: result.stderr });
  }
  const deniedWrite = join(h.work, 'read-only-write-must-not-exist');
  const writeArgs = ['sandbox', ...configArgs(plan.config), '-P', selected.profile, '-C', h.cwd, '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(deniedWrite)}, 'denied')`];
  const writeResult = spawnSync('codex', writeArgs, { cwd: h.cwd, env: plan.env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(writeResult.status, 0, 'the default root profile must not permit task writes');
  assert.match(writeResult.stderr, /EPERM|EACCES/);
  assert.equal(existsSync(deniedWrite), false);
  evidence.push({ args: writeArgs, status: writeResult.status, stdout: writeResult.stdout, stderr: writeResult.stderr });
  if (process.env.NATIVE_BOUNDARY_EVIDENCE_DIR) writeFileSync(join(process.env.NATIVE_BOUNDARY_EVIDENCE_DIR, 'entry-config-proof.json'), JSON.stringify({ actual, selected, config: plan.config, evidence, modelCalls: 0 }, null, 2));
  const configFile = join(h.cwd, '.codex/config.toml'); const original = readFileSync(configFile, 'utf8');
  // Owned-fragment lifecycle permits unrelated settings; entry attestation does not permit permission overrides.
  writeFileSync(configFile, 'sandbox_mode = "read-only"\n' + original);
  const overridden = entryPlan('codex', h.cwd, h.bootstrapPath);
  await assert.rejects(verifyCodexConfiguration(overridden.config, overridden), /CODEX_LEGACY_PERMISSION_OVERRIDE|CODEX_CONFIG_DRIFT/);
  writeFileSync(configFile, original);
  for (const key of ['features', 'permissions', 'mcp_servers']) {
    const drift = structuredClone(plan.config); drift[key].foreign = true;
    assert.throws(() => assertPermissionConfig(drift, plan.config), /CODEX_CONFIG_DRIFT/);
  }
  await assert.rejects(main(['entry-plan', 'codex', h.cwd, h.bootstrapPath, '--sandbox']), /ENTRY_HOST_PROJECT_BOOTSTRAP/);
});

test('N2/N4 owned exec-form CLI hook allows task reads, denies scans/aliases/unknown/oversized input, and refuses old CLI', async t => {
  const h = await installed(t); const plan = entryPlan('claude-code', h.cwd, h.bootstrapPath);
  const settings = JSON.parse(plan.args[plan.args.indexOf('--settings') + 1]); const installedHook = settings.hooks.PreToolUse[0];
  assert.equal(installedHook.matcher, '.*'); const spec = installedHook.hooks[0]; assert.equal(spec.type, 'command'); assert.equal(spec.command, process.execPath);
  const run = input => spawnSync(spec.command, spec.args, { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: plan.env, cwd: h.cwd, timeout: 10000 });
  const allowed = run(hookEvent(h.cwd, 'Read', { file_path: join(h.work, 'input.txt') })); assert.equal(allowed.status, 0); assert.deepEqual(JSON.parse(allowed.stdout), { continue: true });
  for (const event of [hookEvent(h.cwd, 'Read', { file_path: join(h.state, 'bootstrap.json') }), hookEvent(h.cwd, 'Write', { file_path: join(h.work, 'new.txt'), content: 'no' }), hookEvent(h.cwd, 'Bash', { command: 'anything' }), 'x'.repeat(32769), '{invalid']) {
    const result = run(event); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
  mkdirSync(join(h.work, '.codex')); writeFileSync(join(h.work, '.codex/config.toml'), 'DUMMY');
  for (const name of ['Glob', 'Grep']) {
    const result = run(hookEvent(h.cwd, name, { path: h.work, pattern: name === 'Glob' ? '**/*' : 'DUMMY' })); assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
  mkdirSync(join(h.work, 'safe')); writeFileSync(join(h.work, 'safe/file'), 'TASK');
  assert.deepEqual(JSON.parse(run(hookEvent(h.cwd, 'Grep', { path: join(h.work, 'safe'), pattern: 'TASK' })).stdout), { continue: true });
  symlinkSync(h.state, join(h.work, 'safe/alias'));
  assert.equal(JSON.parse(run(hookEvent(h.cwd, 'Glob', { path: join(h.work, 'safe'), pattern: '*' })).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.throws(() => verifyClaudeEntryVersion(plan, () => ({ status: 0, stdout: '2.1.261 (Claude Code)' })), /CLAUDE_CLI_ENTRY_VERSION_UNSUPPORTED/);
  assert.equal(verifyClaudeEntryVersion(plan, () => ({ status: 0, stdout: '2.1.263 (Claude Code)' })), '2.1.263');
  assert.equal(hook, spec.args[0]);
});

test('N3 provider inventory rejects prewrite workspace/artifact aliases, restart widening and changed homes', async t => {
  const h = fixture(t);
  for (const path of [join(h.work, 'not-created'), join(h.state, 'runs/provider')]) {
    const config = structuredClone(h.config); config.providerHomes.codex = path;
    await assert.rejects(host(config, {}), /CONTROL_WORKSPACE_OVERLAP/); assert.ok(!existsSync(path)); assert.ok(!existsSync(join(h.state, 'runtime.sqlite')));
  }
  symlinkSync(h.work, join(h.base, 'alias')); const aliasConfig = structuredClone(h.config); aliasConfig.providerHomes.codex = join(h.base, 'alias/missing');
  await assert.rejects(host(aliasConfig, {}), /SYMLINK_PATH/); assert.ok(!existsSync(join(h.work, 'missing')));
  const running = await host(h.config, {}, { bootstrapPath: h.bootstrapPath }); await running.service.close();
  const database = readFileSync(join(h.state, 'runtime.sqlite'));
  const changed = structuredClone(h.config); changed.providerHomes.codex = join(h.base, 'new-home');
  await assert.rejects(host(changed, {}, { bootstrapPath: h.bootstrapPath }), /CONTROL_INVENTORY_MISMATCH/);
  assert.ok(!existsSync(changed.providerHomes.codex)); assert.deepEqual(readFileSync(join(h.state, 'runtime.sqlite')), database);
  assert.throws(() => new AdvisorRuntime({ stateRoot: h.state, allowedRoots: [h.work, h.config.providerHomes.codex] }), /CONTROL_WORKSPACE_OVERLAP/);
  assert.deepEqual(readFileSync(join(h.state, 'runtime.sqlite')), database);
  const swapped = structuredClone(h.config); [swapped.providerHomes.codex, swapped.providerHomes['claude-code']] = [swapped.providerHomes['claude-code'], swapped.providerHomes.codex];
  await assert.rejects(host(swapped, {}, { bootstrapPath: h.bootstrapPath }), /BOOTSTRAP_MISMATCH/);
  const restart = await host(h.config, {}, { bootstrapPath: h.bootstrapPath }); await restart.service.close();
});

test('N1 preflight escalates shutdown of an uncooperative dummy child, without thread or turn', { timeout: 15000 }, async t => {
  const h = await installed(t); const plan = entryPlan('codex', h.cwd, h.bootstrapPath); let child;
  const fixturePath = join(h.base, 'dummy-preflight.mjs');
  writeFileSync(fixturePath, `import{createInterface}from'node:readline';process.on('SIGTERM',()=>{});setInterval(()=>{},1000);const config=JSON.parse(process.env.DUMMY_CONFIG);createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialized')return;if(!['initialize','config/read'].includes(r.method))process.exit(4);console.log(JSON.stringify({id:r.id,result:r.method==='initialize'?{userAgent:'codex-cli/0.153.4'}:{config}}));});`);
  assert.equal((await verifyCodexConfiguration(plan.config, { ...plan, spawnProcess: (_cmd, _args, options) => child = spawn(process.execPath, [fixturePath], { ...options, env: { ...options.env, DUMMY_CONFIG: JSON.stringify(plan.config) } }) })).checked, true);
  assert.equal(child.signalCode, 'SIGKILL');
});
