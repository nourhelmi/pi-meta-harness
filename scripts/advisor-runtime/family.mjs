// Executed only inside the root runtime's SQLite BEGIN IMMEDIATE transaction.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson } from '../advisor-core/command-contract.mjs';
import { fields, integer, scope, text } from './contract.mjs';
import { demand, disjointControlPath } from './security.mjs';
import { childStatePath, publicChildScope } from './child-scope.mjs';

export function newFamily(stateRoot, config) {
  const workerHarness = config.managedIdentity?.workerHarness;
  demand(workerHarness === undefined || ['pi', 'native'].includes(workerHarness), 'FAMILY_BINDING_MISMATCH');
  const family = { v: 1, id: randomBytes(16).toString('hex'), rootStateRoot: stateRoot, workstream: config.managedIdentity?.workstream ?? config.scopes[0].workstream, ...(workerHarness ? { workerHarness } : {}) };
  return { family, ...(config.managedIdentity?.workstream || workerHarness ? { advisorBinding: { ...(config.managedIdentity?.workstream ? { workstream: config.managedIdentity.workstream } : {}), ...(workerHarness ? { workerHarness } : {}) } } : {}), maxLaunches: config.maxLaunches, admissions: {}, services: { [stateRoot]: { token: randomBytes(32).toString('hex'), sessionId: config.sessionId, workstream: config.scopes[0].workstream, allowedRoots: config.allowedRoots, parent: null, sealed: false } } };
}
export function familyOperation(ledger, token, action, p) {
  const entry = Object.entries(ledger.services).find(([, service]) => service.token === token);
  demand(entry, 'FAMILY_UNAUTHORIZED');
  const [stateRoot, service] = entry;
  const scopeCheck = value => { scope(value); demand(value.workstream === service.workstream && value.node === 'worker' && value.ownerEpoch === 1, 'FAMILY_SCOPE_FORBIDDEN'); };
  const active = () => {
    let current = service;
    for (let depth = 0; current; depth++) {
      demand(depth <= 256 && !current.sealed, 'FAMILY_ADMISSION_SEALED');
      current = current.parent ? ledger.services[current.parent] : null;
    }
  };
  if (action === 'inspect') { fields(p, []); demand(service.grant, 'FAMILY_SCOPE_FORBIDDEN'); return publicChildScope(service.grant); }
  if (action === 'bind') {
    fields(p, ['grant', 'sessionId', 'workstream']); text(p.sessionId, 256); text(p.workstream, 128);
    demand(service.grant && canonicalJson(p.grant) === canonicalJson(service.grant), 'PI_DETACH_CHILD_GRANT_MISMATCH');
    demand(!service.sessionId || service.sessionId === p.sessionId && service.workstream === p.workstream, 'PI_DETACH_BINDING_MISMATCH');
    service.sessionId = p.sessionId; service.workstream = p.workstream;
    return publicChildScope(service.grant);
  }
  demand(service.sessionId, 'FAMILY_BINDING_REQUIRED');
  if (action === 'budget') { fields(p, []); const used = Object.keys(ledger.admissions).length; return { maxLaunches: ledger.maxLaunches, used, remaining: ledger.maxLaunches - used }; }
  if (action === 'check') { fields(p, []); active(); return { active: true }; }
  if (action === 'reserve') {
    fields(p, ['commandId', 'digest', 'scope', 'op', 'attempt']); text(p.commandId, 128); scopeCheck(p.scope); integer(p.attempt, 1);
    demand(/^[a-f0-9]{64}$/.test(p.digest) && ['node.launch', 'node.task', 'node.reply'].includes(p.op), 'FAMILY_ADMISSION_INVALID');
    const key = canonicalJson([stateRoot, p.commandId]);
    const old = ledger.admissions[key];
    if (old) { demand(canonicalJson(old) === canonicalJson(p), 'COMMAND_ID_REUSE'); return { reserved: true }; }
    active(); demand(Object.keys(ledger.admissions).length < ledger.maxLaunches, 'BRIDGE_LAUNCH_LIMIT');
    ledger.admissions[key] = p;
    return { reserved: true };
  }
  if (action === 'register') {
    fields(p, ['scope', 'cwd', 'issuedAttempt']); scopeCheck(p.scope); integer(p.issuedAttempt, 1);
    demand(service.allowedRoots.includes(p.cwd), 'FAMILY_CWD_FORBIDDEN');
    const childState = childStatePath(ledger.family.rootStateRoot, stateRoot, p.scope.run);
    const old = ledger.services[childState];
    if (old) { demand(old.grant.cwd === p.cwd && canonicalJson(old.grant.parent.scope) === canonicalJson(p.scope), 'PI_DETACH_CHILD_GRANT_MISMATCH'); return old.grant; }
    active();
    demand(Object.entries(ledger.admissions).some(([key, value]) => key === canonicalJson([stateRoot, value.commandId]) && value.scope.run === p.scope.run && value.op === 'node.launch'), 'FAMILY_OUTCOME_UNRESERVED');
    disjointControlPath(childState, service.allowedRoots);
    demand(Buffer.byteLength(join(childState, 'runtime.sock')) <= 100, 'SOCKET_PATH_TOO_LONG');
    const grant = { v: 2, cwd: p.cwd, stateRoot: childState, allowedRoots: service.allowedRoots, parent: { stateRoot, sessionId: service.sessionId, scope: p.scope }, family: ledger.family, issuedAttempt: p.issuedAttempt, authority: { token: randomBytes(32).toString('hex') } };
    ledger.services[childState] = { token: grant.authority.token, sessionId: null, workstream: null, allowedRoots: grant.allowedRoots, parent: stateRoot, sealed: false, grant };
    return grant;
  }
  if (action === 'children') { fields(p, []); return Object.entries(ledger.services).filter(([, child]) => child.parent === stateRoot).map(([path]) => path); }
  if (action === 'seal') {
    fields(p, [], ['scope']);
    if (p.scope) scopeCheck(p.scope);
    const target = p.scope ? childStatePath(ledger.family.rootStateRoot, stateRoot, p.scope.run) : stateRoot;
    // A leaf has no child service; never creates one merely for cancellation.
    if (ledger.services[target]) ledger.services[target].sealed = true;
    return { sealed: true };
  }
  demand(false, 'FAMILY_OPERATION_FORBIDDEN');
}
