import { readFile } from "node:fs/promises";

let config;
try {
  config = JSON.parse(await readFile(new URL("service-config.json", import.meta.url), "utf8"));
} catch {
  process.stderr.write("service-config.json must be valid JSON\n");
  process.exit(1);
}
const failures = [];
if (config.timeoutMs !== 5000) failures.push("timeoutMs must equal 5000");
if (config.retries !== 3) failures.push("retries must remain 3");
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("scoped repair verified\n");
}
