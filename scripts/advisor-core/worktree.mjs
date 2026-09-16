#!/usr/bin/env node
// Create a Git worktree and carry over the untracked env files so the app stack runs there.
// Usage: node worktree.mjs add <path> [git worktree add options...] [--no-env]
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_FILE = /^\.env(?:\..+)?$/;

export function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  return result.stdout;
}

export function sourceRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

/** Untracked or ignored env files in the source worktree, relative to its root. Ignored directories stay collapsed. */
export function envFiles(root) {
  const listed = ['--ignored', null].flatMap(flag => git(root, ['ls-files', '--others', '--exclude-standard', '--directory', '-z', ...(flag ? [flag] : [])]).split('\0'));
  return [...new Set(listed)].filter(path => path && !path.endsWith('/') && ENV_FILE.test(basename(path))).sort();
}

export function copyEnvFiles(root, target) {
  const copied = []; const skipped = [];
  for (const relative of envFiles(root)) {
    const destination = join(target, relative);
    if (existsSync(destination)) { skipped.push(relative); continue; }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, relative), destination);
    copied.push(relative);
  }
  return { copied, skipped };
}

export function addWorktree(cwd, args, { env = true } = {}) {
  const [path, ...rest] = args;
  if (!path || path.startsWith('-')) throw new Error('Usage: worktree.mjs add <path> [git worktree add options...] [--no-env]');
  const root = sourceRoot(cwd);
  const target = resolve(cwd, path);
  git(root, ['worktree', 'add', ...rest, target]);
  return { target, root, ...(env ? copyEnvFiles(root, target) : { copied: [], skipped: [] }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...raw] = process.argv.slice(2);
    if (command !== 'add') throw new Error('Usage: worktree.mjs add <path> [git worktree add options...] [--no-env]');
    const env = !raw.includes('--no-env');
    const result = addWorktree(process.cwd(), raw.filter(arg => arg !== '--no-env'), { env });
    console.log(`Worktree: ${result.target}`);
    console.log(result.copied.length ? `Copied env files: ${result.copied.join(', ')}` : 'Copied env files: none');
    if (result.skipped.length) console.log(`Already present: ${result.skipped.join(', ')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
