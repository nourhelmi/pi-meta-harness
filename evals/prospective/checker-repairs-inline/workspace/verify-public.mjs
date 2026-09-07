import assert from "node:assert/strict";
import { listRecords } from "./records.mjs";

// A deliberately weak maker smoke test: no rejected requests or full pages.
assert.deepEqual(listRecords(
  { tenantId: "acme", userId: "owner" },
  { tenantId: "acme", ownerId: "owner" },
  ["first"],
), { status: 200, records: ["first"] });
console.log("maker smoke test passed");
