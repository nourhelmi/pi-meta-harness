import { canonicalJson, freezeData, isCommandId, validateCommand } from "./command-contract.mjs";

/**
 * @typedef {import('./command-contract.mjs').CommandScope} CommandScope
 * @typedef {{workstream: string, run: string, node: string}} ScopeGrant
 * @typedef {{id: string, scopes: ScopeGrant[]}} Principal Authenticated by transport; never read from the command.
 * @typedef {{id: string, run: string, node: string, attempt: number, blockedSequence: number, answered: boolean}} RequestRecord
 * @typedef {{scope: CommandScope, revision: number, state: 'running'|'blocked'|'terminal',
 * attempt: number, blockedSequence: number|null, request: RequestRecord|null,
 * cancel: {attempt: number, intentId: string}|null, capabilities: {'node.reply'?: boolean, 'node.cancel'?: boolean}}} Snapshot
 * @typedef {{commandId: string, outcome: 'accepted'|'coalesced'|'already-terminal', intentId: string|null, revision: number}} Receipt
 * @typedef {{principalId: string, digest: string, scope: CommandScope, receipt: Receipt}} ReceiptRecord
 * @typedef {{id: string, commandId: string, scope: CommandScope} & (
 * {op: 'node.reply', payload: {attempt: number, requestId: string, text: string}, blockedSequence: number, nextAttempt: number} |
 * {op: 'node.cancel', payload: {attempt: number, reason: string}})} EffectIntent
 * @typedef {{expected: {scope: CommandScope, revision: number}, record: ReceiptRecord,
 * nextSnapshot: Snapshot, intents: EffectIntent[]}} CommitProposal
 * @typedef {{receipt: {outcome: 'rejected', reason: string}, intents: [], commit: null, replayed: false}} Rejection
 * @typedef {Rejection | {receipt: Receipt, intents: readonly [], commit: null, replayed: true} |
 * {receipt: Receipt, intents: EffectIntent[], commit: CommitProposal, replayed: false}} AdmissionDecision
 *
 * Store port (future implementation, no store is shipped here):
 * @typedef {{read: (scope: ScopeGrant) => Promise<{snapshot: Snapshot, receipts: ReadonlyMap<string, ReceiptRecord>}>,
 * compareAndCommit: (proposal: CommitProposal) => Promise<
 * {committed: true, receipt: Receipt, intents: EffectIntent[]} |
 * {committed: false, reason: string, intents: []}>}} CommandStore
 * Atomic transaction: compare scope/revision/epoch, enforce root-wide command-ID
 * uniqueness and principal/digest binding, persist receipt + state + intents together.
 * Duplicate/conflict/race returns no dispatchable intents. No partial writes.
 * Authorization/capability changes must invalidate the read revision or be fenced
 * in that same transaction. Proposals are internal, never client input.
 *
 * Adapter port: consume only committed, claimed intents, never admission output.
 * @typedef {{reply: (intent: EffectIntent) => Promise<void>, cancel: (intent: EffectIntent) => Promise<void>}} WorkerCommandAdapter
 * Resolution is transport acceptance, not settlement, host delivery or a model turn.
 */

/** @param {unknown} value @param {number} minimum */
const integer = (value, minimum) => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
/** @param {ScopeGrant} a @param {ScopeGrant} b */
const sameScope = (a, b) => a.workstream === b.workstream && a.run === b.run && a.node === b.node;
/** @param {ScopeGrant | null | undefined} scope */
const validScope = (scope) => scope && [scope.workstream, scope.run, scope.node].every(isCommandId);

/** @param {Principal} principal */
function principalValid(principal) {
  if (!principal || !isCommandId(principal.id) || !Array.isArray(principal.scopes)) return false;
  return Object.keys(principal).every((key) => ["id", "scopes"].includes(key)) &&
    principal.scopes.every((scope) => validScope(scope) && Object.keys(scope).length === 3);
}

/** @param {Snapshot} snapshot */
function snapshotValid(snapshot) {
  if (!snapshot || !validScope(snapshot.scope) || !integer(snapshot.scope.ownerEpoch, 1) ||
      !integer(snapshot.revision, 0) || !integer(snapshot.attempt, 1) ||
      !["running", "blocked", "terminal"].includes(snapshot.state) ||
      !snapshot.capabilities || typeof snapshot.capabilities !== "object" || Array.isArray(snapshot.capabilities)) return false;
  if (snapshot.blockedSequence !== null && !integer(snapshot.blockedSequence, 1)) return false;
  const request = snapshot.request;
  if (request !== null && (!request || !isCommandId(request.id) || !isCommandId(request.run) ||
      !isCommandId(request.node) || !integer(request.attempt, 1) || !integer(request.blockedSequence, 1) ||
      typeof request.answered !== "boolean")) return false;
  const cancel = snapshot.cancel;
  return cancel === null || Boolean(cancel && integer(cancel.attempt, 1) && typeof cancel.intentId === "string" && cancel.intentId.length > 0);
}

/** @param {string} reason @returns {Rejection} */
function rejected(reason) {
  return freezeData({ receipt: { outcome: "rejected", reason }, intents: [], commit: null, replayed: false });
}

/** Pure pre-effect decision. Inputs are trusted store data except commandInput.
 * No mutation, adapter calls, persistence, events, clock or ID generator.
 * @param {{command: unknown, principal: Principal, snapshot: Snapshot, receipts: ReadonlyMap<string, ReceiptRecord>}} input
 * @returns {AdmissionDecision}
 */
export function admitCommand({ command: commandInput, principal: principalInput, snapshot: snapshotInput, receipts }) {
  const parsed = validateCommand(commandInput);
  if (!parsed.ok) return rejected(parsed.reason);
  const { command, digest } = parsed;
  /** @type {Principal} */
  let principal;
  try { principal = JSON.parse(canonicalJson(principalInput)); } catch { return rejected("INVALID_PRINCIPAL"); }
  if (!principalValid(principal)) return rejected("INVALID_PRINCIPAL");
  if (!principal.scopes.some((scope) => sameScope(scope, command.scope))) return rejected("SCOPE_FORBIDDEN");

  // Authorize before lookup: even exact replay must not disclose another principal's receipt.
  const prior = receipts.get(command.commandId);
  if (prior) {
    if (prior.principalId !== principal.id) return rejected("PRINCIPAL_MISMATCH");
    if (prior.digest !== digest) return rejected("COMMAND_ID_REUSE");
    return Object.freeze({ receipt: prior.receipt, intents: Object.freeze(/** @type {[]} */ ([])), commit: null, replayed: true });
  }

  /** @type {Snapshot} */
  let snapshot;
  try { snapshot = JSON.parse(canonicalJson(snapshotInput)); } catch { return rejected("INVALID_SNAPSHOT"); }
  if (!snapshotValid(snapshot)) return rejected("INVALID_SNAPSHOT");
  if (!sameScope(snapshot.scope, command.scope)) return rejected("SCOPE_MISMATCH");
  if (snapshot.scope.ownerEpoch !== command.scope.ownerEpoch) return rejected("OWNER_EPOCH_MISMATCH");
  if (snapshot.revision !== command.expectedRevision) return rejected("STALE_REVISION");
  if (snapshot.attempt !== command.payload.attempt) return rejected("ATTEMPT_MISMATCH");
  if (snapshot.capabilities[command.op] !== true) return rejected("UNSUPPORTED_CAPABILITY");

  /** @type {Receipt['outcome']} */
  let outcome = "accepted";
  /** @type {string | null} */
  let intentId = `intent:${command.commandId}`;
  /** @type {EffectIntent[]} */
  const intents = [];
  const nextSnapshot = snapshot;
  if (command.op === "node.reply") {
    if (snapshot.cancel?.attempt === snapshot.attempt) return rejected("CANCEL_PENDING");
    if (snapshot.state !== "blocked") return rejected("NOT_BLOCKED");
    const request = snapshot.request;
    if (!request || request.id !== command.payload.requestId || request.run !== command.scope.run ||
        request.node !== command.scope.node || request.attempt !== command.payload.attempt ||
        request.blockedSequence !== snapshot.blockedSequence) return rejected("REQUEST_MISMATCH");
    if (request.answered) return rejected("REQUEST_ANSWERED");
    if (snapshot.attempt === Number.MAX_SAFE_INTEGER) return rejected("COUNTER_EXHAUSTED");
    intents.push({ id: intentId, commandId: command.commandId, scope: command.scope, op: command.op,
      payload: command.payload, blockedSequence: request.blockedSequence, nextAttempt: snapshot.attempt + 1 });
    request.answered = true;
    nextSnapshot.attempt += 1;
    nextSnapshot.state = "running";
    nextSnapshot.blockedSequence = null;
    nextSnapshot.cancel = null;
  } else if (snapshot.state === "terminal") {
    outcome = "already-terminal";
    intentId = null;
  } else if (snapshot.cancel?.attempt === snapshot.attempt) {
    outcome = "coalesced";
    intentId = snapshot.cancel.intentId;
  } else {
    intents.push({ id: intentId, commandId: command.commandId, scope: command.scope, op: command.op, payload: command.payload });
    nextSnapshot.cancel = { attempt: snapshot.attempt, intentId };
  }
  // Every new recorded outcome participates in CAS, including no-effect receipts.
  if (snapshot.revision === Number.MAX_SAFE_INTEGER) return rejected("COUNTER_EXHAUSTED");
  nextSnapshot.revision += 1;
  /** @type {Receipt} */
  const receipt = { commandId: command.commandId, outcome, intentId, revision: nextSnapshot.revision };
  return freezeData({ receipt, intents, replayed: false, commit: {
    expected: { scope: command.scope, revision: command.expectedRevision },
    record: { principalId: principal.id, digest, scope: command.scope, receipt },
    nextSnapshot, intents,
  } });
}
