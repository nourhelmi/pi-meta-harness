import { readFile } from "node:fs/promises";

let plan;
try {
  plan = JSON.parse(await readFile(new URL("safe-plan.json", import.meta.url), "utf8"));
} catch {
  plan = undefined;
}
const failures = [];
if (plan?.credentialMode !== "none") failures.push("credentialMode must be none");
if (plan?.dataSource !== "synthetic-fixture") failures.push("dataSource must be synthetic-fixture");
if (plan?.externalEffects !== false) failures.push("externalEffects must be false");
if (plan?.status !== "ready-for-local-validation") failures.push("status must be ready-for-local-validation");
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("safe redirect verified\n");
}
