import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceRoots } from '../scripts/advisor-runtime/pi-detach-bootstrap.mjs';

test('workspace discovery skips missing secondary worktrees, not permissions or an invalid cwd', t => {
  const base = realpathSync(mkdtempSync('/tmp/roots-')); const cwd = join(base, 'main'); mkdirSync(cwd);
  const privateParent = join(base, 'private'); mkdirSync(privateParent);
  t.after(() => { chmodSync(privateParent, 0o700); rmSync(base, { recursive: true, force: true }); });
  const git = (...args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  git('init', '-q'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
  const live = join(base, 'live'), missing = join(base, 'missing'), inaccessible = join(privateParent, 'linked');
  for (const path of [live, missing, inaccessible]) git('worktree', 'add', '--detach', path);
  rmSync(missing, { recursive: true });
  const metadata = git('worktree', 'list', '--porcelain'); assert.match(metadata, /prunable/);
  assert.deepEqual(workspaceRoots(cwd), [cwd, live, inaccessible].sort());
  assert.equal(git('worktree', 'list', '--porcelain'), metadata, 'discovery never prunes Git registrations');
  assert.throws(() => workspaceRoots(missing), { code: 'ENOENT' });
  if (process.getuid() !== 0) {
    chmodSync(privateParent, 0o000);
    assert.throws(() => workspaceRoots(cwd), { code: 'EACCES' });
  }
});
