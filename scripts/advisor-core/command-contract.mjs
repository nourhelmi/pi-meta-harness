import { createHash } from "node:crypto";

export const COMMAND_LIMITS = Object.freeze({ envelope: 32 * 1024, text: 16 * 1024, reason: 1024 });
const encoder = new TextEncoder();
/** @param {unknown} value @returns {value is string} */
export const isCommandId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
/** @param {unknown} value @param {number} minimum */
const integer = (value, minimum) => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

class ContractError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
/** @param {string} reason @returns {never} */
function fail(reason) { throw new ContractError(reason); }

/** Semantic JSON, without invoking getters/toJSON or silently dropping values.
 * Object keys sort lexically; array order and string bytes remain significant.
 * The optional byte budget bounds the serialized envelope, including escaping.
 * @param {unknown} value
 */
export function canonicalJson(value, maxBytes = Infinity) {
  const active = new Set();
  /** @type {string[]} */
  const chunks = [];
  let bytes = 0;
  /** @param {string} text */
  function emit(text) {
    bytes += encoder.encode(text).length;
    if (bytes > maxBytes) fail("ENVELOPE_TOO_LARGE");
    chunks.push(text);
  }
  /** @param {unknown} item */
  function visit(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      emit(JSON.stringify(item));
      return;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("NON_JSON");
      emit(JSON.stringify(item));
      return;
    }
    if (typeof item !== "object" || active.has(item)) fail("NON_JSON");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail("NON_JSON");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    for (const key of keys) {
      if (typeof key !== "string") fail("NON_JSON");
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || (!descriptor.enumerable && !(array && key === "length"))) fail("NON_JSON");
    }
    active.add(item);
    if (array) {
      const length = descriptors.length.value;
      if (keys.length !== length + 1) fail("NON_JSON");
      emit("[");
      for (let i = 0; i < length; i += 1) {
        if (!Object.hasOwn(descriptors, i)) fail("NON_JSON");
        if (i) emit(",");
        visit(descriptors[i].value);
      }
      emit("]");
    } else {
      emit("{");
      Object.keys(descriptors).sort().forEach((key, index) => {
        if (index) emit(",");
        emit(JSON.stringify(key));
        emit(":");
        visit(descriptors[key].value);
      });
      emit("}");
    }
    active.delete(item);
  }
  visit(value);
  return chunks.join("");
}

/** @param {unknown} value @param {string[]} required */
function fields(value, required) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_SHAPE");
  if (Object.keys(value).some((key) => !required.includes(key))) fail("EXTRA_FIELD");
  if (required.some((key) => !Object.hasOwn(value, key))) fail("MISSING_FIELD");
}

/** @template T @param {T} value @returns {T} */
export function freezeData(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * @typedef {{workstream: string, run: string, node: string, ownerEpoch: number}} CommandScope
 * @typedef {{v: 1, commandId: string, scope: CommandScope, expectedRevision: number} & (
 * {op: 'node.reply', payload: {attempt: number, requestId: string, text: string}} |
 * {op: 'node.cancel', payload: {attempt: number, reason: string}})} Command
 */

/** Validate a decoded JSON envelope; never returns an effect intent.
 * Transport must also bound the original wire bytes before JSON parsing.
 * @param {unknown} input
 * @returns {{ok: true, command: Command, digest: string, intents: []} | {ok: false, reason: string, intents: []}}
 */
export function validateCommand(input) {
  try {
    const canonical = canonicalJson(input, COMMAND_LIMITS.envelope);
    const command = JSON.parse(canonical);
    fields(command, ["v", "commandId", "scope", "op", "expectedRevision", "payload"]);
    if (command.v !== 1) fail("UNSUPPORTED_VERSION");
    if (command.op !== "node.reply" && command.op !== "node.cancel") fail("UNSUPPORTED_OPERATION");
    fields(command.scope, ["workstream", "run", "node", "ownerEpoch"]);
    if (![command.commandId, command.scope.workstream, command.scope.run, command.scope.node].every(isCommandId)) fail("INVALID_ID");
    if (!integer(command.scope.ownerEpoch, 1) || !integer(command.expectedRevision, 0)) fail("INVALID_INTEGER");
    const reply = command.op === "node.reply";
    fields(command.payload, reply ? ["attempt", "requestId", "text"] : ["attempt", "reason"]);
    if (!integer(command.payload.attempt, 1)) fail("INVALID_INTEGER");
    if (reply && !isCommandId(command.payload.requestId)) fail("INVALID_ID");
    const field = reply ? "text" : "reason";
    const text = command.payload[field];
    if (typeof text !== "string" || !text.trim()) fail("INVALID_TEXT");
    if (encoder.encode(text).length > COMMAND_LIMITS[field]) fail("TEXT_TOO_LARGE");
    return freezeData({ ok: true, command, digest: createHash("sha256").update(canonical, "utf8").digest("hex"), intents: [] });
  } catch (error) {
    // Reject exotic JS inputs too; no coercion or serialization hooks become authority.
    return freezeData({ ok: false, reason: error instanceof ContractError ? error.reason : "NON_JSON", intents: [] });
  }
}
