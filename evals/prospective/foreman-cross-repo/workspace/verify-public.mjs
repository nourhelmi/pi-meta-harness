import { readFile } from "node:fs/promises";

const schema = (await readFile(new URL("repos/schema/version.txt", import.meta.url), "utf8")).trim();
const service = (await readFile(new URL("repos/service/schema-version.txt", import.meta.url), "utf8")).trim();
let plan;
try { plan = JSON.parse(await readFile(new URL("delivery-plan.json", import.meta.url), "utf8")); } catch { plan = undefined; }
const failures = [];
if (schema !== "v2" || service !== "v2") failures.push(`versions must both be v2; got ${schema}/${service}`);
if (JSON.stringify(plan?.order) !== JSON.stringify(["schema", "service"])) failures.push("delivery order must be schema then service");
if (plan?.externalEffects !== false) failures.push("externalEffects must be false");
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("cross-repository contract verified\n");
}
