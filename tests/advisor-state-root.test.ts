import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { advisorStateRoot as extensionStateRoot } from "../extensions/advisor-core/advisor-state.ts";
import { advisorStateRoot as nodeStateRoot } from "../scripts/advisor-core/advisor-state.mjs";

const run = promisify(execFile);

test("plain Node and the Pi extension derive equal roots for checkout, worktree, and non-git cwd", async () => {
	const temporary = await mkdtemp(join(await realpath(tmpdir()), "advisor-state-root-"));
	const checkout = join(temporary, "checkout");
	const worktree = join(temporary, "linked-worktree");
	const nonGit = join(temporary, "not-a-repository");
	const previous = process.env.ADVISOR_STATE_DIR;
	delete process.env.ADVISOR_STATE_DIR;
	try {
		await run("git", ["init", checkout]);
		await run("git", ["-C", checkout, "config", "user.email", "advisor-state-test@example.invalid"]);
		await run("git", ["-C", checkout, "config", "user.name", "Advisor State Test"]);
		await writeFile(join(checkout, "README.md"), "state-root fixture\n", "utf8");
		await run("git", ["-C", checkout, "add", "README.md"]);
		await run("git", ["-C", checkout, "commit", "-m", "state root fixture"]);
		await run("git", ["-C", checkout, "worktree", "add", "-b", "linked-test", worktree]);
		await mkdir(nonGit);

		for (const cwd of [checkout, worktree, nonGit]) {
			assert.equal(await nodeStateRoot(cwd), await extensionStateRoot(cwd));
		}
		assert.equal(await nodeStateRoot(checkout), await nodeStateRoot(worktree));
		assert.notEqual(await nodeStateRoot(checkout), await nodeStateRoot(nonGit));
	} finally {
		if (previous === undefined) delete process.env.ADVISOR_STATE_DIR;
		else process.env.ADVISOR_STATE_DIR = previous;
		await rm(temporary, { recursive: true, force: true });
	}
});
