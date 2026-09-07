import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { bootstrap, main } from '../scripts/advisor-runtime/native-cli.mjs';
import { entryPlan, verifyCodexConfiguration, verifyClaudeEntryVersion } from '../scripts/advisor-runtime/native-entry.mjs';
import { projectInstall } from '../scripts/advisor-runtime/install.mjs';
import { host } from '../scripts/advisor-runtime/cli.mjs';
import { AdvisorRuntime } from '../scripts/advisor-runtime/runtime.mjs';
import { READ_PROFILE, WRITE_PROFILE, assertPermissionConfig } from '../scripts/advisor-runtime/native-boundary.mjs';

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ne-')));
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
const hook = new URL('../scripts/advisor-runtime/native-hook.mjs', import.meta.url).pathname;
const hookEvent = (cwd, name, input) => ({ hook_event_name: 'PreToolUse', cwd, session_id: 'dummy', tool_name: name, tool_input: input });

test('N1/N4 installed entry reads explicit task roots without widening controls, and actual MCP config is attested', { timeout: 30000 }, async t => {
  const h = await installed(t); const plan = entryPlan('codex', h.cwd, h.bootstrapPath);
  assert.equal(plan.config.permissions[READ_PROFILE].filesystem[h.work], 'read');
  assert.equal(plan.config.permissions[WRITE_PROFILE].filesystem[h.work], 'read');
  assert.equal(plan.config.permissions[READ_PROFILE].filesystem[h.state], 'deny');
  assert.ok(!plan.args.includes('--sandbox')); assert.equal(plan.args[plan.args.indexOf('--ask-for-approval') + 1], 'never');
  assert.ok(!JSON.stringify(plan).includes(JSON.parse(readFileSync(join(h.state, 'advisor.json'))).token));
  const actual = await verifyCodexConfiguration(plan.config, plan); assert.equal(actual.checked, true);
  const evidence = [];
  for (const [path, allowed] of [[join(h.work, 'input.txt'), true], [join(h.state, 'bootstrap.json'), false]]) {
    const args = ['sandbox', ...plan.args.slice(0, plan.args.indexOf('-P')), '-P', READ_PROFILE, '-C', h.cwd, '--', '/bin/cat', path];
    const result = spawnSync('codex', args, { cwd: h.cwd, env: plan.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status === 0, allowed, result.stderr); if (allowed) assert.equal(result.stdout, 'AUTHORIZED_TASK_READ');
    evidence.push({ args, status: result.status, stdout: allowed ? result.stdout : '', stderr: result.stderr });
  }
  if (process.env.NATIVE_BOUNDARY_EVIDENCE_DIR) writeFileSync(join(process.env.NATIVE_BOUNDARY_EVIDENCE_DIR, 'entry-config-proof.json'), JSON.stringify({ actual, config: plan.config, evidence, modelCalls: 0 }, null, 2));
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
