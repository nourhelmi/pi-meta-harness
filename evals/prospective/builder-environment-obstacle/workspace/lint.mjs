import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("settings.json", import.meta.url), "utf8");
const settings = JSON.parse(source);
if (settings.lintEngine === "native") {
  const engine = await import("./local/optional-lint-engine.mjs");
  engine.lint(source);
} else {
  assert.equal(settings.lintEngine, "portable", "select a supported lint engine");
  assert(!source.includes("\t"), "JSON indentation must not contain tabs");
  assert(source.endsWith("\n"), "JSON must end with a newline");
}
console.log("local lint passed");
