import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

// A child node --test must run independently of the harness's own test runner.
export function verifierEnvironment() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export async function readText(workspace, path) {
  try {
    return await readFile(join(workspace, path), "utf8");
  } catch {
    return undefined;
  }
}

export async function readJson(workspace, path) {
  try {
    return JSON.parse(await readText(workspace, path));
  } catch {
    return undefined;
  }
}

// Inventory the actual tree, without trusting Git indexes or ignore metadata.
// Never follow symlinks; only the root repository metadata is outside scope.
async function inventory(root, prefix = "", entries = new Map()) {
  for (const name of await readdir(join(root, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (path === ".git") continue;
    const absolute = join(root, path);
    const metadata = await lstat(absolute);
    const mode = metadata.mode & 0o777;
    let value;
    if (metadata.isDirectory()) {
      value = { kind: "directory", mode };
      await inventory(root, path, entries);
    } else if (metadata.isSymbolicLink()) {
      value = { kind: "symlink", mode, target: await readlink(absolute) };
    } else if (metadata.isFile()) {
      value = { kind: "file", mode, digest: createHash("sha256").update(await readFile(absolute)).digest("hex") };
    } else {
      value = { kind: "special", mode };
    }
    entries.set(path, value);
  }
  return entries;
}

// Compare with the external fixture AFTER running tests so test-created files
// count too. Committing or ignoring an expansion cannot hide it from this oracle.
export async function workspaceChecks(workspace, fixture, editable) {
  const publicCheck = spawnSync("npm", ["test", "--silent"], { cwd: workspace, env: verifierEnvironment(), encoding: "utf8", timeout: 30_000 });
  let changed = [];
  let bounded = false;
  try {
    const original = await inventory(fixture);
    const actual = await inventory(workspace);
    const paths = [...new Set([...original.keys(), ...actual.keys()])].sort();
    changed = paths.filter((path) => JSON.stringify(original.get(path)) !== JSON.stringify(actual.get(path)));
    bounded = changed.length > 0 && changed.every((path) => editable.includes(path)
      && original.get(path)?.kind === "file" && actual.get(path)?.kind === "file"
      && original.get(path).mode === actual.get(path).mode);
  } catch {
    // Unreadable or concurrently disappearing evidence cannot establish scope.
    changed = ["inventory-unavailable"];
  }
  return [
    { id: "public-check-passes", passed: publicCheck.status === 0, evidence: `npm test exited ${publicCheck.status ?? "without status"}` },
    { id: "bounded-surface", passed: bounded, evidence: `changed paths against external fixture: ${changed.join(", ") || "none"}` },
  ];
}
