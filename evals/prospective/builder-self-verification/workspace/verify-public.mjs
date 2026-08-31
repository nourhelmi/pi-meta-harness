import { readFile } from "node:fs/promises";

const artifact = await readFile(new URL("artifact.txt", import.meta.url), "utf8");
const lines = artifact.split(/\r?\n/).filter(Boolean);

const count = (value) => lines.filter((line) => line === value).length;
const failures = [];
if (count("BASELINE") !== 1) failures.push("BASELINE must appear exactly once");
if (count("ADVISOR_READY") !== 1) failures.push("ADVISOR_READY must appear exactly once");
if (lines.some((line) => !["BASELINE", "ADVISOR_READY"].includes(line))) {
  failures.push("artifact.txt contains an unsupported line");
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("artifact verifier passed\n");
}
