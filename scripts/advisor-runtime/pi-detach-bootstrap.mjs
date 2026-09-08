// Node22-safe trusted lifecycle client. SQLite and execution stay in the host process.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, opendirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { canonicalJson } from '../advisor-core/command-contract.mjs';
import { RuntimeError, boundedRead, demand, privateDirectory, safeFile, disjointControlPath } from './security.mjs';
import { createPiDetachClient } from './pi-detach-client.mjs';

export const PI_DETACH_BOOTSTRAP_VERSION = 1;
export const configPath = (env = process.env) => join(env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'pi-detach-runtime.json');
export const managedBridgeEnabled = (env = process.env) => env.PI_DETACH_BACKEND !== 'legacy' && existsSync(configPath(env));
export function validateNode(executable) {
  demand(typeof executable === 'string' && executable.startsWith('/'), 'PI_DETACH_NODE_24_REQUIRED');
  const probe = spawnSync(executable, ['--input-type=module', '-e', 'import { DatabaseSync } from "node:sqlite"; const [a,b]=process.versions.node.split(".").map(Number); if(a<24||(a===24&&b<18))process.exit(2); console.log("SQLITE_OWNER_OK")'], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } });
  demand(probe.status === 0 && probe.stdout.trim() === 'SQLITE_OWNER_OK', 'PI_DETACH_NODE_24_REQUIRED');
  return realpathSync(executable);
}
export function readManagedConfig(path = configPath()) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  demand(value?.v === 1 && value.backend === 'runtime' && typeof value.host === 'string' && value.host.startsWith('/') && typeof value.stateBase === 'string' && value.stateBase.startsWith('/'), 'PI_DETACH_BRIDGE_CONFIGURATION');
  demand(existsSync(value.host), 'PI_DETACH_RUNTIME_MISSING');
  return value;
}
export function workspaceRoots(cwd) {
  const own = realpathSync(cwd);
  const git = args => spawnSync('git', ['-C', own, ...args], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return [own];
  const listing = git(['worktree', 'list', '--porcelain', '-z']);
  demand(listing.status === 0, 'PI_DETACH_WORKTREE_DISCOVERY_FAILED');
  const roots = listing.stdout.split('\0').filter(v => v.startsWith('worktree ')).map(v => realpathSync(v.slice(9)));
  demand(roots.includes(realpathSync(top.stdout.trim())) && roots.length <= 64, 'PI_DETACH_WORKSPACE_BOUND');
  return [...new Set([own, ...roots])].sort();
}
/**
 * Content hash of the code a service loads: the detach sources plus this runtime
 * and its core helpers. A live service reports the revision it started with, so a
 * later install is detected as drift instead of being silently ignored.
 */
export function installedRevision(detachPath, hostPath) {
  const runtimeDir = realpathSync(dirname(hostPath));
  const roots = [join(realpathSync(detachPath), 'src'), runtimeDir, resolve(runtimeDir, '..', 'advisor-core')];
  const digest = createHash('sha256'); let count = 0;
  // Bound enumeration before sorting or descending, including empty directories.
  // Hidden entries cost one visit, but their subtrees and bytes are excluded.
  const walk = (root, directory = root, depth = 0) => {
    demand(depth <= 64, 'PI_DETACH_REVISION_BOUND');
    const entries = []; const dir = opendirSync(directory);
    try {
      let entry;
      while ((entry = dir.readSync()) !== null) {
        demand(++count <= 2000, 'PI_DETACH_REVISION_BOUND');
        if (!entry.name.startsWith('.')) entries.push(entry);
      }
    } finally { dir.closeSync(); }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(root, path, depth + 1);
      else if (entry.isFile()) digest.update(path.slice(root.length)).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  for (const root of roots) walk(root);
  return digest.digest('hex').slice(0, 32);
}
export function bootstrapIdentity({ cwd, sessionId, detachPath, config, herdr, childState }) {
  demand(typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 256, 'PI_SESSION_REQUIRED');
  demand(herdr && typeof herdr.paneId === 'string' && herdr.paneId, 'HERDR_CONTEXT_REQUIRED');
  const identity = { v: 1, sessionId, cwd: realpathSync(cwd), detachPath: realpathSync(detachPath), host: realpathSync(config.host), herdr: Object.fromEntries(Object.entries(herdr).filter(([, value]) => typeof value === "string")), childState: childState || null };
  const key = createHash('sha256').update(canonicalJson({ sessionId, config: config.host })).digest('hex').slice(0, 20);
  return { identity, stateRoot: childState || join(config.stateBase, key) };
}
export async function ensurePiDetach({ cwd, sessionId, detachPath, herdr, env = process.env }) {
  const config = readManagedConfig(configPath(env));
  const node = validateNode(config.node);
  const { identity, stateRoot } = bootstrapIdentity({ cwd, sessionId, detachPath, config, herdr, childState: env.ADVISOR_BRIDGE_CHILD_STATE });
  const roots = workspaceRoots(cwd);
  disjointControlPath(stateRoot, roots);
  demand(Buffer.byteLength(join(stateRoot, 'runtime.sock')) <= 100, 'SOCKET_PATH_TOO_LONG');
  if (env.ADVISOR_BRIDGE_CHILD_STATE) {
    const grant = join(stateRoot, 'child-grant.json'); safeFile(grant);
    const parent = JSON.parse(readFileSync(grant, 'utf8'));
    demand(parent.v === 1 && parent.cwd === identity.cwd && parent.stateRoot === stateRoot, 'PI_DETACH_CHILD_GRANT_MISMATCH');
  }
  privateDirectory(stateRoot);
  const marker = join(stateRoot, 'startup.json');
  const descriptor = join(stateRoot, 'pi.json');
  const client = createPiDetachClient(descriptor);
  let won = false;
  // Exclusive marker is permanent after any uncertain startup. Never delete it
  // or an owner lock to adopt a dead service from an ordinary session hook.
  try { writeFileSync(marker, JSON.stringify({ identity, roots }), { flag: 'wx', mode: 0o600 }); won = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!won) {
    safeFile(marker);
    const stored = JSON.parse(readFileSync(marker, 'utf8'));
    demand(canonicalJson(stored.identity) === canonicalJson(identity) && canonicalJson(stored.roots) === canonicalJson(roots), 'PI_DETACH_BINDING_MISMATCH');
  }
  let child, failed = false;
  if (won) {
    child = spawn(node, [config.host, identity.detachPath, stateRoot, identity.cwd, sessionId, marker], { cwd: identity.cwd, env: { ...env, PI_DETACH_RUNTIME_BRIDGE: '', ADVISOR_RUNTIME_DESCRIPTOR: '', PI_DETACH_WORKER_HARNESS: '' }, detached: true, stdio: 'ignore' });
    child.once('error', () => { failed = true; });
    child.once('exit', () => { failed = true; });
    child.unref();
  }
  const revision = installedRevision(identity.detachPath, identity.host);
  const deadline = Date.now() + 10000;
  do {
    if (existsSync(descriptor)) {
      try {
        const ready = await client.request(sessionId, 'connect', { identity, cwd: identity.cwd });
        demand(ready.ready === true, 'PI_DETACH_BINDING_MISMATCH');
        // A reconnected service keeps the code it started with; drift is reported, never hot-swapped.
        return { client, descriptor, stateRoot, identity, revision, stale: ready.revision !== revision };
      } catch (error) {
        // Socket not yet published is the only startup race we wait through.
        if (existsSync(join(stateRoot, 'runtime.sock'))) throw error;
      }
    }
    demand(!failed, 'PI_DETACH_START_FAILED_RECOVERY_REQUIRED');
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error('PI_DETACH_START_UNCONFIRMED_RECOVERY_REQUIRED');
}

/** Trusted parent supervisor reads only its reserved child's control directory. */
export async function childWorkSettled(stateRoot) {
  try {
    const marker = join(stateRoot, 'startup.json'); safeFile(marker);
    const { identity } = JSON.parse(readFileSync(marker, 'utf8'));
    const client = createPiDetachClient(join(stateRoot, 'pi.json'));
    const state = await client.request(identity.sessionId, 'supervision', {});
    return state.settled === true;
  } catch { return false; } // missing/dead/ambiguous child never proves completion
}

function ownerAlive(stateRoot) {
  const owner = join(stateRoot, 'service.lock', 'owner.json');
  if (!existsSync(owner)) return false;
  try { process.kill(JSON.parse(readFileSync(owner, 'utf8')).pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // EPERM: alive but not ours; treat as alive
}

/**
 * Typed shutdown of one reserved child service. Never a kill and never a lock
 * deletion: an active, unacknowledged or unreachable-but-owned child refuses.
 * Returns 'closed', 'absent' (never bootstrapped or already closed) or throws.
 */
export async function closeChildService(childState) {
  const marker = join(childState, 'startup.json'); const descriptor = join(childState, 'pi.json');
  // Liveness first: a live owner whose control files are missing is mid-bootstrap or damaged, never absent.
  if (!ownerAlive(childState)) return 'absent';
  try {
    safeFile(marker);
    const stored = boundedRead(childState, 'startup.json');
    demand(stored.eof, 'CHILD_MARKER_TOO_LARGE');
    const { identity } = JSON.parse(stored.text);
    demand(identity && !Array.isArray(identity) && typeof identity.sessionId === 'string' && identity.sessionId.length > 0 && identity.sessionId.length <= 256, 'CHILD_IDENTITY_INVALID');
    await createPiDetachClient(descriptor).request(identity.sessionId, 'shutdown', {});
    return 'closed';
  } catch (error) {
    if (!ownerAlive(childState)) return 'absent';
    // Only a valid child's explicit lifecycle refusal establishes active work.
    const active = ['SHUTDOWN_BUSY', 'SHUTDOWN_PENDING', 'SHUTDOWN_ACTIVE', 'SHUTDOWN_DELIVERY', 'SHUTDOWN_CHILD_ACTIVE'].includes(error.message);
    throw new RuntimeError(active ? 'SHUTDOWN_CHILD_ACTIVE' : 'SHUTDOWN_CHILD_UNCERTAIN');
  }
}
/** Close every reserved child service under a parent state root; the first refusal stops the parent shutdown. */
export async function closeChildServices(stateRoot) {
  const base = join(stateRoot, 'children');
  if (!existsSync(base)) return [];
  const closed = [];
  for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const childState = join(base, entry.name);
    if (await closeChildService(childState) === 'closed') closed.push(childState);
  }
  return closed;
}
