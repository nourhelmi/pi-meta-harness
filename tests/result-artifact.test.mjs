import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateResultArtifact } from "../scripts/advisor-core/result-artifact.mjs";

const cases = JSON.parse(await readFile(
  new URL("./fixtures/result-artifact-v2.json", import.meta.url),
  "utf8",
));

for (const fixture of cases) {
  test("script validator: " + fixture.name, () => {
    assert.deepEqual(validateResultArtifact(fixture.markdown), fixture.expected);
  });
}
