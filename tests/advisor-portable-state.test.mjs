import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync, linkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { advisorStateRoot, advisorIdentity, nativeAdvisorIdentity, claimAdvisorCheckpoint, readAdvisorCheckpoint, updateAdvisorCheckpoint } from '../scripts/advisor-core/advisor-state.mjs';
import { installNativeSkills } from '../scripts/install-native-skills.mjs';

const cli = resolve('scripts/advisor-core/advisor-state-cli.mjs');
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'portable-advisor-')));
  const root = join(directory, 'state'); const cwd = join(directory, 'repo'); mkdirSync(cwd);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ADVISOR_|PI_|CODEX_|CLAUDE_|HERDR_)/.test(key)));
  Object.assign(env, { HOME: directory, ADVISOR_STATE_DIR: root, CODEX_THREAD_ID: 'native-a' });
  const call = (args, extra = {}, script = cli, input) => spawnSync(process.execPath, [script, ...args, '--cwd', cwd], { env: { ...env, ...extra }, input, encoding: 'utf8' });
  return { directory, root, cwd, env, call, request: { root, workstream: 'outcome', identity: advisorIdentity('pi', 'pi-a') } };
}
const json = result => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
function processCall(file, args, env, input = '') {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(input);
    let stdout = '', stderr = ''; child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
    child.on('error', reject); child.on('close', status => resolveResult({ status, stdout, stderr }));
  });
}

test('canonical Git-common-dir identity agrees for checkout, worktree, cwd aliases and native process', async t => {
  const f = fixture(t); const old = process.env.ADVISOR_STATE_DIR; delete process.env.ADVISOR_STATE_DIR;
  t.after(() => { if (old === undefined) delete process.env.ADVISOR_STATE_DIR; else process.env.ADVISOR_STATE_DIR = old; });
  for (const args of [['init', '-q'], ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '--allow-empty', '-qm', 'fixture'], ['worktree', 'add', '--detach', join(f.directory, 'linked')]]) {
    const r = spawnSync('git', ['-C', f.cwd, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  }
  symlinkSync(f.cwd, join(f.directory, 'alias'));
  assert.equal(await advisorStateRoot(f.cwd), await advisorStateRoot(join(f.directory, 'linked')));
  assert.equal(await advisorStateRoot(f.cwd), await advisorStateRoot(join(f.directory, 'alias')));
  const env = { ...f.env }; delete env.ADVISOR_STATE_DIR;
  const get = cwd => spawnSync(process.execPath, ['--input-type=module', '-e', `import {advisorStateRoot} from ${JSON.stringify(new URL('../scripts/advisor-core/advisor-state.mjs', import.meta.url).href)}; console.log(await advisorStateRoot(process.argv[1]));`, cwd], { env, encoding: 'utf8' });
  const rootA = get(f.cwd), rootB = get(join(f.directory, 'linked'));
  assert.equal(rootA.status, 0, rootA.stderr); assert.equal(rootA.stdout, rootB.stdout);
  assert.match(rootA.stdout, new RegExp(`${f.directory}/.advisor/repo-[a-f0-9]{8}`));
});

test('Pi and installed native helper claim the same canonical namespace without Pi/Herdr or a managed lane', t => {
  const f = fixture(t); const installed = installNativeSkills(f.directory);
  const script = join(installed.bundle, 'advisor/scripts/advisor-state-cli.mjs');
  const pi = claimAdvisorCheckpoint(f.request);
  const foreign = f.call(['init', '--workstream', 'outcome'], {}, script);
  assert.equal(foreign.status, 1); assert.match(foreign.stderr, /owned by pi session pi-a/);
  const native = json(f.call(['init', '--workstream', 'native-work', '--mode', 'cos'], { PATH: '/usr/bin:/bin' }, script));
  assert.equal(native.paths.root, f.root); assert.equal(native.executionRuntimeStarted, false); assert.equal(native.lane, 'unchanged');
  assert.equal(native.mode, 'cos'); assert.equal(json(f.call(['init'], {}, script)).mode, 'cos');
  assert.equal(readAdvisorCheckpoint(f.request).content, pi.content);
  assert.ok(!readdirSync(f.root).includes('runtime.sqlite'));
  assert.equal(f.call(['init', '--workstream', 'different'], {}, script).status, 1);
  const claude = json(f.call(['init', '--workstream', 'claude-work'], { CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: 'claude-a' }, script));
  assert.equal(claude.identity.host, 'claude-code'); assert.equal(claude.paths.root, native.paths.root);
  assert.equal(f.call(['read', '--workstream', 'native-work'], { CODEX_THREAD_ID: '', CLAUDE_SESSION_ID: 'native-a' }, script).status, 1);
});

test('display/owner arguments and absent host context do not claim ownership; helpers cannot create competing checkpoints', t => {
  const f = fixture(t);
  assert.equal(f.call(['init', '--workstream', 'outcome', '--owner', 'pi-a']).status, 1);
  assert.equal(f.call(['init', '--workstream', 'outcome'], { CODEX_THREAD_ID: '', PI_SESSION_NAME: 'native-a' }).status, 1);
  assert.equal(f.call(['init', '--workstream', 'outcome'], { ADVISOR_RUNTIME_CANONICAL_OWNER: '1' }).status, 1);
  assert.throws(() => nativeAdvisorIdentity({ CLAUDE_SESSION_ID: '${CLAUDE_SESSION_ID}' }), /identity unavailable/);
  assert.throws(() => claimAdvisorCheckpoint({ ...f.request, workstream: '../outside' }), /slug/);
  assert.throws(() => claimAdvisorCheckpoint({ ...f.request, identity: { host: 'pi', sessionId: '../outside' } }), /identity/);
  const piContext = join(f.directory, 'pi-session.jsonl'); writeFileSync(piContext, '{"type":"session","id":"pi-a"}\n');
  assert.deepEqual(nativeAdvisorIdentity({ PI_SESSION_ID: 'pi-a', PI_SESSION_FILE: piContext }), f.request.identity);
  assert.throws(() => nativeAdvisorIdentity({ PI_SESSION_ID: 'foreign', PI_SESSION_FILE: piContext }), /mismatch/);
});

test('safe writes preserve owner/mode, require current digest and preserve attributed helper evidence locators', t => {
  const f = fixture(t); const original = claimAdvisorCheckpoint({ ...f.request, mode: 'cos' });
  const content = original.content + '\n## Evidence\n\nHelper child-session/run-1: /assigned/result.md — native returned evidence, not host attestation.\n';
  const updated = updateAdvisorCheckpoint({ ...f.request, content, expectedDigest: original.digest });
  assert.notEqual(updated.digest, original.digest); assert.match(updated.content, /child-session\/run-1/);
  assert.throws(() => updateAdvisorCheckpoint({ ...f.request, content, expectedDigest: original.digest }), /Stale/);
  assert.throws(() => updateAdvisorCheckpoint({ ...f.request, content: content.replace('`pi-a`', '`foreign`'), expectedDigest: updated.digest }), /owner\/mode/);
  assert.throws(() => updateAdvisorCheckpoint({ ...f.request, content: content.replace('`cos`', '`advisor`'), expectedDigest: updated.digest }), /owner\/mode/);
  assert.throws(() => claimAdvisorCheckpoint({ ...f.request, workstream: 'renamed' }), /different advisor workstream/);
  assert.equal(readAdvisorCheckpoint(f.request).digest, updated.digest);
  const nextIdentity = advisorIdentity('codex', 'new-root');
  const transferred = claimAdvisorCheckpoint({ ...f.request, identity: nextIdentity, transferFrom: f.request.identity });
  assert.equal(transferred.mode, 'cos'); assert.equal(readdirSync(join(f.root, 'events')).length, 1);
  assert.throws(() => readAdvisorCheckpoint(f.request), /foreign-owner/);
});

test('symlink, hardlink, redirected directory and missing checkpoint reject without clobber or adoption', t => {
  const f = fixture(t); const original = claimAdvisorCheckpoint(f.request);
  const victim = join(f.directory, 'victim'); writeFileSync(victim, 'sentinel');
  unlinkSync(original.paths.workstream); symlinkSync(victim, original.paths.workstream);
  assert.throws(() => claimAdvisorCheckpoint(f.request), /symlink/);
  assert.throws(() => updateAdvisorCheckpoint({ ...f.request, content: original.content, expectedDigest: original.digest }), /symlink/);
  assert.equal(readFileSync(victim, 'utf8'), 'sentinel');
  unlinkSync(original.paths.workstream); linkSync(victim, original.paths.workstream);
  assert.throws(() => readAdvisorCheckpoint(f.request), /special file/);
  unlinkSync(original.paths.workstream);
  assert.throws(() => claimAdvisorCheckpoint(f.request), /missing/);
  rmSync(join(f.root, 'sessions'), { recursive: true }); symlinkSync(f.directory, join(f.root, 'sessions'));
  assert.throws(() => claimAdvisorCheckpoint(f.request), /symlink/);
  const alias = join(f.directory, 'alias-state'); symlinkSync(f.root, alias);
  assert.throws(() => claimAdvisorCheckpoint({ ...f.request, root: alias }), /symlink/);
});

test('separate native processes cannot overwrite a collision winner or reset a session lifetime', async t => {
  const f = fixture(t);
  const attempts = await Promise.all(Array.from({ length: 6 }, (_, i) => processCall(cli, ['init', '--workstream', 'collision', '--cwd', f.cwd], { ...f.env, CODEX_THREAD_ID: `contender-${i}` })));
  const winners = attempts.filter(value => value.status === 0); assert.equal(winners.length, 1);
  const winner = JSON.parse(winners[0].stdout);
  for (const failure of attempts.filter(value => value.status !== 0)) assert.match(failure.stderr, /busy|owned by/);
  assert.equal(readFileSync(winner.paths.workstream, 'utf8'), winner.content);
  const rejected = f.call(['init', '--workstream', 'foreign-work'], { CODEX_THREAD_ID: winner.identity.sessionId });
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /different advisor workstream/);
});

test('malformed metadata never falls back and competing same-owner CAS processes preserve the winner', async t => {
  const f = fixture(t); const original = json(f.call(['init', '--workstream', 'outcome', '--mode', 'cos']));
  const request = { ...f.request, identity: original.identity };
  for (const content of [original.content + '\n- Owner session: `foreign`\n', original.content.replace('`cos`', '`invalid`'), original.content.replace('`codex`', 'codex')]) {
    assert.throws(() => updateAdvisorCheckpoint({ ...request, expectedDigest: original.digest, content }), /Duplicate|Invalid|Malformed/);
    assert.equal(readAdvisorCheckpoint(request).digest, original.digest);
  }
  const writes = await Promise.all(['one', 'two'].map(name => processCall(cli, ['write', '--cwd', f.cwd, '--expected-digest', original.digest], f.env, original.content + `\n## Evidence\n\n${name}: /assigned/${name}/result.md\n`)));
  assert.equal(writes.filter(value => value.status === 0).length, 1);
  const winner = JSON.parse(writes.find(value => value.status === 0).stdout);
  for (const failed of writes.filter(value => value.status !== 0)) assert.match(failed.stderr, /busy|Stale/);
  assert.equal(readAdvisorCheckpoint(request).content, winner.content);
  assert.equal(readAdvisorCheckpoint(request).mode, 'cos');
});
