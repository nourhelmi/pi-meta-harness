#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const STATIC_PREFIX = ["--bb-wrapper-static", "v1", "--config"];
const EXPECTED_NODE = "v24.18.0";
const EXPECTED_PI = "0.84.4";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const REASONING_LEVELS = new Set(["off", "low", "medium", "high", "xhigh", "max"]);
const REQUIRED_PUBLIC_TOOLS = new Set([
  "advisor_launch",
  "advisor_session_init",
  "advisor_graph_plan",
  "bg_run",
  "bg_watch",
  "bg_await",
  "bg_agent",
  "bg_output",
  "bg_list",
  "bg_stop",
]);
const EXPECTED_BB_DYNAMIC_TOOL = {
  description:
    "Move this bb thread to a different working directory for subsequent turns. Use this when the user asks to switch to a new checkout, worktree, or local directory. The path must be an absolute existing directory on the current host. The tool reuses this project's existing bb environment for that host/path, otherwise it creates an unmanaged environment after validating the path. Another project may hold its own environment for the same directory; that is allowed, except for a bb-managed worktree owned by another project, which this tool refuses. After a successful switch, stop the current turn because the running provider cwd will not change until the next turn.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      path: {
        description: "Absolute path to an existing directory on the current host.",
        type: "string",
      },
    },
    required: ["path"],
    type: "object",
  },
  name: "update_environment_directory",
  presentation: {
    icon: { glyph: "FolderOpen" },
    label: {
      completed: "Moved the thread directory",
      pending: "Moving the thread directory",
    },
  },
};
const IDENTITY_PREFIXES = [
  "HERDR_",
  "PI_INTERCOM_",
  "INTERCOM_",
  "SUBAGENT_",
  "ADVISOR_",
  "PI_DETACH_",
  "DETACH_",
  "ENGRAM_",
  "PI_ROUTINE",
  "ROUTINE",
  "ROUTINES_",
];
const IDENTITY_EXACT = new Set(["STABLE_INTERCOM_SESSION_ID", "CODEX_HOME", "TMUX_PANE", "TMUX"]);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const metaRoot = dirname(packageRoot);
const inherited = { ...process.env };

function reject(reason) {
  process.stderr.write(`bb-meta-pi-wrapper: ${reason}\n`);
  process.exit(64);
}

function contained(parent, child, allowEqual = false) {
  if (!isAbsolute(parent) || !isAbsolute(child)) return false;
  const rel = relative(resolve(parent), resolve(child));
  return (allowEqual && rel === "") || (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonical(candidate, kind = "any") {
  if (typeof candidate !== "string" || !isAbsolute(candidate) || !existsSync(candidate)) {
    reject("configured path is missing or not absolute");
  }
  const lexical = resolve(candidate);
  const real = realpathSync(lexical);
  if (real !== lexical) reject("configured paths must already be canonical");
  const metadata = statSync(real);
  if (kind === "file" && !metadata.isFile()) reject("configured file is not regular");
  if (kind === "directory" && !metadata.isDirectory()) reject("configured root is not a directory");
  return real;
}

function canonicalScratchFile(candidate, label) {
  if (
    typeof candidate !== "string" ||
    !isAbsolute(candidate) ||
    candidate.split(/[\\/]/u).includes("..") ||
    !existsSync(candidate)
  ) {
    reject(`${label} is missing, relative, or contains traversal`);
  }
  const lexical = resolve(candidate);
  const before = lstatSync(lexical);
  if (before.isSymbolicLink() || !before.isFile()) reject(`${label} is not a regular file`);
  const parent = realpathSync(dirname(lexical));
  const real = realpathSync(lexical);
  if (real !== join(parent, basename(lexical))) reject(`${label} escapes its real parent`);
  const after = statSync(real);
  if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile()) reject(`${label} changed during resolution`);
  return real;
}

function parseStaticConfig(encoded) {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/u.test(encoded)) reject("static wrapper config is not canonical base64url");
  let parsed;
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) reject("static wrapper config is not canonical base64url");
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    reject("static wrapper config is invalid");
  }
  const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).sort() : [];
  const expected = ["advisorStateRoot", "allowedRoots", "detachRoot", "detachStateRoot", "hostId", "piExecutable", "profileRoot", "sessionRoot", "skillRoots"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) reject("static wrapper config keys mismatch");
  if (!Array.isArray(parsed.allowedRoots) || parsed.allowedRoots.length === 0 || !parsed.allowedRoots.every((item) => typeof item === "string")) {
    reject("static wrapper allowedRoots must be a nonempty string array");
  }
  if (!Array.isArray(parsed.skillRoots) || !parsed.skillRoots.every((item) => typeof item === "string")) {
    reject("static wrapper skillRoots must be a string array");
  }
  if (typeof parsed.hostId !== "string" || !SAFE_ID.test(parsed.hostId)) reject("static wrapper hostId is invalid");
  return {
    advisorStateRoot: canonical(parsed.advisorStateRoot, "directory"),
    allowedRoots: parsed.allowedRoots.map((item) => canonical(item, "directory")),
    detachRoot: canonical(parsed.detachRoot, "directory"),
    detachStateRoot: canonical(parsed.detachStateRoot, "directory"),
    hostId: parsed.hostId,
    piExecutable: canonical(parsed.piExecutable, "file"),
    profileRoot: canonical(parsed.profileRoot, "directory"),
    sessionRoot: canonical(parsed.sessionRoot, "directory"),
    skillRoots: parsed.skillRoots.map((item) => canonical(item, "directory")),
  };
}

function readProfileJsonSnapshot(profile, name, maxBytes) {
  const source = canonical(join(profile, name), "file");
  let descriptor;
  try {
    descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size === 0 || before.size > maxBytes) reject(`${name} is empty or oversized`);
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || content.length !== after.size) {
      reject(`${name} changed while being staged`);
    }
    const parsed = JSON.parse(content.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) reject(`${name} must contain a JSON object`);
    return content;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") reject(`${name} must not be a symlink`);
    if (error instanceof SyntaxError) reject(`${name} contains invalid JSON`);
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") reject(`${name} is required in the curated profile`);
    reject(`${name} could not be staged safely`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function stageCatalogIdentity(profile, agentDir) {
  for (const [name, maxBytes] of [["auth.json", 1_048_576], ["models-store.json", 4_194_304]]) {
    try {
      writeFileSync(join(agentDir, name), readProfileJsonSnapshot(profile, name, maxBytes), { flag: "wx", mode: 0o600 });
    } catch {
      reject(`${name} could not be installed in the isolated catalog`);
    }
  }
}

function reservedSessionFile(root, candidate) {
  if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate.split(/[\\/]/u).includes("..")) {
    reject("session file must be an absolute contained path without traversal");
  }
  const lexical = resolve(candidate);
  if (!contained(root, lexical)) reject("session file is outside the configured session root");
  const parent = dirname(lexical);
  if (realpathSync(parent) !== parent || !contained(root, parent, true)) reject("session file parent is not canonical and contained");
  if (existsSync(lexical)) {
    const metadata = lstatSync(lexical);
    if (metadata.isSymbolicLink() || !metadata.isFile() || realpathSync(lexical) !== lexical) reject("session file is not a canonical regular file");
  }
  return lexical;
}

function scratchFile(scratchRoot, candidate, label) {
  const file = canonicalScratchFile(candidate, label);
  if (!contained(scratchRoot, file)) reject(`${label} is outside the provider scratch directory`);
  return file;
}

function validateThreadTail(args, scratchRoot, configuredSkillRoots) {
  let index = 8;
  for (const flag of ["--system-prompt", "--append-system-prompt"]) {
    if (args[index] !== flag) continue;
    args[index + 1] = scratchFile(scratchRoot, args[index + 1], flag);
    index += 2;
  }
  const skillRoots = [];
  while (args[index] === "--skill") {
    skillRoots.push(canonical(args[index + 1], "directory"));
    args[index + 1] = skillRoots.at(-1);
    index += 2;
  }
  if (new Set(skillRoots).size !== skillRoots.length || stableJson(skillRoots) !== stableJson(configuredSkillRoots)) {
    reject("normal Pi skills differ from the explicit BB skill-root allowlist");
  }
  let hasModel = false;
  if (args[index] === "--model") {
    const model = args[index + 1];
    if (typeof model !== "string" || !SAFE_MODEL.test(model)) reject("thread model is missing or invalid");
    hasModel = true;
    index += 2;
  }
  let hasReasoning = false;
  if (args[index] === "--thinking") {
    const reasoning = args[index + 1];
    if (typeof reasoning !== "string" || !REASONING_LEVELS.has(reasoning)) reject("thread reasoning is missing or unsupported");
    hasReasoning = true;
    index += 2;
  }
  if (hasModel !== hasReasoning) reject("thread model and reasoning must be supplied together");
  if (index !== args.length) reject("thread argv contains an unsupported or misordered option");
}

function validateDynamicTools(scratchRoot) {
  const toolsFile = inherited.PI_BB_TOOLS_FILE;
  if (toolsFile === undefined) reject("PI_BB_TOOLS_FILE is required for a thread child");
  const file = scratchFile(scratchRoot, toolsFile, "PI_BB_TOOLS_FILE");
  let tools;
  try { tools = JSON.parse(readFileSync(file, "utf8")); } catch { reject("PI_BB_TOOLS_FILE is invalid JSON"); }
  if (!Array.isArray(tools)) reject("PI_BB_TOOLS_FILE must contain an array");
  const names = tools.map((tool) => tool && typeof tool === "object" ? tool.name : undefined);
  if (!names.every((name) => typeof name === "string" && SAFE_ID.test(name))) reject("PI_BB_TOOLS_FILE contains an invalid tool");
  if (new Set(names).size !== names.length) reject("PI_BB_TOOLS_FILE contains duplicate tools");
  if (names.some((name) => REQUIRED_PUBLIC_TOOLS.has(name))) reject("a BB dynamic tool collides with a curated public tool");
  if (stableJson(tools) !== stableJson([EXPECTED_BB_DYNAMIC_TOOL])) {
    reject("BB dynamic tools differ from the single pinned relocation tool");
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function nonemptyDirectory(path) {
  return existsSync(path) && (!statSync(path).isDirectory() || readdirSync(path).length > 0);
}

function assertNoProjectExtensionDiscovery(cwd) {
  let current = cwd;
  for (;;) {
    if (existsSync(join(current, ".pi", "settings.json")) || nonemptyDirectory(join(current, ".pi", "extensions"))) {
      reject("project Pi extension discovery is forbidden in the curated profile");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function registeredToolNames(path) {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/registerTool\(\s*\{[\s\S]*?\bname:\s*"([^"]+)"/gu)].map((match) => match[1]);
}

function validateToolOwners(detachRoot) {
  const ownership = new Map([
    [join(metaRoot, "extensions", "advisor-session.ts"), ["advisor_launch", "advisor_session_init"]],
    [join(metaRoot, "extensions", "advisor-worker.ts"), []],
    [join(metaRoot, "extensions", "advisor-graph.ts"), ["advisor_graph_plan"]],
    [join(detachRoot, "src", "tools", "bg-run.ts"), ["bg_run"]],
    [join(detachRoot, "src", "tools", "bg-watch.ts"), ["bg_watch"]],
    [join(detachRoot, "src", "tools", "bg-await.ts"), ["bg_await"]],
    [join(detachRoot, "src", "tools", "bg-agent.ts"), ["bg_agent"]],
    [join(detachRoot, "src", "tools", "bg-output.ts"), ["bg_output"]],
    [join(detachRoot, "src", "tools", "bg-list.ts"), ["bg_list"]],
    [join(detachRoot, "src", "tools", "bg-stop.ts"), ["bg_stop"]],
  ]);
  const seen = [];
  for (const [path, expected] of ownership) {
    canonical(path, "file");
    const actual = registeredToolNames(path);
    if (JSON.stringify(actual.sort()) !== JSON.stringify([...expected].sort())) reject(`curated tool ownership mismatch in ${path}`);
    seen.push(...actual);
  }
  if (new Set(seen).size !== seen.length || seen.length !== 10) reject("duplicate or missing curated public tool");
}

function validateProfile(profile, detachRoot) {
  const settingsPath = canonical(join(profile, "settings.json"), "file");
  let settings;
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { reject("curated settings are invalid JSON"); }
  const expectedExtensions = [
    join(metaRoot, "extensions", "advisor-session.ts"),
    join(metaRoot, "extensions", "advisor-worker.ts"),
    join(metaRoot, "extensions", "advisor-graph.ts"),
    join(detachRoot, "extensions", "index.ts"),
  ].map((path) => canonical(path, "file"));
  if (
    !settings ||
    typeof settings !== "object" ||
    !Array.isArray(settings.packages) ||
    settings.packages.length !== 0 ||
    !Array.isArray(settings.extensions) ||
    JSON.stringify(settings.extensions) !== JSON.stringify(expectedExtensions)
  ) {
    reject("curated profile must contain exactly four pinned extensions and no packages");
  }
	const installedProfiles = canonical(join(profile, "bg-agent-profiles.json"), "file");
	const committedProfiles = canonical(join(packageRoot, "runtime", "pi-agent", "bg-agent-profiles.json"), "file");
	if (readFileSync(installedProfiles, "utf8") !== readFileSync(committedProfiles, "utf8")) {
	  reject("curated role profile differs from the committed profile");
	}
  if (nonemptyDirectory(join(profile, "extensions"))) reject("profile auto extensions are forbidden");
  validateToolOwners(detachRoot);
}

function resolvePi(executable) {
  executable = canonical(executable, "file");
  let current = dirname(executable);
  for (;;) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      let parsed;
      try { parsed = JSON.parse(readFileSync(manifest, "utf8")); } catch { reject("Pi package manifest is invalid"); }
      if (parsed.name === "@earendil-works/pi-coding-agent") {
        if (parsed.version !== EXPECTED_PI) reject(`Pi version ${String(parsed.version)} is not ${EXPECTED_PI}`);
        return executable;
      }
    }
    const parent = dirname(current);
    if (parent === current) reject(`could not locate Pi ${EXPECTED_PI} package`);
    current = parent;
  }
}

if (process.version !== EXPECTED_NODE) reject(`Node ${process.version} is not ${EXPECTED_NODE}`);
const received = process.argv.slice(2);
if (
  received.length < 4 ||
  received[0] !== STATIC_PREFIX[0] ||
  received[1] !== STATIC_PREFIX[1] ||
  received[2] !== STATIC_PREFIX[2]
) reject("static bridge prefix mismatch");
const config = parseStaticConfig(received[3]);
const args = received.slice(4);
// provider-pi performs this exact maintenance probe before it attempts model
// discovery.  Answer from the package manifest that resolvePi() has already
// pinned instead of starting a third, uncontained Pi process.
if (args.length === 1 && args[0] === "--version") {
  resolvePi(config.piExecutable);
  process.stdout.write(`${EXPECTED_PI}\n`);
  process.exit(0);
}
if (args[0] !== "--mode" || args[1] !== "rpc" || args.includes("--no-extensions")) reject("unsupported Pi argv");
const extensionIndexes = args.flatMap((value, index) => value === "--extension" ? [index] : []);
if (extensionIndexes.length !== 1) reject("exactly one explicit extension is required");
const extensionIndex = (extensionIndexes[0] ?? -1) + 1;
const extension = canonicalScratchFile(args[extensionIndex], "explicit extension");
args[extensionIndex] = extension;
const extensionDir = dirname(extension);
const providerTempRoot = dirname(extensionDir);
const providerTempRootMetadata = lstatSync(providerTempRoot);
const extensionDirMetadata = lstatSync(extensionDir);
const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
if (
  extension !== join(extensionDir, "bb-pi-extension.mjs") ||
  extensionDir !== join(providerTempRoot, "pi") ||
  !/^bb-provider-bridge-provider-pi-[A-Za-z0-9]{6}$/u.test(basename(providerTempRoot)) ||
  !contained(realpathSync(tmpdir()), providerTempRoot) ||
  realpathSync(providerTempRoot) !== providerTempRoot ||
  providerTempRootMetadata.isSymbolicLink() ||
  !providerTempRootMetadata.isDirectory() ||
  (providerTempRootMetadata.mode & 0o077) !== 0 ||
  extensionDirMetadata.isSymbolicLink() ||
  !extensionDirMetadata.isDirectory() ||
  (currentUid !== undefined && (providerTempRootMetadata.uid !== currentUid || extensionDirMetadata.uid !== currentUid))
) {
  reject(`explicit extension is not the provider-Pi bridge scratch artifact (${basename(providerTempRoot)}/${basename(extensionDir)})`);
}

let kind;
if (args.includes("--no-session")) {
  if (args.includes("--session")) reject("catalog and thread selectors are mutually exclusive");
  if (args.length !== 5 || args[2] !== "--no-session" || args[3] !== "--extension") reject("catalog argv shape mismatch");
  kind = "catalog";
} else if (args.includes("--session")) {
  if (args.length < 8 || args[2] !== "--session" || args[4] !== "--session-dir" || args[6] !== "--extension") reject("thread argv shape mismatch");
  kind = "thread";
} else {
  reject("missing session selector");
}

const callerCwd = canonical(process.cwd(), "directory");
if (kind === "thread" && !config.allowedRoots.some((root) => contained(root, callerCwd, true))) reject("cwd outside configured allowlist");
const piCli = resolvePi(config.piExecutable);

let childEnv;
let isolated;
let childCwd = callerCwd;
if (kind === "catalog") {
  isolated = mkdtempSync(join(tmpdir(), "bb-meta-catalog-"));
  const dirs = Object.fromEntries(["home", "agent", "tmp", "workspace", "xdg-config", "xdg-data", "xdg-cache", "xdg-state"].map((name) => [name, join(isolated, name)]));
  for (const path of Object.values(dirs)) mkdirSync(path, { recursive: true, mode: 0o700 });
  stageCatalogIdentity(config.profileRoot, dirs.agent);
  childCwd = dirs.workspace;
  childEnv = {
    PATH: inherited.PATH ?? "/usr/bin:/bin",
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    XDG_CONFIG_HOME: dirs["xdg-config"],
    XDG_DATA_HOME: dirs["xdg-data"],
    XDG_CACHE_HOME: dirs["xdg-cache"],
    XDG_STATE_HOME: dirs["xdg-state"],
    PI_CODING_AGENT_DIR: dirs.agent,
    PI_OFFLINE: "1",
    PI_BB_CATALOG_CANARY: "1",
  };
} else {
  const profile = config.profileRoot;
  const detachRoot = config.detachRoot;
  const advisorRoot = config.advisorStateRoot;
  const detachStateRoot = config.detachStateRoot;
  const hostId = config.hostId;
  const bbContext = ["BB_THREAD_ID", "BB_PROJECT_ID", "BB_ENVIRONMENT_ID", "BB_SERVER_URL"];
  if (!bbContext.every((name) => typeof inherited[name] === "string" && inherited[name].trim())) reject("full BB context is required for a thread child");
	for (const name of ["BB_THREAD_ID", "BB_PROJECT_ID", "BB_ENVIRONMENT_ID"]) {
	  if (!SAFE_ID.test(inherited[name])) reject(`${name} is invalid`);
	}
  let serverUrl;
  try { serverUrl = new URL(inherited.BB_SERVER_URL); } catch { reject("BB_SERVER_URL is invalid"); }
	if (serverUrl.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(serverUrl.hostname) || serverUrl.username || serverUrl.password || serverUrl.pathname !== "/" || serverUrl.search || serverUrl.hash) reject("BB_SERVER_URL must be a credential-free loopback origin");
  const sessionFile = reservedSessionFile(config.sessionRoot, args[3]);
  const sessionDir = canonical(args[5], "directory");
  if (sessionDir !== config.sessionRoot || !contained(sessionDir, sessionFile)) reject("session path outside configured session root");
  validateThreadTail(args, extensionDir, config.skillRoots);
  validateDynamicTools(extensionDir);
  assertNoProjectExtensionDiscovery(callerCwd);
  validateProfile(profile, detachRoot);

  const clean = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (
      value === undefined ||
      IDENTITY_EXACT.has(key) ||
      IDENTITY_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
	  key === "PI_BB_TOOLS_FILE" ||
	  key.startsWith("PI_META_") ||
	  (key.startsWith("BB_") && !bbContext.includes(key))
    ) continue;
    clean[key] = value;
  }
  const dirs = Object.fromEntries(["home", "tmp", "xdg-config", "xdg-data", "xdg-cache", "xdg-state"].map((name) => [name, join(profile, name)]));
  for (const path of Object.values(dirs)) mkdirSync(path, { recursive: true, mode: 0o700 });
  childEnv = {
    ...clean,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    XDG_CONFIG_HOME: dirs["xdg-config"],
    XDG_DATA_HOME: dirs["xdg-data"],
    XDG_CACHE_HOME: dirs["xdg-cache"],
    XDG_STATE_HOME: dirs["xdg-state"],
    PI_CODING_AGENT_DIR: profile,
    PI_DETACH_AGENT_PROFILES: join(profile, "bg-agent-profiles.json"),
    PI_DETACH_BB_HOST_ID: hostId,
    PI_DETACH_STATE_ROOT: detachStateRoot,
    ADVISOR_STATE_DIR: advisorRoot,
    ADVISOR_STATE_ROOT: advisorRoot,
  };
}

const finalArgs = kind === "catalog" ? [...args, "--no-extensions"] : args;
const child = spawn(process.execPath, [piCli, ...finalArgs], { cwd: childCwd, env: childEnv, stdio: [0, 1, 2, 3, 4] });
let forwarding = false;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    if (forwarding) return;
    forwarding = true;
    child.kill(signal);
  });
}
child.on("error", (error) => {
  if (isolated) rmSync(isolated, { recursive: true, force: true });
  process.stderr.write(`${error.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (isolated) rmSync(isolated, { recursive: true, force: true });
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
