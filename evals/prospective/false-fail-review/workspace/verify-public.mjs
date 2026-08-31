import { readFile } from "node:fs/promises";

const artifact = await readFile(new URL("artifact.md", import.meta.url), "utf8");
const required = ["## Scope", "## Verification", "## Rollback"];
const failures = required.filter((heading) => artifact.split(heading).length - 1 !== 1);
if (failures.length) {
  process.stderr.write(`missing or duplicated headings: ${failures.join(", ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("complete artifact verified\n");
}
