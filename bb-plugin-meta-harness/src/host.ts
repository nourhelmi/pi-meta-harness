import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostRpcContract, hostSignals } from "./contracts.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PRIVATE_ROLE_STATE_FILE = "private-role-state.json";

function configuredRoot(name: "advisor" | "detach"): string {
  return resolve(
    name === "advisor"
      ? process.env.PI_META_ADVISOR_STATE_ROOT ?? process.env.ADVISOR_STATE_ROOT ?? join(homedir(), ".advisor")
      : process.env.PI_META_DETACH_STATE_ROOT ?? process.env.PI_DETACH_STATE_ROOT ?? join(homedir(), ".pi", "detach"),
  );
}

function contained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function containsDotDot(path: string): boolean {
  return path.split(/[\\/]/u).includes("..");
}

export async function readContained(
  parent: string,
  target: string,
  maxBytes = 2_000_000,
  testHooks: { afterLstat?: () => void | Promise<void> } = {},
): Promise<string> {
  if (!isAbsolute(parent) || !isAbsolute(target) || containsDotDot(target)) {
    throw new Error("reserved paths must be absolute without dot-dot segments");
  }
  const resolvedParent = resolve(parent);
  const canonicalParent = await realpath(resolvedParent);
  if (canonicalParent !== resolvedParent) throw new Error("reserved root must already be canonical");
  const lexical = resolve(target);
  if (!contained(resolvedParent, lexical)) throw new Error("path escapes reserved root");

  const before = await lstat(lexical);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("reserved target must be a regular non-symlink file");
  }
  const canonicalTarget = await realpath(lexical);
  if (!contained(canonicalParent, canonicalTarget)) throw new Error("realpath escapes reserved root");
  await testHooks.afterLstat?.();

  const handle = await open(lexical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const current = await lstat(lexical);
	const currentCanonical = await realpath(lexical);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      current.dev !== opened.dev ||
	  current.ino !== opened.ino ||
	  currentCanonical !== canonicalTarget ||
	  !contained(canonicalParent, currentCanonical)
    ) {
      throw new Error("reserved target changed during open");
    }
    if (opened.size > maxBytes) throw new Error("reserved target exceeds size limit");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function canonicalWatchRoot(
	parent: string,
	target: string,
	testHooks: { afterLstat?: () => void | Promise<void> } = {},
): Promise<string> {
	if (!isAbsolute(parent) || !isAbsolute(target) || containsDotDot(target)) {
		throw new Error("watch roots must be absolute without dot-dot segments");
	}
	const resolvedParent = resolve(parent);
	const canonicalParent = await realpath(resolvedParent);
	if (canonicalParent !== resolvedParent) throw new Error("watch parent must already be canonical");
	const lexical = resolve(target);
	if (!contained(canonicalParent, lexical)) throw new Error("watch root escapes reserved root");
	const metadata = await lstat(lexical);
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("watch root must be a regular non-symlink directory");
	const canonicalTarget = await realpath(lexical);
	if (canonicalTarget !== lexical || !contained(canonicalParent, canonicalTarget)) throw new Error("watch realpath escapes reserved root");
	await testHooks.afterLstat?.();
	const current = await lstat(lexical);
	if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== metadata.dev || current.ino !== metadata.ino || await realpath(lexical) !== canonicalTarget) {
		throw new Error("watch root changed during validation");
	}
	return canonicalTarget;
}

function checkId(value: string): string {
  if (!SAFE_ID.test(value) || value.includes("..")) throw new Error("invalid reserved id");
  return value;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function privateRoleStateLocator(runId: string, resultPath: string): Promise<string> {
	const safe = checkId(runId);
	const advisorRoot = configuredRoot("advisor");
	const canonicalRoot = await realpath(advisorRoot);
	if (canonicalRoot !== advisorRoot || !isAbsolute(resultPath) || containsDotDot(resultPath)) {
		throw new Error("private role state root or result path is invalid");
	}
	const runDir = resolve(dirname(resultPath));
	if (!contained(canonicalRoot, runDir) || runDir.split(sep).at(-1) !== safe) {
		throw new Error("private role state run path is not reserved for this run");
	}
	if ((await realpath(runDir)) !== runDir) {
		throw new Error("private role state run path must be canonical");
	}
	return join(runDir, PRIVATE_ROLE_STATE_FILE);
}

async function validatePrivateRoleStateLocator(runId: string, locator: string): Promise<string> {
	if (dirname(locator).split(sep).at(-1) !== checkId(runId) || basename(locator) !== PRIVATE_ROLE_STATE_FILE) {
		throw new Error("private role state locator mismatch");
	}
	const expected = await privateRoleStateLocator(runId, join(dirname(locator), "result.md"));
	if (expected !== locator) throw new Error("private role state locator mismatch");
	return expected;
}

async function runState(runId: string): Promise<{ content: string; path: string; value: Record<string, unknown> }> {
  const safe = checkId(runId);
  const detachRoot = configuredRoot("detach");
  const path = join(detachRoot, "runs", safe, "state.json");
  const content = await readContained(detachRoot, path);
  const value = JSON.parse(content) as Record<string, unknown>;
  if (value.runId !== safe) throw new Error("run projection identity mismatch");
  return { content, path, value };
}

const runWatches = new Map<string, { dispose(): Promise<void> }>();

export default experimental_defineHostEntry({
  contract: hostRpcContract,
	experimental_signals: hostSignals,
  handlers: {
    async snapshotGraph({ graphId }) {
      const safe = checkId(graphId);
      const advisorRoot = configuredRoot("advisor");
      const path = join(advisorRoot, "graphs", `${safe}.json`);
      return { path, content: await readContained(advisorRoot, path) };
    },
    async snapshotRun({ runId }) {
      const state = await runState(runId);
      return { path: state.path, content: state.content };
    },
    async readReservedResult({ runId }) {
      const state = await runState(runId);
      const resultPath = state.value.resultPath;
      if (typeof resultPath !== "string" || !isAbsolute(resultPath)) {
        throw new Error("run has no absolute reserved result");
      }
      return {
        path: resultPath,
        content: await readContained(configuredRoot("advisor"), resultPath),
      };
    },
		async materializePrivateRoleState({ runId, resultPath, content, expectedSha256 }) {
			if (Buffer.byteLength(content, "utf8") > 65_536 || sha256(content) !== expectedSha256) {
				throw new Error("private role state content mismatch");
			}
			const locator = await privateRoleStateLocator(runId, resultPath);
			let created = false;
			let handle;
			try {
				handle = await open(
					locator,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					0o600,
				);
				created = true;
				const serialized = Buffer.from(content, "utf8");
				try {
					await handle.writeFile(serialized);
					await handle.sync();
				} finally {
					serialized.fill(0);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			} finally {
				await handle?.close();
			}
			const stored = await readContained(configuredRoot("advisor"), locator, 65_536);
			if (sha256(stored) !== expectedSha256 || stored !== content) {
				throw new Error(
					created
						? "private role state changed after materialization"
						: "private role state already exists with different content",
				);
			}
			return { locator };
		},
		async readPrivateRoleState({ runId, locator, expectedSha256 }) {
			const validated = await validatePrivateRoleStateLocator(runId, locator);
			const content = await readContained(configuredRoot("advisor"), validated, 65_536);
			if (sha256(content) !== expectedSha256) {
				throw new Error("private role state digest mismatch");
			}
			return { content };
		},
    async tailLog({ runId, maxBytes }) {
      const state = await runState(runId);
      const logPath = state.value.logPath;
      if (typeof logPath !== "string" || !isAbsolute(logPath)) {
        throw new Error("run has no absolute reserved log");
      }
      const content = await readContained(configuredRoot("detach"), logPath, 16_000_000);
      return { path: logPath, content: content.slice(-maxBytes) };
    },
	async watchRun({ runId }, context) {
	  const state = await runState(runId);
	  const root = await canonicalWatchRoot(configuredRoot("detach"), dirname(state.path));
	  if (!runWatches.has(runId)) {
		let subscription: { dispose(): Promise<void> } | undefined;
		subscription = await context.experimental_watch(
		  { rootPath: root, ignoredPaths: [], debounceMs: 75, maxWaitMs: 500 },
		  async () => {
			try {
			  await canonicalWatchRoot(configuredRoot("detach"), root);
			  await context.experimental_emitSignal("projectionChanged", { runId });
			} catch {
			  await subscription?.dispose();
			  runWatches.delete(runId);
			}
		  },
		);
		try {
		  await canonicalWatchRoot(configuredRoot("detach"), root);
		} catch (error) {
		  await subscription.dispose();
		  throw error;
		}
		runWatches.set(runId, subscription);
	  }
	  return { watching: true as const, root };
	},
  },
	async dispose() {
	  const pending = [...runWatches.values()].map((watch) => watch.dispose());
	  runWatches.clear();
	  await Promise.allSettled(pending);
	},
});
