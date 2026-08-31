import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readJson(path) {
  try {
    return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  const [contract, runtime, plan] = await Promise.all([
    readJson("./contract.json"),
    readJson("./runtime-observation.json"),
    readJson("./deployment-plan.json"),
  ]);
  assert.equal(plan.owner, contract.owner);
  assert.equal(plan.apiVersion, contract.apiVersion);
  assert.equal(plan.region, runtime.region);
  assert.equal(plan.failover, runtime.failover);
  process.stdout.write("parallel evidence plan verified\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
