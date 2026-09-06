import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, validateCommand } from "../scripts/advisor-core/command-contract.mjs";

function command(op = "node.reply") {
  return { v: 1, commandId: "command-1", scope: { workstream: "work", run: "run", node: "node", ownerEpoch: 2 },
    op, expectedRevision: 4, payload: op === "node.reply"
      ? { attempt: 1, requestId: "request-1", text: "Proceed" } : { attempt: 1, reason: "Stop" } };
}
function reject(input, reason) {
  const result = validateCommand(input);
  assert.deepEqual(result, { ok: false, reason, intents: [] });
}

test("AC1: exactly reply and cancel v1 validate without effects or input aliasing", () => {
  for (const op of ["node.reply", "node.cancel"]) {
    const input = command(op);
    const result = validateCommand(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.command, input);
    assert.deepEqual(result.intents, []);
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    input.payload.attempt = 9;
    assert.equal(result.command.payload.attempt, 1);
    assert.equal(Object.isFrozen(result.command.payload), true);
  }
});

test("AC1: unknown versions and operations fail closed", () => {
  for (const v of [0, 2, -1, "1", null, true]) reject({ ...command(), v }, "UNSUPPORTED_VERSION");
  for (const op of ["node.launch", "node.resume", "workstream.create", "reply", "", null, {}]) {
    reject({ ...command(), op }, "UNSUPPORTED_OPERATION");
  }
});

test("AC1: missing fields and malformed envelope, scope and payload", () => {
  for (const input of [null, [], "{}", 1, true]) reject(input, "INVALID_SHAPE");
  for (const op of ["node.reply", "node.cancel"]) {
    for (const level of ["root", "scope", "payload"]) {
      const base = command(op);
      for (const key of Object.keys(level === "root" ? base : base[level])) {
        const input = command(op);
        delete (level === "root" ? input : input[level])[key];
        reject(input, "MISSING_FIELD");
      }
    }
    for (const field of ["scope", "payload"]) {
      for (const value of [null, [], false, 1, "bad"]) reject({ ...command(op), [field]: value }, "INVALID_SHAPE");
    }
  }
});

test("AC1: extra fields, including client identity and credentials, at every level", () => {
  for (const op of ["node.reply", "node.cancel"]) {
    for (const level of ["root", "scope", "payload"]) {
      for (const field of ["extra", "principal", "principalId", "identity", "owner", "token", "credentials", "authorization", "apiKey", "__proto__"]) {
        const input = command(op);
        Object.defineProperty(level === "root" ? input : input[level], field, { value: "untrusted", enumerable: true });
        reject(input, "EXTRA_FIELD");
      }
    }
    const input = command(op);
    input.payload[op === "node.reply" ? "reason" : "text"] = "wrong operation field";
    reject(input, "EXTRA_FIELD");
  }
});

test("AC1: every ID has the exact ASCII alphabet and 1..128 length", () => {
  const slots = ["commandId", "workstream", "run", "node", "requestId"];
  for (const slot of slots) {
    for (const value of ["", "a".repeat(129), "_bad", "-bad", "a/b", "a.b", "a b", "a\n", "é", null, 12]) {
      const input = command();
      const target = slot === "commandId" ? input : slot === "requestId" ? input.payload : input.scope;
      target[slot] = value;
      reject(input, "INVALID_ID");
    }
  }
  const input = command();
  input.commandId = "A" + "_-0z".repeat(31) + "abc";
  assert.equal(input.commandId.length, 128);
  assert.equal(validateCommand(input).ok, true);
});

test("AC1: integers are safe, noncoercing and bounded", () => {
  for (const slot of ["ownerEpoch", "expectedRevision", "attempt"]) {
    for (const value of [-1, 0.5, "1", null, true, Number.MAX_SAFE_INTEGER + 1, ...(slot === "expectedRevision" ? [] : [0])]) {
      const input = command();
      (slot === "ownerEpoch" ? input.scope : slot === "attempt" ? input.payload : input)[slot] = value;
      reject(input, "INVALID_INTEGER");
    }
  }
  const input = command();
  input.expectedRevision = 0;
  input.scope.ownerEpoch = Number.MAX_SAFE_INTEGER;
  input.payload.attempt = Number.MAX_SAFE_INTEGER;
  assert.equal(validateCommand(input).ok, true);
});

test("AC1: non-JSON values never get silently erased or coerced", () => {
  const cycle = {}; cycle.self = cycle;
  const sparse = []; sparse.length = 1;
  const accessor = Object.defineProperty({}, "text", { enumerable: true, get() { throw new Error("must not run"); } });
  const hidden = Object.defineProperty({}, "secret", { value: "hidden" });
  const symbolic = { [Symbol("secret")]: "hidden" };
  const arrayExtra = []; arrayExtra.secret = "hidden";
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol("x"), () => {}, new Date(), new Map(), new Set(),
    new String("text"), cycle, sparse, accessor, hidden, symbolic, arrayExtra, { toJSON() { return {}; } }]) {
    reject(value, "NON_JSON");
    const input = command(); input.payload.text = value;
    reject(input, "NON_JSON");
  }
  let calls = 0;
  const input = command();
  Object.defineProperty(input.payload, "text", { enumerable: true, get() { calls += 1; return "Proceed"; } });
  reject(input, "NON_JSON");
  assert.equal(calls, 0);
});

test("AC1: text and reason UTF-8 byte boundaries, not character counts", () => {
  for (const [op, field, limit] of [["node.reply", "text", 16384], ["node.cancel", "reason", 1024]]) {
    for (const value of [null, 1, false, [], {}, "", " \n\t "]) {
      const input = command(op); input.payload[field] = value;
      reject(input, "INVALID_TEXT");
    }
    for (const unit of ["a", "é", "🚀"]) {
      const input = command(op);
      input.payload[field] = unit.repeat(limit / Buffer.byteLength(unit));
      assert.equal(validateCommand(input).ok, true);
      input.payload[field] += "a";
      reject(input, "TEXT_TOO_LARGE");
    }
  }
});

test("AC1: whole-envelope 32 KiB boundary counts JSON escaping and metadata", () => {
  const input = command();
  input.payload.text = "";
  const overhead = Buffer.byteLength(canonicalJson(input));
  const available = 32768 - overhead;
  input.payload.text = "\u0001".repeat(Math.floor(available / 6)) + "x".repeat(available % 6);
  assert.equal(Buffer.byteLength(canonicalJson(input)), 32768);
  assert.ok(Buffer.byteLength(input.payload.text) < 16384);
  assert.equal(validateCommand(input).ok, true);
  input.payload.text += "x";
  reject(input, "ENVELOPE_TOO_LARGE");
});

test("AC2: semantic JSON sorts keys, preserves array order and exact text", () => {
  assert.equal(canonicalJson({ z: [1, { b: 2, a: 1 }], a: true }), canonicalJson({ a: true, z: [1, { a: 1, b: 2 }] }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  const input = command();
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  reordered.scope = Object.fromEntries(Object.entries(input.scope).reverse());
  reordered.payload = Object.fromEntries(Object.entries(input.payload).reverse());
  assert.equal(validateCommand(input).digest, validateCommand(reordered).digest);
  reordered.payload.text += " ";
  assert.notEqual(validateCommand(input).digest, validateCommand(reordered).digest);
});
