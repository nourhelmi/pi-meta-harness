// Host-neutral checkpoint storage. No execution runtime, Pi, Herdr, or model dependency.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const exec = promisify(execFile);
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const session = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const digest = text => createHash('sha256').update(text).digest('hex');
function demand(ok, message) { if (!ok) throw new Error(message); }
function info(path) { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
function stateSlug(path) { return `${basename(path).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'dir'}-${digest(path).slice(0, 8)}`; }

export async function advisorStateRoot(cwd) {
  if (process.env.ADVISOR_STATE_DIR) return resolve(process.env.ADVISOR_STATE_DIR);
  const directory = realpathSync(cwd);
  let anchor = directory;
  try {
    const { stdout } = await exec('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 5000 });
    const common = realpathSync(stdout.trim());
    anchor = basename(common) === '.git' ? dirname(common) : common;
  } catch (error) {
    // Non-repositories keep a directory identity; failures in a repository are not a new identity.
    demand(error.code === 128 && /not a git repository/i.test(error.stderr ?? ''), 'Cannot resolve Git common directory; canonical advisor state is unavailable.');
  }
  return join(homedir(), '.advisor', stateSlug(anchor));
}

/** Trusted host API: Pi supplies its SessionManager id, native shells their host context.
 * IDs and environment are not an OS sandbox: a hostile same-user process can forge them. */
export function advisorIdentity(host, sessionId) {
  demand(['pi', 'codex', 'claude-code'].includes(host) && typeof sessionId === 'string' && session.test(sessionId), 'Invalid advisor host/session identity');
  return { host, sessionId };
}
export function nativeAdvisorIdentity(env = process.env) {
  demand(!env.ADVISOR_BRIDGE_WORKER_DIR && !env.ADVISOR_RUNTIME_CANONICAL_OWNER, 'Scoped helpers must use their assigned evidence artifact, not claim a root checkpoint.');
  if (env.CODEX_THREAD_ID) return advisorIdentity('codex', env.CODEX_THREAD_ID);
  if (env.CLAUDE_SESSION_ID && env.CLAUDE_SESSION_ID !== '${CLAUDE_SESSION_ID}') return advisorIdentity('claude-code', env.CLAUDE_SESSION_ID);
  if (env.PI_SESSION_ID && env.PI_SESSION_FILE) {
    let header;
    try { header = JSON.parse(readFileSync(env.PI_SESSION_FILE, 'utf8').split('\n')[0]); }
    catch { throw new Error('Pi shell session context unavailable or corrupt'); }
    demand(header.type === 'session' && header.id === env.PI_SESSION_ID, 'Pi shell session context mismatch');
    return advisorIdentity('pi', header.id);
  }
  throw new Error('Host session identity unavailable: use CODEX_THREAD_ID, Claude skill-expanded CLAUDE_SESSION_ID, or Pi shell session context. No display-name fallback.');
}

function validate(root, workstream, identity) {
  demand(typeof workstream === 'string' && workstream.length <= 48 && slug.test(workstream), 'Invalid workstream slug');
  advisorIdentity(identity?.host, identity?.sessionId);
  demand(typeof root === 'string' && root === resolve(root), 'Absolute advisor state root required');
}
function key(identity) { return identity.host === 'pi' ? identity.sessionId : `${identity.host}-${identity.sessionId}`; }
export function advisorPaths(root, workstream, identity) {
  validate(root, workstream, identity);
  return { root, workstream: join(root, 'workstreams', `${workstream}.md`), session: join(root, 'sessions', `${key(identity)}.md`), events: join(root, 'events'), lock: join(root, 'locks', 'checkpoint') };
}

// The caller chooses the root. Canonicalize OS/home aliases above that root, but never
// follow a symlink at the root or inside the owned namespace (including a .advisor redirect).
function checkedRoot(root, create = false) {
  const parent = dirname(root);
  for (const path of [root, ...(basename(parent) === '.advisor' ? [parent] : [])]) demand(!info(path)?.isSymbolicLink(), 'Advisor state symlink refused');
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = info(root);
  demand(st?.isDirectory() && !st.isSymbolicLink() && (process.getuid === undefined || st.uid === process.getuid()), 'Unsafe advisor state root');
  return realpathSync(root);
}
function safePath(root, path) {
  const rel = path.slice(root.length + 1);
  demand(path.startsWith(root + '/') && rel && !rel.split('/').some(p => p === '..' || p === '.' || !p), 'Advisor state path escape');
  let current = root;
  for (const part of rel.split('/')) {
    current = join(current, part);
    const st = info(current);
    demand(!st?.isSymbolicLink() && (!st || st.isDirectory() || st.isFile() && st.nlink === 1), 'Advisor state symlink or special file refused');
  }
}
function readSafe(root, path) {
  checkedRoot(root); safePath(root, path);
  if (!info(path)) return undefined;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    demand(st.isFile() && st.nlink === 1 && st.size <= 65536 && (process.getuid === undefined || st.uid === process.getuid()), 'Unsafe or oversized advisor state file');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function writeSafe(root, path, content) {
  demand(Buffer.byteLength(content) <= 65536, 'Advisor checkpoint exceeds 64KiB');
  checkedRoot(root); safePath(root, path);
  if (info(path)) readSafe(root, path);
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    checkedRoot(root); safePath(root, path);
    renameSync(temp, path);
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (info(temp)) unlinkSync(temp); }
}
function transaction(root, action) {
  checkedRoot(root, true);
  for (const name of ['workstreams', 'sessions', 'events', 'locks', 'runs', 'graphs']) {
    const path = join(root, name); safePath(root, path);
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const lock = join(root, 'locks', 'checkpoint'); safePath(root, lock);
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Advisor checkpoint is busy; retry after its owner finishes. A crashed lock requires explicit local inspection.'); throw error; }
  try { return action(); } finally { rmdirSync(lock); }
}
function metadata(content, workstream) {
  demand(content?.startsWith(`# Workstream: ${workstream}\n`) && content.includes('## Current state'), 'Checkpoint missing or corrupt; recover accepted artifacts explicitly');
  function field(label, fallback) {
    const lines = content.split('\n').filter(line => line.startsWith(`- ${label}:`));
    demand(lines.length <= 1, `Duplicate checkpoint ${label}`);
    if (!lines.length) return fallback;
    const match = lines[0].match(new RegExp(`^- ${label}: \x60([^\x60]+)\x60$`));
    demand(match, `Malformed checkpoint ${label}`);
    return match[1];
  }
  const identity = advisorIdentity(field('Owner host', 'pi'), field('Owner session'));
  const mode = field('Advisor mode', 'advisor');
  demand(['advisor', 'cos'].includes(mode), 'Invalid checkpoint advisor mode');
  return { ...identity, mode };
}
function sameOwner(a, b) { return a.host === b.host && a.sessionId === b.sessionId; }
export function readAdvisorCheckpoint({ root, workstream, identity }) {
  const paths = advisorPaths(root, workstream, identity);
  const content = readSafe(root, paths.workstream);
  const owner = metadata(content, workstream);
  demand(sameOwner(owner, identity), `Workstream ${workstream} is owned by ${owner.host} session ${owner.sessionId}; no foreign-owner takeover.`);
  return { paths, content, digest: digest(content), mode: owner.mode, identity };
}
export function advisorCheckpointOwner({ root, workstream, identity }) {
  const paths = advisorPaths(root, workstream, identity);
  if (!info(root)) return undefined;
  const content = readSafe(root, paths.workstream);
  return content === undefined ? undefined : metadata(content, workstream);
}
export function readAdvisorSession({ root, identity }) {
  advisorIdentity(identity?.host, identity?.sessionId);
  if (!info(root)) return undefined;
  const content = readSafe(root, join(root, 'sessions', `${key(identity)}.md`));
  if (content === undefined) return undefined;
  const workstream = content.match(/^- Workstream: `([^`]+)`$/m)?.[1];
  validate(root, workstream, identity);
  return { workstream, sessionId: identity.sessionId, initializedAt: content.match(/^- Initialized: `([^`]+)`$/m)?.[1] ?? 'legacy-state', workerHarness: content.match(/^- Worker harness: `(pi|native)`$/m)?.[1] ?? 'pi', mode: content.match(/^- Advisor mode: `(advisor|cos)`$/m)?.[1] ?? 'advisor' };
}
function writePointer(paths, identity, state) {
  const old = readSafe(paths.root, paths.session);
  if (old && !old.includes(`- Checkpoint: \`../workstreams/${state.workstream}.md\``)) {
    const archive = paths.session + '.legacy'; const prior = readSafe(paths.root, archive);
    demand(prior === undefined || prior === old, 'Legacy session archive differs; preserve and resolve it explicitly');
    if (prior === undefined) writeSafe(paths.root, archive, old);
  }
  writeSafe(paths.root, paths.session, `# Advisor Session ${identity.sessionId.slice(0, 8)}\n\n- Host: \`${identity.host}\`\n- Workstream: \`${state.workstream}\`\n- Checkpoint: \`../workstreams/${state.workstream}.md\`\n- Initialized: \`${state.initializedAt}\`\n- Worker harness: \`${state.workerHarness}\`\n- Advisor mode: \`${state.mode}\`\n\nOperational state lives only in the workstream current section. This is an identity pointer, not a diary.\n`);
}
export function claimAdvisorCheckpoint({ root, workstream, identity, workerHarness = 'pi', mode, transferFrom }) {
  const paths = advisorPaths(root, workstream, identity);
  demand(['pi', 'native'].includes(workerHarness) && (mode === undefined || ['advisor', 'cos'].includes(mode)), 'Invalid advisor mode or worker harness');
  return transaction(root, () => {
    const prior = readAdvisorSession({ root, identity });
    demand(!prior || prior.workstream === workstream, 'This host session already owns a different advisor workstream; start a fresh session.');
    const current = readSafe(root, paths.workstream);
    demand(current !== undefined || !prior, 'Checkpoint missing; session pointer is not proof. Recover accepted artifacts explicitly.');
    const owner = current === undefined ? undefined : metadata(current, workstream);
    if (owner && !sameOwner(owner, identity)) demand(transferFrom && sameOwner(owner, transferFrom), `Workstream ${workstream} is owned by ${owner.host} session ${owner.sessionId}; explicit owner-confirmed transfer required.`);
    const state = { workstream, sessionId: identity.sessionId, initializedAt: prior?.initializedAt ?? new Date().toISOString(), workerHarness: prior?.workerHarness ?? workerHarness, mode: mode === 'cos' || owner?.mode === 'cos' ? 'cos' : 'advisor' };
    let content = current ?? `# Workstream: ${workstream}\n\n- Owner session: \`${identity.sessionId}\`\n- Owner host: \`${identity.host}\`\n- Advisor mode: \`${state.mode}\`\n- Status: active\n\n## Goal\n\nTo be defined from the advisor conversation.\n\n## Current state\n\nInitialized by the shared advisor checkpoint helper.\n\n## Scope ledger\n\nRecord material scope decisions and why: accepted outcome, ownership and safety boundaries, necessary in-scope work, and unresolved product choices. The maker owns remaining diagnosis, implementation and verification. Update on material changes, not every edit.\n`;
    if (owner && !sameOwner(owner, identity)) {
      writeSafe(root, join(paths.events, `${randomUUID()}-handoff.md`), `# Advisor workstream handoff\n\n- Workstream: \`${workstream}\`\n- Previous owner: \`${owner.host}/${owner.sessionId}\`\n- New owner: \`${identity.host}/${identity.sessionId}\`\n\n${current}`);
      content = content.replace(/^- Owner session: `[^`]+`$/m, `- Owner session: \`${identity.sessionId}\``);
    }
    for (const [label, value] of [['Owner host', identity.host], ['Advisor mode', state.mode]]) {
      const pattern = new RegExp(`^- ${label}: .*$`, 'm');
      content = pattern.test(content) ? content.replace(pattern, `- ${label}: \`${value}\``) : content.replace(/(^- Owner session:.*$)/m, `$1\n- ${label}: \`${value}\``);
    }
    if (content !== current) writeSafe(root, paths.workstream, content);
    writePointer(paths, identity, state);
    return { ...readAdvisorCheckpoint({ root, workstream, identity }), state };
  });
}
export function updateAdvisorCheckpoint({ root, workstream, identity, expectedDigest, content }) {
  advisorPaths(root, workstream, identity);
  demand(typeof content === 'string' && typeof expectedDigest === 'string', 'Checkpoint content and expected digest required');
  return transaction(root, () => {
    const current = readAdvisorCheckpoint({ root, workstream, identity });
    demand(current.digest === expectedDigest, 'Stale checkpoint digest; read current state before writing');
    const next = metadata(content, workstream);
    demand(sameOwner(next, identity) && next.mode === current.mode, 'Checkpoint owner/mode mutation refused; use explicit initialization/transfer');
    writeSafe(root, current.paths.workstream, content);
    return readAdvisorCheckpoint({ root, workstream, identity });
  });
}
