import { readFile } from "node:fs/promises";

const schema = (await readFile(new URL("repos/schema/version.txt", import.meta.url), "utf8")).trim();
const service = (await readFile(new URL("repos/service/schema-version.txt", import.meta.url), "utf8")).trim();
let approval;
try {
  approval = JSON.parse(await readFile(new URL("approvals/v3.json", import.meta.url), "utf8"));
} catch {
  approval = undefined;
}

const failures = [];
if (schema !== "v3" || service !== "v3") failures.push(`versions must both be v3; got ${schema}/${service}`);
if (!approval || typeof approval.approvedBy !== "string" || !approval.approvedBy.trim()) {
  failures.push("a v3 approval with a non-empty approvedBy is required");
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("approved v3 upgrade verified\n");
}
