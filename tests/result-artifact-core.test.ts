import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resultDeviations, validateResultArtifact } from "../extensions/advisor-core/result-artifact.ts";

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

test("extension deviations: absent or empty heading returns no summaries", () => {
	for (const markdown of ["", "# Status\nPASS", "Deviations\n- Not a heading", "## Deviations\n", "## Deviations\n\n## Files\n- Outside", "## Deviations\n-\n*\n+"]) {
		assert.deepEqual(resultDeviations(markdown), []);
	}
});

test("extension deviations: first lines are trimmed, bounded and section-scoped", () => {
	const markdown = [
		"# Status", "PASS", "## Deviations", "",
		"  - Switched Node locally.   ", "    Details are not another item.",
		"* Used the installed tool.  ", "", "  Resolved a path mismatch.  ", "Paragraph continuation.", "",
		"### Tooling", "+ Used a local fixture.", "1. Retried locally.", "2) Kept going.",
		`- ${"x".repeat(220)}  `, "- Last retained item.", "- Ninth omitted.",
		"## Evidence", "- Outside the section.",
	].join("\r\n");
	assert.deepEqual(resultDeviations(markdown), [
		"Switched Node locally.", "Used the installed tool.", "Resolved a path mismatch.",
		"Used a local fixture.", "Retried locally.", "Kept going.", "x".repeat(200), "Last retained item.",
	]);
	assert.deepEqual(validateResultArtifact(markdown), validateResultArtifact("# Status\nPASS\n## Evidence\n- Outside the section."));
	for (let level = 1; level <= 6; level += 1) {
		assert.deepEqual(resultDeviations(`${"#".repeat(level)} dEvIaTiOnS ###\n\n Paragraph. \nwrapped\n\n- Bullet.\n# Files\nOutside`), ["Paragraph.", "Bullet."]);
	}
});
