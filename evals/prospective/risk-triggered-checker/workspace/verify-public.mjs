import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canRead } from "./authorize.mjs";

let contract;
try {
  contract = JSON.parse(await readFile(new URL("contract.json", import.meta.url), "utf8"));
} catch {
  contract = undefined;
}
assert(contract, "contract must be valid JSON");

const request = { tenantId: "tenant-a", userId: "user-a" };
const resource = { tenantId: "tenant-a", ownerId: "user-a" };
assert.equal(canRead(request, resource), true);
assert.equal(canRead(request, { ...resource, tenantId: "tenant-b" }), false);
assert.equal(canRead(request, { ...resource, ownerId: "user-b" }), false);
for (const field of contract.requiredRequestFields) {
  const missing = { ...request };
  delete missing[field];
  assert.equal(canRead(missing, resource), false, `missing request ${field} must fail closed`);
  assert.equal(canRead({ ...request, [field]: "" }, resource), false, `empty request ${field} must fail closed`);
}
for (const field of contract.requiredResourceFields) {
  const missing = { ...resource };
  delete missing[field];
  assert.equal(canRead(request, missing), false, `missing resource ${field} must fail closed`);
  assert.equal(canRead(request, { ...resource, [field]: "" }), false, `empty resource ${field} must fail closed`);
}
assert.equal(canRead(null, resource), false);
process.stdout.write("authorization verifier passed\n");
