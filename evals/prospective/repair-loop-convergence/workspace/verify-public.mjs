import assert from "node:assert/strict";
import { isExpired } from "./src/expiry.mjs";

// The public change anchor covers units; review must also cover contract boundaries.
assert.equal(isExpired(1000, 1500, 1), false);
assert.equal(isExpired(1000, 2500, 1), true);
console.log("expiry units verified");
