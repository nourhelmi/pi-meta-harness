import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
  } catch {
    return undefined;
  }
}

const contract = await readJson("contract.json");
const settings = await readJson("settings.json");
assert(contract && settings, "contract and settings must be valid JSON");

assert.equal(settings.retryLimit, contract.retryLimit, "retry limit must match the local contract");
assert.deepEqual(Object.keys(settings), ["retryLimit"], "settings must remain bounded to retryLimit");
process.stdout.write("retry configuration verifier passed\n");
