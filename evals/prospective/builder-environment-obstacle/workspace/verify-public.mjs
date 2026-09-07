import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const settings = readJson("settings.json");
const contract = readJson("contract.json");
assert.equal(settings.retryLimit, contract.retryLimit);
assert(contract.lintEngines.includes(settings.lintEngine));
assert.deepEqual(Object.keys(settings).sort(), ["lintEngine", "retryLimit"]);
console.log("configuration verified");
