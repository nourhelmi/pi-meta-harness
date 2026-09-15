import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalLocation, demand, within } from './security.mjs';

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  return result.status === 0 ? result.stdout : null;
}
export function repositoryIdentity(cwd) {
  demand(existsSync(cwd), 'ENOENT');
  canonicalLocation(cwd);
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common ? realpathSync(common.trim()) : null;
}
/** Registration comes from local Git, never the request's list of roots. */
export function registeredRoots(cwd, common = repositoryIdentity(cwd)) {
  demand(existsSync(cwd), 'ENOENT');
  canonicalLocation(cwd);
  if (!common) return [resolve(cwd)];
  demand(repositoryIdentity(cwd) === common, 'WORKSPACE_IDENTITY_CHANGED');
  const listing = git(cwd, ['worktree', 'list', '--porcelain', '-z']);
  demand(listing !== null, 'PI_DETACH_WORKTREE_DISCOVERY_FAILED');
  return listing.split('\0').filter(value => value.startsWith('worktree ')).flatMap(value => {
    const path = value.slice(9);
    try {
      realpathSync(path); canonicalLocation(path);
      // A stale registration is not authority and must not disable other roots.
      return repositoryIdentity(path) === common ? [path] : [];
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'SYMLINK_PATH') return [];
      throw error;
    }
  });
}
export function authorizedWorktree(anchor, candidate, common = repositoryIdentity(anchor)) {
  canonicalLocation(candidate);
  return common !== null && registeredRoots(anchor, common).includes(resolve(candidate));
}

/** The trusted initial cwd may be a package subdirectory of a registered worktree. */
export function authorizedWorkspace(anchor, candidate, common = repositoryIdentity(anchor)) {
  canonicalLocation(candidate);
  if (!common) return resolve(candidate) === resolve(anchor);
  const roots = registeredRoots(anchor, common);
  return roots.includes(resolve(candidate)) || roots.some(root => within(root, resolve(anchor))) && within(resolve(anchor), resolve(candidate)) && repositoryIdentity(candidate) === common;
}
