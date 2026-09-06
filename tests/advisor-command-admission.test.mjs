import assert from "node:assert/strict";
import test from "node:test";
import { admitCommand } from "../scripts/advisor-core/command-admission.mjs";
import { adapterSpy, changed, command, deferred, MemoryStore, principal, readonlyReceipts, snapshot, submit } from "./advisor-command-test-helper.mjs";

function admission(input = command(), current = snapshot(), actor = principal(), receipts = readonlyReceipts()) {
  return admitCommand({ command: input, snapshot: current, principal: actor, receipts });
}
function reject(decision, reason) {
  assert.deepEqual(decision, { receipt: { outcome: "rejected", reason }, intents: [], commit: null, replayed: false });
}
async function commit(store, input, actor = principal()) {
  const decision = admitCommand({ command: input, principal: actor, ...store.read() });
  assert.ok(decision.commit, JSON.stringify(decision.receipt));
  const result = await store.compareAndCommit(decision.commit);
  assert.equal(result.committed, true);
  return decision;
}

test("AC1: malformed commands reject before authority lookup, with zero intents", () => {
  let lookups = 0;
  const receipts = { get() { lookups += 1; throw new Error("must not lookup"); } };
  reject(admission({ ...command(), principal: "forged" }, snapshot(), principal(), receipts), "EXTRA_FIELD");
  assert.equal(lookups, 0);
});

test("AC2: authorized semantic replay preserves original receipt and intent identity after state advances", async () => {
  const store = new MemoryStore();
  const input = command();
  const original = await commit(store, input);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  reordered.scope = Object.fromEntries(Object.entries(input.scope).reverse());
  reordered.payload = Object.fromEntries(Object.entries(input.payload).reverse());
  const replay = admitCommand({ command: reordered, principal: principal(), ...store.read() });
  assert.equal(replay.receipt, original.receipt);
  assert.equal(replay.receipt.intentId, original.intents[0].id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.commit, null);
  assert.deepEqual(replay.intents, []);
  assert.equal(store.outbox.size, 1);
  // Current epoch, capability and state are fresh-command checks, not replay effects.
  store.snapshot = changed(store.snapshot, (state) => {
    state.state = "terminal"; state.scope.ownerEpoch += 1; state.capabilities = {};
  });
  assert.equal(admitCommand({ command: input, principal: principal(), ...store.read() }).receipt, original.receipt);
});

test("AC2: changed body/op/run/node/workstream/epoch/expectation/request/attempt reuse is rejected", async () => {
  const store = new MemoryStore();
  const input = command();
  await commit(store, input);
  for (const edit of [
    (c) => { c.payload.text = "Different"; },
    (c) => { c.payload.text += " "; },
    (c) => { c.op = "node.cancel"; c.payload = { attempt: 1, reason: "Stop" }; },
    (c) => { c.scope.run = "other-run"; },
    (c) => { c.scope.node = "other-node"; },
    (c) => { c.scope.workstream = "other-work"; },
    (c) => { c.scope.ownerEpoch += 1; },
    (c) => { c.expectedRevision += 1; },
    (c) => { c.payload.requestId = "other-request"; },
    (c) => { c.payload.attempt += 1; },
  ]) {
    const candidate = changed(input, edit);
    const { workstream, run, node } = candidate.scope;
    // Explicitly grant the changed target so authorization does not mask ID reuse.
    reject(admitCommand({ command: candidate, principal: principal("alice", [{ workstream, run, node }]), ...store.read() }), "COMMAND_ID_REUSE");
    assert.equal(store.receipts.size, 1);
    assert.equal(store.outbox.size, 1);
  }
});

test("AC2: principal validation and scope authorization precede receipt lookup", async () => {
  let reads = 0;
  const ledger = { get() { reads += 1; throw new Error("receipt leaked"); } };
  for (const actor of [undefined, null, {}, { id: "alice" }, { id: "../alice", scopes: [] },
    { id: "alice", scopes: "all" }, { id: "alice", scopes: [], token: "forged" },
    { id: "alice", scopes: [{ workstream: "work", run: "run", node: "node", all: true }] }]) {
    reject(admitCommand({ command: command(), snapshot: snapshot(), principal: actor, receipts: ledger }), "INVALID_PRINCIPAL");
  }
  reject(admission(command(), snapshot(), principal("alice", []), ledger), "SCOPE_FORBIDDEN");
  for (const field of ["workstream", "run", "node"]) {
    const denied = changed(principal(), (actor) => { actor.scopes[0][field] = "other"; });
    reject(admission(command(), snapshot(), denied, ledger), "SCOPE_FORBIDDEN");
  }
  assert.equal(reads, 0);
  const store = new MemoryStore();
  const original = await commit(store, command());
  const other = admitCommand({ command: command(), principal: principal("bob"), ...store.read() });
  reject(other, "PRINCIPAL_MISMATCH");
  assert.ok(!JSON.stringify(other).includes(original.receipt.intentId));
  reject(admitCommand({ command: command(), principal: principal("alice", []), ...store.read() }), "SCOPE_FORBIDDEN");
});

const failures = [
  ["wrong workstream", "SCOPE_MISMATCH", (c) => { c.scope.workstream = "other"; }],
  ["wrong run", "SCOPE_MISMATCH", (c) => { c.scope.run = "other"; }],
  ["wrong node", "SCOPE_MISMATCH", (c) => { c.scope.node = "other"; }],
  ["wrong attempt", "ATTEMPT_MISMATCH", (c) => { c.payload.attempt = 2; }],
  ["wrong request", "REQUEST_MISMATCH", (c) => { c.payload.requestId = "other"; }],
  ["prior epoch", "OWNER_EPOCH_MISMATCH", (c) => { c.scope.ownerEpoch = 1; }],
  ["stale revision", "STALE_REVISION", (c) => { c.expectedRevision = 3; }],
  ["answered request", "REQUEST_ANSWERED", null, (s) => { s.request.answered = true; }],
  ["absent capability", "UNSUPPORTED_CAPABILITY", null, (s) => { delete s.capabilities["node.reply"]; }],
  ["false capability", "UNSUPPORTED_CAPABILITY", null, (s) => { s.capabilities["node.reply"] = false; }],
  ["truthy capability", "UNSUPPORTED_CAPABILITY", null, (s) => { s.capabilities["node.reply"] = "yes"; }],
  ["absent request", "REQUEST_MISMATCH", null, (s) => { s.request = null; }],
  ["request run binding", "REQUEST_MISMATCH", null, (s) => { s.request.run = "other"; }],
  ["request node binding", "REQUEST_MISMATCH", null, (s) => { s.request.node = "other"; }],
  ["request attempt binding", "REQUEST_MISMATCH", null, (s) => { s.request.attempt = 2; }],
  ["blocked sequence binding", "REQUEST_MISMATCH", null, (s) => { s.request.blockedSequence = 6; }],
];
for (const [name, reason, editCommand, editSnapshot] of failures) {
  test(`AC3: BLOCKED ${name} rejects without mutating frozen snapshot/receipt map`, () => {
    const current = editSnapshot ? changed(snapshot(), editSnapshot) : snapshot();
    const input = editCommand ? changed(command(), editCommand) : command();
    const { workstream, run, node } = input.scope;
    const receipts = readonlyReceipts([["unrelated", Object.freeze({ marker: "unchanged" })]]);
    const before = JSON.stringify({ current, receipts: [...receipts] });
    reject(admission(input, current, principal("alice", [{ workstream, run, node }]), receipts), reason);
    assert.equal(JSON.stringify({ current, receipts: [...receipts] }), before);
    assert.equal(Object.isFrozen(current.request ?? current), true);
  });
}

test("AC3: current authorized reply emits one scoped intent, consumes request and advances attempt only on commit", async () => {
  const current = snapshot();
  const before = JSON.stringify(current);
  const store = new MemoryStore(current);
  const decision = admission(command(), current);
  assert.equal(decision.receipt.outcome, "accepted");
  assert.equal(decision.intents.length, 1);
  assert.deepEqual(decision.intents[0], { id: "intent:command-1", commandId: "command-1", scope: current.scope,
    op: "node.reply", payload: { attempt: 1, requestId: "request-1", text: "Proceed" }, blockedSequence: 7, nextAttempt: 2 });
  assert.equal(store.snapshot.request.answered, false);
  assert.equal(JSON.stringify(current), before);
  assert.equal(Object.isFrozen(decision.commit.nextSnapshot.request), true);
  await store.compareAndCommit(decision.commit);
  assert.equal(store.snapshot.request.answered, true);
  assert.equal(store.snapshot.state, "running");
  assert.equal(store.snapshot.attempt, 2);
  assert.equal(store.snapshot.revision, 5);
  assert.equal(store.snapshot.blockedSequence, null);
  assert.doesNotMatch(JSON.stringify(decision), /node\.settled|parent\.awakened|finalized|delivered/);
});

for (const state of ["running", "blocked"]) {
  test(`AC4: ${state} cancel, pending coalescence, fake finalization and exact replay have one effect`, async () => {
    const store = new MemoryStore(snapshot(state));
    const adapter = adapterSpy(store);
    const first = command("node.cancel", "cancel-1", store.snapshot);
    const result = await submit(store, first, principal(), adapter);
    assert.equal(result.decision.receipt.outcome, "accepted");
    assert.equal(adapter.calls.length, 1);
    assert.equal(store.snapshot.state, state);
    const second = command("node.cancel", "cancel-2", store.snapshot);
    const coalesced = await submit(store, second, principal(), adapter);
    assert.equal(coalesced.decision.receipt.outcome, "coalesced");
    assert.equal(coalesced.decision.receipt.intentId, result.decision.receipt.intentId);
    assert.deepEqual(coalesced.decision.intents, []);
    store.finalizeCancel();
    for (const [input, receipt] of [[first, result.decision.receipt], [second, coalesced.decision.receipt]]) {
      const replay = await submit(store, input, principal(), adapter);
      assert.equal(replay.receipt, receipt);
      assert.deepEqual(replay.intents, []);
    }
    assert.equal(adapter.calls.length, 1);
    assert.equal(store.outbox.size, 1);
    const terminal = await submit(store, command("node.cancel", "cancel-3", store.snapshot), principal(), adapter);
    assert.equal(terminal.decision.receipt.outcome, "already-terminal");
    assert.equal(terminal.decision.receipt.intentId, null);
    assert.deepEqual(terminal.decision.intents, []);
    assert.equal(adapter.calls.length, 1);
  });
}

test("AC4: terminal without any cancellation is a no-effect receipt, never invented finalization", async () => {
  const store = new MemoryStore(snapshot("terminal"));
  const input = command("node.cancel", "terminal", store.snapshot);
  const decision = await commit(store, input);
  assert.equal(decision.receipt.outcome, "already-terminal");
  assert.equal(decision.receipt.intentId, null);
  assert.deepEqual(decision.intents, []);
  assert.equal(decision.commit.nextSnapshot.cancel, null);
  assert.equal(decision.commit.nextSnapshot.state, "terminal");
  assert.equal(admitCommand({ command: input, principal: principal(), ...store.read() }).receipt, decision.receipt);
  assert.doesNotMatch(JSON.stringify(decision), /node\.settled|parent\.awakened|finalized|delivered/);
});

test("AC4: cancel-first commit fences fresh reply with CANCEL_PENDING and defeats earlier reply admission", async () => {
  const store = new MemoryStore();
  const reply = admission(command()); // Invoked FIRST, but not committed.
  await commit(store, command("node.cancel", "cancel"));
  assert.deepEqual(await store.compareAndCommit(reply.commit), { committed: false, reason: "STALE_REVISION", intents: [] });
  reject(admitCommand({ command: command("node.reply", "fresh", store.snapshot), principal: principal(), ...store.read() }), "CANCEL_PENDING");
  assert.equal(store.snapshot.request.answered, false);
  assert.equal(store.snapshot.attempt, 1);
  assert.equal(store.outbox.size, 1);
});

test("AC4: reply-first consumes request/current attempt; old-revision cancel fails, current cancel succeeds", async () => {
  const store = new MemoryStore();
  const oldCancel = command("node.cancel", "cancel");
  const cancel = admission(oldCancel); // Invoked FIRST, commit loses.
  await commit(store, command());
  assert.deepEqual(await store.compareAndCommit(cancel.commit), { committed: false, reason: "STALE_REVISION", intents: [] });
  reject(admitCommand({ command: oldCancel, principal: principal(), ...store.read() }), "STALE_REVISION");
  const staleAttempt = { ...oldCancel, expectedRevision: store.snapshot.revision };
  reject(admitCommand({ command: staleAttempt, principal: principal(), ...store.read() }), "ATTEMPT_MISMATCH");
  assert.equal(store.snapshot.request.answered, true);
  assert.equal(store.snapshot.attempt, 2);
  reject(admitCommand({ command: command("node.reply", "reply-2", store.snapshot), principal: principal(), ...store.read() }), "NOT_BLOCKED");
  const currentCancel = await commit(store, command("node.cancel", "cancel-current", store.snapshot));
  assert.equal(currentCancel.intents[0].payload.attempt, 2);
  assert.equal(store.outbox.size, 2);
});

for (const [field, reason] of [["revision", "STALE_REVISION"], ["ownerEpoch", "OWNER_EPOCH_MISMATCH"]]) {
  test(`AC5: successful admission loses ${field} race at commit; no adapter before or after rejected commit`, async () => {
    const store = new MemoryStore();
    const adapter = adapterSpy(store);
    store.gate = { entered: deferred(), release: deferred() };
    const pending = submit(store, command(), principal(), adapter);
    await store.gate.entered.promise;
    assert.equal(store.commits, 0);
    assert.equal(adapter.calls.length, 0);
    store.snapshot = changed(store.snapshot, (state) => {
      if (field === "revision") state.revision += 1; else state.scope.ownerEpoch += 1;
    });
    const before = JSON.stringify(store.snapshot);
    store.gate.release.resolve();
    const result = await pending;
    assert.equal(result.decision.receipt.outcome, "accepted");
    assert.deepEqual(result.committed, { committed: false, reason, intents: [] });
    assert.equal(adapter.calls.length, 0);
    assert.equal(store.receipts.size, 0);
    assert.equal(store.outbox.size, 0);
    assert.equal(JSON.stringify(store.snapshot), before);
  });
}

test("AC5: adapter waits at the actual successful commit boundary", async () => {
  const store = new MemoryStore();
  const adapter = adapterSpy(store);
  store.gate = { entered: deferred(), release: deferred() };
  const pending = submit(store, command(), principal(), adapter);
  await store.gate.entered.promise;
  assert.equal(adapter.calls.length, 0);
  assert.equal(store.receipts.size, 0);
  assert.equal(store.outbox.size, 0);
  store.gate.release.resolve();
  const result = await pending;
  assert.equal(result.committed.committed, true);
  assert.equal(adapter.calls.length, 1);
  assert.equal(store.commits, 1);
});

test("AC5: concurrent duplicate and changed-ID proposals cannot commit twice, even when revision is unchanged", async () => {
  const store = new MemoryStore();
  const first = admission(command());
  const identical = admission(command());
  const conflict = admission(changed(command(), (c) => { c.payload.text = "Different"; }));
  const other = admission(command(), snapshot(), principal("bob"));
  await store.compareAndCommit(first.commit);
  // Deliberately hold revision equal: the ledger, not incidental stale revision, must stop bypass.
  store.snapshot = snapshot();
  for (const [decision, reason] of [[identical, "DUPLICATE_COMMIT"], [conflict, "COMMAND_ID_REUSE"], [other, "PRINCIPAL_MISMATCH"]]) {
    assert.deepEqual(await store.compareAndCommit(decision.commit), { committed: false, reason, intents: [] });
  }
  assert.equal(store.receipts.size, 1);
  assert.equal(store.outbox.size, 1);
});

test("AC2/AC5: retained ledger enforces replay independent of current snapshot revision", async () => {
  const store = new MemoryStore();
  const original = await commit(store, command());
  // Same authoritative read revision can occur in a separate read view. Dedup must stand alone.
  const replay = admission(command(), snapshot(), principal(), readonlyReceipts(store.receipts));
  assert.deepEqual(replay.intents, []);
  assert.equal(replay.commit, null);
  assert.equal(replay.receipt, original.receipt);
});

test("AC3/AC4: fresh cancel enforces scope, epoch, attempt and explicit capability in every state", () => {
  for (const state of ["running", "blocked", "terminal"]) {
    const current = snapshot(state);
    reject(admission(changed(command("node.cancel", "cancel", current), (c) => { c.payload.attempt += 1; }), current), "ATTEMPT_MISMATCH");
    reject(admission(changed(command("node.cancel", "cancel", current), (c) => { c.scope.ownerEpoch -= 1; }), current), "OWNER_EPOCH_MISMATCH");
    reject(admission(command("node.cancel", "cancel", current), changed(current, (s) => { s.capabilities = {}; })), "UNSUPPORTED_CAPABILITY");
  }
});

test("counter exhaustion rejects without unsafe revisions or attempts", () => {
  for (const op of ["node.reply", "node.cancel"]) {
    const current = changed(snapshot(), (s) => { s.revision = Number.MAX_SAFE_INTEGER; });
    reject(admission(command(op, "exhausted", current), current), "COUNTER_EXHAUSTED");
  }
  const current = changed(snapshot(), (s) => { s.attempt = Number.MAX_SAFE_INTEGER; s.request.attempt = s.attempt; });
  reject(admission(command("node.reply", "exhausted", current), current), "COUNTER_EXHAUSTED");
});
