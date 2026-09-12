// Node22-safe capability carrier. Only the private authority field is secret.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../advisor-core/command-contract.mjs';
import { fields, integer, scope, text } from './contract.mjs';
import { boundedRead, demand, disjointControlPath, safeFile } from './security.mjs';
import { callSocket } from './service.mjs';

export const childStatePath = (root, parent, run) => join(root, 'c', createHash('sha256').update(canonicalJson({ parent, run })).digest('hex').slice(0, 20));
export function readChildGrant(stateRoot, cwd) {
  const path = join(stateRoot, 'child-grant.json');
  safeFile(path);
  const bytes = boundedRead(stateRoot, 'child-grant.json'); demand(bytes.eof, 'PI_DETACH_CHILD_GRANT_MISMATCH');
  let grant;
  try { grant = JSON.parse(bytes.text); } catch { demand(false, 'PI_DETACH_CHILD_GRANT_MISMATCH'); }
  demand(grant?.v === 1 || grant?.v === 2, 'PI_DETACH_CHILD_GRANT_MISMATCH');
  if (grant.v === 1) {
    fields(grant, ['v', 'cwd', 'stateRoot']);
    demand(grant.cwd === realpathSync(cwd) && grant.stateRoot === stateRoot, 'PI_DETACH_CHILD_GRANT_MISMATCH');
    return grant; // Read/close compatibility only; no recursive authority.
  }
  fields(grant, ['v', 'cwd', 'stateRoot', 'allowedRoots', 'parent', 'family', 'issuedAttempt', 'authority']);
  fields(grant.parent, ['stateRoot', 'sessionId', 'scope']); scope(grant.parent.scope);
  fields(grant.family, ['v', 'id', 'rootStateRoot', 'workstream'], ['workerHarness', 'teamMode']);
  demand(grant.family.workerHarness === undefined || ['pi', 'native'].includes(grant.family.workerHarness), 'PI_DETACH_CHILD_GRANT_MISMATCH');
  demand(grant.family.teamMode === undefined || grant.family.teamMode === true, 'PI_DETACH_CHILD_GRANT_MISMATCH');
  fields(grant.authority, ['token']);
  demand(grant.v === 2 && grant.family.v === 1 && /^[a-f0-9]{32}$/.test(grant.family.id) && /^[a-f0-9]{64}$/.test(grant.authority.token), 'PI_DETACH_CHILD_GRANT_MISMATCH');
  text(grant.parent.sessionId, 256); text(grant.family.workstream, 128); integer(grant.issuedAttempt, 1);
  demand(Array.isArray(grant.allowedRoots) && grant.allowedRoots.length > 0 && grant.allowedRoots.length <= 64 && grant.allowedRoots.every(root => realpathSync(root) === root), 'PI_DETACH_CHILD_GRANT_MISMATCH');
  demand(grant.cwd === realpathSync(cwd) && grant.allowedRoots.includes(grant.cwd) && grant.stateRoot === stateRoot && stateRoot === childStatePath(grant.family.rootStateRoot, grant.parent.stateRoot, grant.parent.scope.run), 'PI_DETACH_CHILD_GRANT_MISMATCH');
  for (const path of [stateRoot, grant.parent.stateRoot, grant.family.rootStateRoot]) disjointControlPath(path, grant.allowedRoots);
  demand(Buffer.byteLength(join(stateRoot, 'runtime.sock')) <= 100, 'SOCKET_PATH_TOO_LONG');
  return grant;
}
export const publicChildScope = ({ authority: _authority, ...grant }) => grant;
export async function familyCall(grant, action, payload) {
  demand(grant?.v === 2, 'PI_DETACH_LEGACY_CHILD_REQUIRES_REISSUE');
  const socketPath = familySocket(grant);
  const result = await callSocket({ socketPath, token: grant.authority.token }, { v: 1, op: 'family', action, payload }, 'model');
  demand(result?.ok, result?.error ?? 'FAMILY_UNAVAILABLE');
  return result.value;
}
function familySocket(grant) {
  demand(grant?.v === 2, 'PI_DETACH_LEGACY_CHILD_REQUIRES_REISSUE');
  const socketPath = join(grant.family.rootStateRoot, 'runtime.sock');
  const socket = lstatSync(socketPath);
  demand(socket.isSocket() && !socket.isSymbolicLink() && socket.uid === process.getuid() && (socket.mode & 0o777) === 0o600, 'FAMILY_UNSAFE_SOCKET');
  return socketPath;
}
/** A child teammate uses its existing family authority against the root runtime.
 * The generic runtime contract still performs scope, sender and replay checks. */
export async function parentRuntimeCall(grant, command) {
  const result = await callSocket({ socketPath: familySocket(grant), token: grant.authority.token }, command, 'model');
  demand(result?.ok, result?.error ?? 'TEAM_RUNTIME_UNAVAILABLE');
  return result.value ?? result.receipt;
}
/** Validated, non-secret extension API. Root sessions return null; old grants never gain authority. */
export async function readChildScope({ cwd, env = process.env } = {}) {
  const stateRoot = env.ADVISOR_BRIDGE_CHILD_STATE;
  if (!stateRoot) return null;
  demand(existsSync(join(stateRoot, 'child-grant.json')), 'PI_DETACH_CHILD_GRANT_MISMATCH');
  const grant = readChildGrant(stateRoot, cwd);
  const verified = await familyCall(grant, 'inspect', {});
  demand(canonicalJson(verified) === canonicalJson(publicChildScope(grant)), 'PI_DETACH_CHILD_GRANT_MISMATCH');
  return verified;
}
