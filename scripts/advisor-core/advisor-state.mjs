import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

async function repoAnchor(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    const info = await stat(dotGit).catch(() => undefined);
    if (info?.isDirectory()) return { commonDir: dotGit, worktreeRoot: dir };
    if (info?.isFile()) {
      const contents = await readFile(dotGit, "utf8");
      const pointer = contents.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
      if (pointer) {
        const gitDir = resolve(dir, pointer);
        const marker = gitDir.lastIndexOf("/.git/worktrees/");
        return {
          commonDir: marker >= 0 ? gitDir.slice(0, marker + "/.git".length) : gitDir,
          worktreeRoot: dir,
        };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function stateSlug(path) {
  const cleaned = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return `${cleaned || "dir"}-${hash}`;
}

export async function advisorStateRoot(cwd) {
  const override = process.env.ADVISOR_STATE_DIR;
  if (override) return resolve(override);
  const anchor = await repoAnchor(cwd);
  const key = anchor ? stateSlug(dirname(anchor.commonDir)) : stateSlug(resolve(cwd));
  return join(homedir(), ".advisor", key);
}
