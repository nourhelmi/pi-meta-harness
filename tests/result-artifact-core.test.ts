import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateResultArtifact } from "../extensions/advisor-core/result-artifact.ts";

interface Fixture {
	name: string;
	markdown: string;
	expected: ReturnType<typeof validateResultArtifact>;
}

const cases = JSON.parse(await readFile(
	new URL("./fixtures/result-artifact-v2.json", import.meta.url),
	"utf8",
)) as Fixture[];

for (const fixture of cases) {
	test("extension validator: " + fixture.name, () => {
		assert.deepEqual(validateResultArtifact(fixture.markdown), fixture.expected);
	});
}
