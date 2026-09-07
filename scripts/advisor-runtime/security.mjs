import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isCommandId } from '../advisor-core/command-contract.mjs';

export class RuntimeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function demand(condition, code) { if (!condition) throw new RuntimeError(code); }
export function id(value) { demand(isCommandId(value), 'INVALID_ID'); return value; }
export function within(root, path) { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); }
export function privateDirectory(path) {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  demand(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid(), 'UNSAFE_DIRECTORY');
  demand(realpathSync(absolute) === absolute, 'SYMLINK_PATH');
  return absolute;
}
/** Resolve existing components without following aliases; missing descendants inherit a checked real parent. */
export function canonicalLocation(path) {
  demand(typeof path === 'string' && isAbsolute(path), 'ABSOLUTE_PATH_REQUIRED');
  const absolute = resolve(path); let parent = absolute; const missing = [];
  for (;;) {
    try {
      const stat = lstatSync(parent);
      demand(!stat.isSymbolicLink() && realpathSync(parent) === parent, 'SYMLINK_PATH');
      demand(missing.length === 0 || stat.isDirectory(), 'UNSAFE_PARENT');
      return resolve(parent, ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      demand(dirname(parent) !== parent, 'UNSAFE_PARENT');
      missing.push(parent.slice(dirname(parent).length + (dirname(parent) === '/' ? 0 : 1))); parent = dirname(parent);
    }
  }
}
export function disjointControlPath(path, roots) {
  const canonical = canonicalLocation(path);
  demand(roots.every(root => !within(root, canonical) && !within(canonical, root)), 'CONTROL_WORKSPACE_OVERLAP');
  return canonical;
}
export function safeFile(path) {
  canonicalLocation(resolve(path));
  let stat; try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'UNSAFE_FILE');
}
export function boundedRead(root, name, maxBytes = 65536, offset = 0) {
  demand(typeof name === 'string' && name.length > 0 && !isAbsolute(name) && !name.split(/[\\/]/).some(p => p === '..' || p === '.' || !p), 'PATH_FORBIDDEN');
  demand(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 65536 && Number.isSafeInteger(offset) && offset >= 0 && offset <= 1048576, 'READ_BOUNDS');
  const path = resolve(root, name);
  demand(within(root, path), 'PATH_FORBIDDEN');
  demand(realpathSync(root) === resolve(root) && !lstatSync(root).isSymbolicLink(), 'SYMLINK_PATH');
  let current = root;
  for (const part of name.split('/')) { current = join(current, part); demand(!lstatSync(current).isSymbolicLink(), 'SYMLINK_PATH'); }
  demand(within(realpathSync(root), realpathSync(path)), 'PATH_FORBIDDEN');
  const before = lstatSync(path);
  demand(before.isFile() && before.nlink === 1, 'UNSAFE_FILE');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    const currentStat = lstatSync(path);
    demand(realpathSync(root) === resolve(root) && realpathSync(path) === path && currentStat.ino === stat.ino && currentStat.dev === stat.dev, 'PATH_CHANGED');
    demand(stat.isFile() && stat.nlink === 1, 'UNSAFE_FILE');
    const bytes = Buffer.alloc(maxBytes);
    const length = readSync(fd, bytes, 0, maxBytes, offset);
    return { text: bytes.subarray(0, length).toString('utf8'), bytes: length, nextOffset: offset + length, eof: offset + length >= stat.size };
  } finally { closeSync(fd); }
}

function readOwner(path) {
  try {
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    demand(Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.nonce === 'string', 'OWNER_CORRUPT');
    return owner;
  } catch { throw new RuntimeError('OWNER_CORRUPT'); }
}

// PID liveness is conservative: PID reuse refuses takeover. No clock-based lease.
// A crash while holding the tiny acquisition gate requires explicit local repair.
export function acquireLock(path) {
  const gate = `${path}.gate`;
  try { mkdirSync(gate, { mode: 0o700 }); } catch { throw new RuntimeError('OWNER_BUSY'); }
  const nonce = randomUUID();
  try {
    if (existsSync(path)) {
      const owner = readOwner(path);
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      demand(dead, 'OWNER_BUSY');
      rmSync(path, { recursive: true });
    }
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600, flag: 'wx' });
  } finally { rmSync(gate, { recursive: true }); }
  return () => {
    const owner = readOwner(path);
    demand(owner.nonce === nonce, 'OWNER_FENCE');
    rmSync(path, { recursive: true });
  };
}

// All future Pi/native appenders must use this exact namespace, including legacy.
// Ownership is permanent; a legacy trace is never imported or adopted.
export function withRunOwnership(root, run, kind, owner, action) {
  id(run); id(owner); demand(['runtime', 'legacy'].includes(kind), 'INVALID_OWNER');
  const directory = privateDirectory(join(root, 'ownership'));
  const release = acquireLock(join(directory, `${run}.lock`));
  let asynchronous = false;
  try {
    const path = join(directory, `${run}.json`);
    if (existsSync(path)) {
      safeFile(path);
      const prior = JSON.parse(readFileSync(path, 'utf8'));
      demand(prior.kind === kind && prior.owner === owner, 'RUN_OWNED');
    } else {
      demand(kind === 'legacy' || !existsSync(join(root, 'traces', `${run}.jsonl`)), 'LEGACY_TRACE');
      writeFileSync(path, JSON.stringify({ kind, owner }), { mode: 0o600, flag: 'wx' });
    }
    const result = action();
    if (result && typeof result.then === 'function') {
      asynchronous = true;
      return Promise.resolve(result).finally(release);
    }
    return result;
  } finally { if (!asynchronous) release(); }
}

/**
 * Serialize legacy appenders across processes while preserving permanent ownership.
 * Only a transient acquisition collision is retried; marker mismatches and action
 * failures always surface to the caller.
 */
export async function withLegacyRunOwnership(root, run, action) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = realpathSync(root);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let actionStarted = false;
    try {
      const result = withRunOwnership(canonicalRoot, run, 'legacy', 'legacy', () => {
        actionStarted = true;
        return action();
      });
      return await result;
    } catch (error) {
      if (actionStarted || error?.code !== 'OWNER_BUSY' || attempt === 199) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new RuntimeError('OWNER_BUSY');
}

export function atomicWrite(path, content, fault = () => {}) {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    // Deliberately split for deterministic torn-export tests. Target is never partial.
    const split = Math.floor(Buffer.byteLength(content) / 2);
    const bytes = Buffer.from(content);
    writeFileSync(fd, bytes.subarray(0, split));
    fault('export.partial');
    writeFileSync(fd, bytes.subarray(split));
    // fsync is loaded below to keep the write/rename/directory fence explicit.
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
  fault('export.renamed');
}
import { fsyncSync } from 'node:fs';
