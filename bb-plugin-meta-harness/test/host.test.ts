import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import hostEntry, { canonicalWatchRoot, readContained } from "../src/host.js";

const originalAdvisorRoot = process.env.ADVISOR_STATE_ROOT;
const originalDetachRoot = process.env.PI_DETACH_STATE_ROOT;

afterEach(() => {
  if (originalAdvisorRoot === undefined) delete process.env.ADVISOR_STATE_ROOT;
  else process.env.ADVISOR_STATE_ROOT = originalAdvisorRoot;
  if (originalDetachRoot === undefined) delete process.env.PI_DETACH_STATE_ROOT;
  else process.env.PI_DETACH_STATE_ROOT = originalDetachRoot;
});

async function canonicalTemp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

describe("host containment", () => {
  it("reconstructs a digest-validated private role after adapter restart", async () => {
    const advisorRoot = await canonicalTemp("host-private-role-");
    process.env.ADVISOR_STATE_ROOT = advisorRoot;
    const runId = "restart-run";
    const runDir = join(advisorRoot, "runs", runId);
    const resultPath = join(runDir, "result.md");
    await mkdir(runDir, { recursive: true });
    const content = JSON.stringify({ role: "builder", control: { generation: 2 } });
    const expectedSha256 = createHash("sha256").update(content).digest("hex");
    const materialized = await hostEntry.handlers.materializePrivateRoleState(
      { runId, resultPath, content, expectedSha256 },
      {} as never,
    );
    await expect(
      hostEntry.handlers.readPrivateRoleState(
        { runId, locator: materialized.locator, expectedSha256 },
        {} as never,
      ),
    ).resolves.toEqual({ content });
    await expect(
      hostEntry.handlers.readPrivateRoleState(
        { runId, locator: materialized.locator, expectedSha256: "0".repeat(64) },
        {} as never,
      ),
    ).rejects.toThrow(/digest mismatch/u);
  });
  it("allows a canonical reserved file and rejects arbitrary, dot-dot, alternate-root, and symlink paths", async () => {
    const root = await canonicalTemp("host-root-");
    const inside = join(root, "runs", "r", "state.json");
    await mkdir(join(root, "runs", "r"), { recursive: true });
    await writeFile(inside, "ok");
    expect(await readContained(root, inside)).toBe("ok");

    const outsideRoot = await canonicalTemp("host-out-");
    const outside = join(outsideRoot, "secret");
    await writeFile(outside, "bad");
    await symlink(outside, join(root, "link"));
    await expect(readContained(root, outside)).rejects.toThrow(/escapes/);
    await expect(readContained(root, `${root}/../${outsideRoot.split("/").at(-1)}/secret`)).rejects.toThrow(/dot-dot/);
    await expect(readContained(root, join(root, "link"))).rejects.toThrow(/symlink/);
    await expect(readContained(outsideRoot, inside)).rejects.toThrow(/escapes/);
    const rootAlias = join(outsideRoot, "root-alias");
    await symlink(root, rootAlias);
    await expect(readContained(rootAlias, inside)).rejects.toThrow(/canonical/);
  });

  it("rejects a target replaced between validation and open", async () => {
    const root = await canonicalTemp("host-race-");
    const target = join(root, "state.json");
    const original = join(root, "original.json");
    await writeFile(target, "first");
    await expect(readContained(root, target, 1024, {
      async afterLstat() {
        await rename(target, original);
        await writeFile(target, "second");
      },
    })).rejects.toThrow(/changed during open/);
  });

	it("rejects a parent-directory swap even when the replacement is a hard link to the validated inode", async () => {
	  const root = await canonicalTemp("host-parent-race-");
	  const directory = join(root, "reserved");
	  const moved = join(root, "reserved-original");
	  const outside = await canonicalTemp("host-parent-race-outside-");
	  const target = join(directory, "state.json");
	  await mkdir(directory);
	  await writeFile(target, "validated");
	  await expect(readContained(root, target, 1024, {
		async afterLstat() {
		  await rename(directory, moved);
		  await link(join(moved, "state.json"), join(outside, "state.json"));
		  await symlink(outside, directory);
		},
	  })).rejects.toThrow(/changed during open/);
	});

	it("allows only the exact canonical reserved run directory as a watch root", async () => {
	  const root = await canonicalTemp("host-watch-");
	  const run = join(root, "runs", "run-1");
	  await mkdir(run, { recursive: true });
	  expect(await canonicalWatchRoot(root, run)).toBe(run);
	  const outside = await canonicalTemp("host-watch-outside-");
	  await expect(canonicalWatchRoot(root, outside)).rejects.toThrow(/escapes/);
	  await expect(canonicalWatchRoot(root, `${root}/../${outside.split("/").at(-1)}`)).rejects.toThrow(/dot-dot/);
	  const alias = join(root, "watch-alias");
	  await symlink(run, alias);
	  await expect(canonicalWatchRoot(root, alias)).rejects.toThrow(/symlink/);
	  const raced = join(root, "runs", "race");
	  const original = join(root, "runs", "race-original");
	  await mkdir(raced);
	  await expect(canonicalWatchRoot(root, raced, {
		async afterLstat() {
		  await rename(raced, original);
		  await symlink(outside, raced);
		},
	  })).rejects.toThrow(/changed during validation/);
	});

  it("derives and reads only canonical graph, run, result, and log paths", async () => {
    const advisorRoot = await canonicalTemp("host-advisor-");
    const detachRoot = await canonicalTemp("host-detach-");
    process.env.ADVISOR_STATE_ROOT = advisorRoot;
    process.env.PI_DETACH_STATE_ROOT = detachRoot;
    await mkdir(join(advisorRoot, "graphs"), { recursive: true });
    await mkdir(join(advisorRoot, "runs", "worker"), { recursive: true });
    await mkdir(join(detachRoot, "runs", "run-1"), { recursive: true });
    const graphPath = join(advisorRoot, "graphs", "graph-1.json");
    const resultPath = join(advisorRoot, "runs", "worker", "result.md");
    const logPath = join(detachRoot, "runs", "run-1", "output.log");
    const statePath = join(detachRoot, "runs", "run-1", "state.json");
    await writeFile(graphPath, '{"graphId":"graph-1"}');
    await writeFile(resultPath, "terminal result");
    await writeFile(logPath, "old\nlatest\n");
    await writeFile(statePath, JSON.stringify({ runId: "run-1", resultPath, logPath }));

    await expect(hostEntry.handlers.snapshotGraph({ graphId: "graph-1" }, {} as never)).resolves.toEqual({ path: graphPath, content: '{"graphId":"graph-1"}' });
    await expect(hostEntry.handlers.snapshotRun({ runId: "run-1" }, {} as never)).resolves.toMatchObject({ path: statePath });
    await expect(hostEntry.handlers.readReservedResult({ runId: "run-1" }, {} as never)).resolves.toEqual({ path: resultPath, content: "terminal result" });
    await expect(hostEntry.handlers.tailLog({ runId: "run-1", maxBytes: 7 }, {} as never)).resolves.toEqual({ path: logPath, content: "latest\n" });
	let watchedRoot: string | undefined;
	let listener: (() => Promise<void>) | undefined;
	const lifecycle = new AbortController();
	const request = new AbortController();
	const emitted: unknown[] = [];
	const watchContext: Parameters<typeof hostEntry.handlers.watchRun>[1] = {
	  signal: request.signal,
	  lifecycle: { signal: lifecycle.signal },
	  experimental_paths: { dataDir: join(detachRoot, "data"), tempDir: join(detachRoot, "tmp") },
	  experimental_watch: async (options, callback) => {
		watchedRoot = options.rootPath;
		listener = async () => callback({ kind: "changed", changes: [] });
		return { async dispose() {} };
	  },
	  experimental_emitSignal: async (_name, payload) => { emitted.push(payload); },
	  experimental_retainWorker: () => ({ async dispose() {} }),
	};
	const watch = await hostEntry.handlers.watchRun({ runId: "run-1" }, watchContext);
	expect(watch).toEqual({ watching: true, root: join(detachRoot, "runs", "run-1") });
	expect(watchedRoot).toBe(join(detachRoot, "runs", "run-1"));
	await listener?.();
	expect(emitted).toEqual([{ runId: "run-1" }]);
	await hostEntry.dispose?.();

    const outsideRoot = await canonicalTemp("host-log-outside-");
    const outsideLog = join(outsideRoot, "output.log");
    await writeFile(outsideLog, "escaped");
    await writeFile(statePath, JSON.stringify({ runId: "run-1", resultPath, logPath: outsideLog }));
    await expect(hostEntry.handlers.tailLog({ runId: "run-1", maxBytes: 20 }, {} as never)).rejects.toThrow(/escapes/);
    await expect(hostEntry.handlers.snapshotRun({ runId: "../run-1" }, {} as never)).rejects.toThrow(/invalid reserved id/);
  });
});
