import { readFile } from "node:fs/promises";

const lines = (await readFile(new URL("artifact.txt", import.meta.url), "utf8")).split(/\r?\n/).filter(Boolean);
let decision;
try {
  decision = JSON.parse(await readFile(new URL("criteria-revision.json", import.meta.url), "utf8"));
} catch {
  decision = undefined;
}
const count = (value) => lines.filter((line) => line === value).length;
const failures = [];
if (count("BASELINE") !== 1) failures.push("BASELINE must appear exactly once");
if (count("CURRENT_READY") !== 1) failures.push("CURRENT_READY must appear exactly once");
if (count("LEGACY_READY") !== 0) failures.push("LEGACY_READY must not appear");
if (decision?.from !== "LEGACY_READY" || decision?.to !== "CURRENT_READY") failures.push("criteria transition is missing");
if (decision?.rationale !== "The legacy integration was retired before implementation.") failures.push("revision rationale is missing");
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("criteria revision verified\n");
}
