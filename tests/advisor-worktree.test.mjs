import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addWorktree, copyEnvFiles, envFiles } from '../scripts/advisor-core/worktree.mjs';

const HELPER = new URL('../scripts/advisor-core/worktree.mjs', import.meta.url).pathname;

function repository(t) {
  const base = realpathSync(mkdtempSync('/tmp/worktree-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'main'); mkdirSync(join(cwd, 'apps', 'web'), { recursive: true });
  const git = (...args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(cwd, 'README.md'), 'tracked\n');
  writeFileSync(join(cwd, '.env.example'), 'EXAMPLE=1\n');
  writeFileSync(join(cwd, '.gitignore'), '.env*\n!.env.example\nnode_modules\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  writeFileSync(join(cwd, '.env'), 'SECRET=root\n');
  writeFileSync(join(cwd, 'apps', 'web', '.env.local'), 'VITE_X=1\n');
  mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(join(cwd, 'node_modules', 'pkg', '.env'), 'IGNORED_DIR=1\n');
  mkdirSync(join(cwd, 'scratch')); writeFileSync(join(cwd, 'scratch', '.env.test'), 'UNTRACKED=1\n');
  return { base, cwd, git };
}

test('env discovery lists untracked and ignored env files but never collapsed ignored directories', t => {
  const { cwd } = repository(t);
  assert.deepEqual(envFiles(cwd), ['.env', 'apps/web/.env.local', 'scratch/.env.test']);
});

test('adding a worktree registers it with Git and carries the env files to the same relative paths', t => {
  const { base, cwd, git } = repository(t);
  const result = addWorktree(join(cwd, 'apps', 'web'), ['../../../feature', '-b', 'feature']);
  const target = join(base, 'feature');
  assert.equal(result.target, target);
  assert.deepEqual(result.copied, ['.env', 'apps/web/.env.local', 'scratch/.env.test']);
  assert.match(git('worktree', 'list', '--porcelain'), new RegExp(`worktree ${target}\\n`));
  assert.equal(git('-C', target, 'branch', '--show-current').trim(), 'feature');
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), 'tracked\n');
  assert.equal(readFileSync(join(target, '.env'), 'utf8'), 'SECRET=root\n');
  assert.equal(readFileSync(join(target, 'apps', 'web', '.env.local'), 'utf8'), 'VITE_X=1\n');
  assert.equal(readFileSync(join(target, '.env.example'), 'utf8'), 'EXAMPLE=1\n');
  assert.equal(existsSync(join(target, 'node_modules')), false);
  assert.equal(spawnSync('git', ['-C', target, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '', 'copied env files stay ignored in the new worktree');
  const again = copyEnvFiles(cwd, target);
  assert.deepEqual(again, { copied: [], skipped: ['.env', 'apps/web/.env.local', 'scratch/.env.test'] });
});

test('the CLI reports what it copied and --no-env skips the carry-over', t => {
  const { base, cwd } = repository(t);
  const run = (...args) => spawnSync(process.execPath, [HELPER, ...args], { cwd, encoding: 'utf8' });
  const withEnv = run('add', join(base, 'with-env'), '--detach');
  assert.equal(withEnv.status, 0, withEnv.stderr);
  assert.match(withEnv.stdout, /Copied env files: \.env, apps\/web\/\.env\.local, scratch\/\.env\.test/);
  const without = run('add', join(base, 'without-env'), '--detach', '--no-env');
  assert.equal(without.status, 0, without.stderr);
  assert.match(without.stdout, /Copied env files: none/);
  assert.equal(existsSync(join(base, 'without-env', '.env')), false);
  assert.equal(existsSync(join(base, 'without-env', 'README.md')), true);
  const bad = run('remove', 'x');
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Usage/);
  const duplicate = run('add', join(base, 'with-env'), '--detach');
  assert.equal(duplicate.status, 1); assert.match(duplicate.stderr, /already exists|already checked out|is a missing but/);
});
