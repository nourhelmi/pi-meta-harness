// Private deterministic memory conformance harness. No persistence or real adapter.
import assert from "node:assert/strict";
import { admitCommand } from "../scripts/advisor-core/command-admission.mjs";
import { freezeData } from "../scripts/advisor-core/command-contract.mjs";

export function snapshot(state = "blocked") {
  return freezeData({ scope: { workstream: "work", run: "run", node: "node", ownerEpoch: 2 }, revision: 4,
    state, attempt: 1, blockedSequence: state === "blocked" ? 7 : null,
    request: state === "blocked" ? { id: "request-1", run: "run", node: "node", attempt: 1, blockedSequence: 7, answered: false } : null,
    cancel: null, capabilities: { "node.reply": true, "node.cancel": true } });
}
export function principal(id = "alice", scopes = [{ workstream: "work", run: "run", node: "node" }]) {
  return freezeData({ id, scopes });
}
export function command(op = "node.reply", commandId = "command-1", current = snapshot()) {
  return { v: 1, commandId, scope: { ...current.scope }, op, expectedRevision: current.revision,
    payload: op === "node.reply" ? { attempt: current.attempt, requestId: "request-1", text: "Proceed" }
      : { attempt: current.attempt, reason: "Stop" } };
}
export function changed(value, edit) {
  const copy = structuredClone(value); edit(copy); return freezeData(copy);
}
export function readonlyReceipts(entries = []) {
  const map = new Map(entries);
  Object.defineProperties(map, Object.fromEntries(["set", "delete", "clear"].map((method) =>
    [method, { value() { throw new Error("receipt lookup is read-only"); } }])));
  return Object.freeze(map);
}
export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export class MemoryStore {
  constructor(current = snapshot()) {
    this.snapshot = current;
    this.receipts = new Map();
    this.outbox = new Map();
    this.dispatched = new Set();
    this.commits = 0;
  }
  read() {
    return { snapshot: this.snapshot, receipts: readonlyReceipts(this.receipts) };
  }
  async compareAndCommit(proposal) {
    if (this.gate) {
      this.gate.entered.resolve();
      await this.gate.release.promise;
    }
    const no = (reason) => ({ committed: false, reason, intents: [] });
    const prior = this.receipts.get(proposal.record.receipt.commandId);
    if (prior) {
      if (prior.principalId !== proposal.record.principalId) return no("PRINCIPAL_MISMATCH");
      if (prior.digest !== proposal.record.digest) return no("COMMAND_ID_REUSE");
      return no("DUPLICATE_COMMIT");
    }
    const { scope, revision } = proposal.expected;
    if (["workstream", "run", "node"].some((key) => scope[key] !== this.snapshot.scope[key])) return no("SCOPE_MISMATCH");
    if (scope.ownerEpoch !== this.snapshot.scope.ownerEpoch) return no("OWNER_EPOCH_MISMATCH");
    if (revision !== this.snapshot.revision) return no("STALE_REVISION");
    if (proposal.intents.some((intent) => this.outbox.has(intent.id))) return no("DUPLICATE_INTENT");
    // No await between these writes: this models an atomic transaction in ONE JS instance.
    this.snapshot = proposal.nextSnapshot;
    this.receipts.set(proposal.record.receipt.commandId, proposal.record);
    for (const intent of proposal.intents) this.outbox.set(intent.id, intent);
    this.commits += 1;
    return { committed: true, receipt: proposal.record.receipt, intents: proposal.intents };
  }
  async dispatch(committed, adapter) {
    if (!committed.committed) return;
    for (const intent of committed.intents) {
      assert.equal(this.outbox.get(intent.id), intent, "adapter cannot run before persisted intent");
      if (this.dispatched.has(intent.id)) continue;
      this.dispatched.add(intent.id);
      await adapter[intent.op === "node.reply" ? "reply" : "cancel"](intent);
    }
  }
  finalizeCancel() {
    assert.ok(this.snapshot.cancel);
    this.snapshot = changed(this.snapshot, (state) => { state.state = "terminal"; state.revision += 1; });
  }
}

// Test-only consumer of the declared ports. Never production runtime code.
export async function submit(store, input, actor, adapter) {
  const decision = admitCommand({ command: input, principal: actor, ...store.read() });
  if (!decision.commit) return decision;
  const committed = await store.compareAndCommit(decision.commit);
  await store.dispatch(committed, adapter);
  return { decision, committed };
}

export function adapterSpy(store) {
  const calls = [];
  async function effect(intent) {
    assert.ok(store.receipts.has(intent.commandId), "receipt precedes effect");
    assert.equal(store.outbox.get(intent.id), intent, "intent precedes effect");
    calls.push(intent);
  }
  return { calls, reply: effect, cancel: effect };
}
