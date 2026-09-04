#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_NODE = "v24.18.0";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const metaRoot = dirname(packageRoot);
const detachRoot = "/Users/nour/Dev/pi-detach-worktrees/bb-adapter-poc";
const defaultAdvisorRoot = "/Users/nour/.advisor/pi-meta-harness-0c8d98ab";
const defaultDetachStateRoot = join(homedir(), ".pi", "detach");
const defaultProfileRoot = join(homedir(), ".bb", "meta-harness-pi");
const providerSessionRoot = join(homedir(), ".bb", "pi-bridge-sessions");

function fail(message) {
  throw new Error(`bb-meta setup: ${message}`);
}

function parseArgs(argv) {
  const values = { allowRoots: [], skillRoots: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail("arguments must be flag/value pairs");
    if (flag === "--allow-root") values.allowRoots.push(value);
    else if (flag === "--bb-skill-root") values.skillRoots.push(value);
    else if (flag === "--host-id") values.hostId = value;
    else if (flag === "--profile-root") values.profileRoot = value;
    else if (flag === "--advisor-state-root") values.advisorStateRoot = value;
    else if (flag === "--detach-state-root") values.detachStateRoot = value;
    else fail(`unsupported argument ${flag}`);
  }
  return values;
}

function canonicalDirectory(candidate, create = false) {
  if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.split(/[\\/]/u).includes("..")) fail(`unsafe directory ${String(candidate)}`);
  const lexical = resolve(candidate);
  if (create) mkdirSync(lexical, { recursive: true, mode: 0o700 });
  if (!existsSync(lexical) || !lstatSync(lexical).isDirectory() || lstatSync(lexical).isSymbolicLink()) fail(`directory is missing or not a real directory: ${lexical}`);
  const real = realpathSync(lexical);
  if (real !== lexical) fail(`directory is not canonical: ${lexical}`);
  return real;
}

function atomicInstall(source, target) {
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) fail(`refusing symlink target ${target}`);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, readFileSync(source), { flag: "wx", mode: 0o600 });
  renameSync(temporary, target);
}

function pinnedPiExecutable() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "pi");
    if (!existsSync(candidate)) continue;
    const executable = realpathSync(candidate);
    if (!lstatSync(executable).isFile()) continue;
    let current = dirname(executable);
    for (;;) {
      const manifest = join(current, "package.json");
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        if (parsed.name === "@earendil-works/pi-coding-agent") {
          if (parsed.version !== "0.84.4") fail(`Pi ${String(parsed.version)} is not 0.84.4`);
          return executable;
        }
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  fail("Pi 0.84.4 is not available on setup PATH");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

if (process.version !== EXPECTED_NODE) fail(`requires ${EXPECTED_NODE}; got ${process.version}`);
const args = parseArgs(process.argv.slice(2));
if (typeof args.hostId !== "string" || !SAFE_ID.test(args.hostId)) fail("--host-id is required and must be a BB host ID");

const profileRoot = canonicalDirectory(args.profileRoot ?? defaultProfileRoot, true);
const sessionRoot = canonicalDirectory(providerSessionRoot, true);
const advisorStateRoot = canonicalDirectory(args.advisorStateRoot ?? defaultAdvisorRoot, true);
const detachStateRoot = canonicalDirectory(args.detachStateRoot ?? defaultDetachStateRoot, true);
const allowedRoots = (args.allowRoots.length ? args.allowRoots : [metaRoot, detachRoot]).map((path) => canonicalDirectory(path));
const skillRoots = args.skillRoots.map((path) => canonicalDirectory(path));
const piExecutable = pinnedPiExecutable();
canonicalDirectory(detachRoot);

atomicInstall(join(packageRoot, "runtime", "pi-agent", "settings.json"), join(profileRoot, "settings.json"));
atomicInstall(join(packageRoot, "runtime", "pi-agent", "bg-agent-profiles.json"), join(profileRoot, "bg-agent-profiles.json"));

const config = Buffer.from(JSON.stringify({
  advisorStateRoot,
  allowedRoots,
  detachRoot,
  detachStateRoot,
  hostId: args.hostId,
  piExecutable,
  profileRoot,
  sessionRoot,
  skillRoots,
})).toString("base64url");
const wrapper = realpathSync(join(packageRoot, "src", "catalog-wrapper.mjs"));
const bridgeArgs = JSON.stringify(["--bb-wrapper-static", "v1", "--config", config]);

for (const [name, value] of [
  ["BB_PI_BRIDGE_COMMAND", wrapper],
  ["BB_PI_BRIDGE_ARGS", bridgeArgs],
  ["PI_META_ADVISOR_STATE_ROOT", advisorStateRoot],
  ["PI_META_DETACH_STATE_ROOT", detachStateRoot],
  ["PI_META_HOST_ID", args.hostId],
]) {
  process.stdout.write(`export ${name}=${shellQuote(value)}\n`);
}
if (!existsSync(join(profileRoot, "auth.json"))) {
  process.stderr.write(`bb-meta setup: ${join(profileRoot, "auth.json")} is absent; seed Pi auth there with mode 0600 before a live model turn.\n`);
}
