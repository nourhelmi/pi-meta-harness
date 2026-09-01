#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeSelectionStatus,
  DEFAULT_PROFILE,
  intelligenceGuideErrors,
  listProfileNames,
  liveGuidePath,
  materializeProfile,
  profileDir,
  readActivePointer,
  readJson as readProfileJson,
  roleConfigErrors,
} from "./intelligence-profile.mjs";
import { skillDestination, validatedSkillNames } from "./skill-path-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_TARGET = resolve(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
);
const LIVE_HERDR_TARGET = resolve(
  process.env.HERDR_CONFIG_PATH
    ? dirname(expandHome(process.env.HERDR_CONFIG_PATH))
    : join(homedir(), ".config", "herdr"),
);
const BACKUP_ROOT = join("backups", "pi-meta-harness");
const HERDR_BACKUP_ROOT = join("backups", "pi-meta-harness-herdr");
const SKILL_BACKUP_ROOT = join("backups", "pi-meta-harness-skills");
const STATE_FILE = ".pi-meta-harness-state.json";
const GIT_PIN_FETCH_TIMEOUT_MS = 20_000;
const RUNTIME_SETTING_KEYS = new Set([
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
]);
const GENERATED_SKILL_FILES = new Map([
  ["pretty-mermaid", new Set(["package-lock.json"])],
]);

const COPY_ENTRIES = [
  ["extensions/advisor-graph.ts", "extensions/advisor-graph.ts"],
  ["extensions/advisor-session.ts", "extensions/advisor-session.ts"],
  ["extensions/advisor-worker.ts", "extensions/advisor-worker.ts"],
  ["extensions/claude-schema-compat.ts", "extensions/claude-schema-compat.ts"],
  ["extensions/unified-edit.ts", "extensions/unified-edit.ts"],
  ["extensions/unified-edit-fallback/upstream.ts", "extensions/unified-edit-fallback/upstream.ts"],
  ["skills/advisor", "skills/advisor"],
  ["skills/advisor-native", "skills/advisor-native"],
  ["skills/advisor-pi", "skills/advisor-pi"],
  ["skills/advisor-triage", "skills/advisor-triage"],
  ["skills/advisor-worker", "skills/advisor-worker"],
  ["skills/graph-driver", "skills/graph-driver"],
  ["config/ui-pack.config.json", "ui-pack.config.json"],
  ["config/bg-agent-profiles.json", "bg-agent-profiles.json"],
  ["config/intelligence-profiles/codex-max.json", "intelligence-profiles/codex-max.json"],
  ["config/intelligence-profiles/codex-lean.json", "intelligence-profiles/codex-lean.json"],
  ["config/intelligence-profiles/anthropic-heavy.json", "intelligence-profiles/anthropic-heavy.json"],
  ["config/intelligence-profiles/balanced.json", "intelligence-profiles/balanced.json"],
  ["config/intelligence-profiles/grok-cycle.json", "intelligence-profiles/grok-cycle.json"],
  ["scripts/intelligence-profile.mjs", "bin/intelligence-profile.mjs"],
  ["skills/switch-intelligence-profile", "skills/switch-intelligence-profile"],
  ["config/claude-bridge.json", "claude-bridge.json"],
  ["config/markdown-workflows.json", "markdown-workflows.json"],
];
const MERGE_ENTRIES = [
  ["config/settings.overlay.json", "settings.json", "settings"],
  ["config/mcp.json", "mcp.json", "object"],
];
const HERDR_COPY_ENTRIES = [
  ["herdr/config.toml", "config.toml"],
  ["herdr/sounds", "sounds"],
];
const FORBIDDEN_REPOSITORY_NAMES = new Set([
  "auth.json",
  "trust.json",
  "mcp-cache.json",
  "models-store.json",
  "run-history.jsonl",
]);
const FORBIDDEN_REPOSITORY_PREFIXES = [
  ".advisor/",
  ".pi/",
  "backups/",
  "intercom/",
  "sessions/",
];
const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  /NRAK-[A-Za-z0-9]{20,}/,
  /ctx7sk-[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/,
];

function usage() {
  console.log(`Pi Meta Harness

Usage:
  node scripts/meta-harness.mjs plan [--target <dir> | --live]
  node scripts/meta-harness.mjs install [--target <dir> | --live] [--allow-active]
  node scripts/meta-harness.mjs doctor [--target <dir> | --live]
  node scripts/meta-harness.mjs restore --backup <dir> [--target <dir> | --live] [--allow-active]
  node scripts/meta-harness.mjs install-herdr-config [--target <dir> | --live] [--allow-active]
  node scripts/meta-harness.mjs restore-herdr --backup <dir> [--target <dir> | --live] [--allow-active]
  node scripts/meta-harness.mjs skills-plan
  node scripts/meta-harness.mjs install-skills --live [--allow-active]
  node scripts/meta-harness.mjs install-herdr-integration --live [--allow-active]
  node scripts/meta-harness.mjs verify-git-pins

A real Pi target always requires --live. The installer never reloads Pi.`);
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = { command, live: false, allowActive: false };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--live") options.live = true;
    else if (value === "--allow-active") options.allowActive = true;
    else if (value === "--target") options.target = rest[++index];
    else if (value === "--backup") options.backup = rest[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (options.live && options.target) throw new Error("Choose either --live or --target");
  return options;
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`)) return join(homedir(), value.slice(2));
  return value;
}

function isWithin(directory, candidate) {
  const delta = relative(directory, candidate);
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

async function assertPhysicalParentWithin(root, candidate, label) {
  const rootPhysical = await realpath(root);
  let ancestor = dirname(candidate);
  while (!(await exists(ancestor))) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`${label} has no existing parent inside its root`);
    ancestor = parent;
  }
  const ancestorPhysical = await realpath(ancestor);
  if (!isWithin(rootPhysical, ancestorPhysical)) {
    throw new Error(`${label} follows a parent symlink outside its root`);
  }
}

function targetFor(options) {
  const target = options.live
    ? LIVE_TARGET
    : resolve(expandHome(options.target ?? join(ROOT, ".tmp", "preview-agent")));
  if (target === LIVE_TARGET && !options.live) {
    throw new Error("The live Pi target requires the explicit --live flag");
  }
  return target;
}

function herdrTargetFor(options) {
  const target = options.live
    ? LIVE_HERDR_TARGET
    : resolve(expandHome(options.target ?? join(ROOT, ".tmp", "preview-herdr")));
  if (target === LIVE_HERDR_TARGET && !options.live) {
    throw new Error("The live Herdr target requires the explicit --live flag");
  }
  return target;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path, fallback) {
  if (!(await exists(path))) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`Invalid JSON: ${path}`, { cause });
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, overlay) {
  if (!isObject(base) || !isObject(overlay)) return structuredClone(overlay);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = isObject(value) && isObject(result[key])
      ? deepMerge(result[key], value)
      : structuredClone(value);
  }
  return result;
}

function packageSource(entry) {
  return typeof entry === "string" ? entry : entry?.source;
}

function packageSourceIsApproved(source) {
  if (typeof source !== "string") return false;
  if (source.startsWith("npm:")) {
    return /^npm:(?:@[^/]+\/[^@]+|[^@]+)@\^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(source);
  }
  if (source.startsWith("git:")) return /@[0-9a-f]{40}$/.test(source);
  return false;
}

function packageIdentity(entry) {
  const source = packageSource(entry) ?? "";
  if (source === "packages/pi-detach" || /github\.com[/:]nourhelmi\/pi-detach(?:@|$)/.test(source)) {
    return "first-party:pi-detach";
  }
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    if (spec.startsWith("@")) {
      const slash = spec.indexOf("/");
      const version = spec.indexOf("@", slash + 1);
      return `npm:${version === -1 ? spec : spec.slice(0, version)}`;
    }
    return `npm:${spec.split("@")[0]}`;
  }
  if (source.startsWith("git:") || /^[a-z]+:\/\//.test(source)) {
    return source.replace(/@[A-Za-z0-9._/-]+$/, "");
  }
  return `local:${source}`;
}

function union(overlay = [], base = []) {
  return [...new Set([...overlay, ...base])];
}

function mergeSettings(base, overlay, removedPackageSources = [], removedModels = []) {
  const merged = deepMerge(base, overlay);
  for (const key of RUNTIME_SETTING_KEYS) {
    if (base[key] !== undefined) merged[key] = structuredClone(base[key]);
  }
  const overlayPackages = overlay.packages ?? [];
  const overlayIds = new Set(overlayPackages.map(packageIdentity));
  const removedIds = new Set(removedPackageSources.map(packageIdentity));
  merged.packages = [
    ...overlayPackages,
    ...(base.packages ?? []).filter((entry) => {
      const identity = packageIdentity(entry);
      return !overlayIds.has(identity) && !removedIds.has(identity);
    }),
  ];
  merged.skills = union(overlay.skills, base.skills);
  const removedModelIds = new Set(removedModels);
  merged.enabledModels = union(overlay.enabledModels, base.enabledModels)
    .filter((model) => !removedModelIds.has(model));
  return merged;
}

async function copyReplacing(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (candidate) => {
      const parts = relative(source, candidate).split(sep);
      return !parts.includes(".git") && !parts.includes("node_modules");
    },
  });
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function managedDestinations() {
  return [
    ...COPY_ENTRIES.map(([, destination]) => destination),
    ...MERGE_ENTRIES.map(([, destination]) => destination),
    "advisor-intelligence.json",
    "intelligence-profiles/ACTIVE",
    STATE_FILE,
  ];
}

async function createScopedBackup(target, destinations, backupRoot) {
  const backup = join(target, backupRoot, timestamp());
  const filesRoot = join(backup, "files");
  const entries = [];
  await mkdir(filesRoot, { recursive: true });
  for (const destination of destinations) {
    const livePath = join(target, destination);
    const wasPresent = await exists(livePath);
    entries.push({ destination, wasPresent });
    if (wasPresent) await cp(livePath, join(filesRoot, destination), { recursive: true });
  }
  await atomicJson(join(backup, "manifest.json"), {
    schemaVersion: 1,
    target,
    createdAt: new Date().toISOString(),
    entries,
  });
  return backup;
}

async function createBackup(target) {
  return createScopedBackup(target, managedDestinations(), BACKUP_ROOT);
}

function activeAdvisorProcesses() {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .filter((line) => line.includes("pi ") || line.includes("/pi"))
    .filter((line) => /advisor-worker-role|advisor-/.test(line))
    .filter((line) => !line.includes(String(process.pid)));
}

function assertLiveSafety(options) {
  if (!options.live || options.allowActive) return;
  const active = activeAdvisorProcesses();
  if (active.length) {
    throw new Error(
      `Active advisor or worker processes were detected. Stop them before live install, or inspect and use --allow-active explicitly.\n${active.join("\n")}`,
    );
  }
}

async function sourceProfileNames() {
  const entries = await readdir(join(ROOT, "config", "intelligence-profiles"));
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
}

function activeSelectionRepairMessage(target) {
  const switcher = join(target, "bin", "intelligence-profile.mjs");
  return `Repair explicitly with: node ${JSON.stringify(switcher)} <profile> --target ${JSON.stringify(target)}`;
}

async function installProfileSelection(target) {
  const pointer = await readActivePointer(target);
  const livePresent = await exists(liveGuidePath(target));
  const statePresent = await exists(join(target, STATE_FILE));
  const namedProfilesPresent = await exists(profileDir(target));
  const existingRoleConfig = await readJson(join(target, "bg-agent-profiles.json"), undefined);
  const legacyMixedConfig = isObject(existingRoleConfig?.models);

  if (
    pointer.status === "missing" &&
    !livePresent &&
    !statePresent &&
    !namedProfilesPresent &&
    !legacyMixedConfig
  ) {
    return { name: DEFAULT_PROFILE, mode: "clean" };
  }

  if (legacyMixedConfig && pointer.status === "named" && !livePresent) {
    const known = await sourceProfileNames();
    if (!known.includes(pointer.name)) {
      throw new Error(
        `Cannot migrate legacy intelligence selection: ACTIVE names unknown profile ${pointer.name}.\n${activeSelectionRepairMessage(target)}`,
      );
    }
    return { name: pointer.name, mode: "legacy" };
  }

  const selection = await activeSelectionStatus(target);
  if (selection.errors.length) {
    throw new Error(
      `Refusing install because the active intelligence selection is inconsistent:\n- ${selection.errors.join("\n- ")}\n${activeSelectionRepairMessage(target)}`,
    );
  }
  return { name: selection.pointer.name, mode: "existing" };
}

async function install(options) {
  const target = targetFor(options);
  assertLiveSafety(options);
  const selection = await installProfileSelection(target);
  await mkdir(target, { recursive: true });
  const backup = await createBackup(target);

  for (const [source, destination] of COPY_ENTRIES) {
    await copyReplacing(join(ROOT, source), join(target, destination));
  }
  const removedPackageSources = await readJson(join(ROOT, "config", "package-removals.json"), []);
  const removedModels = await readJson(join(ROOT, "config", "model-removals.json"), []);
  for (const [source, destination, mode] of MERGE_ENTRIES) {
    const existing = await readJson(join(target, destination), {});
    const overlay = await readJson(join(ROOT, source), {});
    const merged = mode === "settings"
      ? mergeSettings(existing, overlay, removedPackageSources, removedModels)
      : deepMerge(existing, overlay);
    await atomicJson(join(target, destination), merged);
  }
  await materializeProfile(target, selection.name);
  await atomicJson(join(target, STATE_FILE), {
    schemaVersion: 1,
    installedAt: new Date().toISOString(),
    source: ROOT,
    backup,
  });
  console.log(`Installed portable Pi harness into ${target}`);
  console.log(`Intelligence selection: ${selection.name} (${selection.mode})`);
  console.log(`Backup: ${backup}`);
  console.log("Pi was not reloaded. Run doctor before any later activation.");
}

async function plan(options) {
  const target = targetFor(options);
  console.log(`Target: ${target}`);
  console.log(`Mode: ${options.live ? "LIVE (explicit)" : "sandbox/preview"}`);
  for (const [source, destination] of COPY_ENTRIES) {
    console.log(`COPY  ${source} -> ${destination}`);
  }
  for (const [source, destination] of MERGE_ENTRIES) {
    console.log(`MERGE ${source} -> ${destination}`);
  }
  console.log("PRESERVE intelligence-profiles/ACTIVE when its named guide still exists");
  console.log("REFUSE install before mutation when ACTIVE and advisor-intelligence.json are inconsistent");
  console.log("MATERIALIZE selected guide -> advisor-intelligence.json");
  console.log("NEVER mutate bg-agent-profiles.json during intelligence switching");
  console.log("BACKUP every managed destination before replacement or merge");
  console.log("NO reload, provider login, runtime-state transfer, or active-session migration");
}

async function installHerdrConfig(options) {
  const target = herdrTargetFor(options);
  assertLiveSafety(options);
  await mkdir(target, { recursive: true });
  const destinations = HERDR_COPY_ENTRIES.map(([, destination]) => destination);
  const backup = await createScopedBackup(target, destinations, HERDR_BACKUP_ROOT);
  for (const [source, destination] of HERDR_COPY_ENTRIES) {
    await copyReplacing(join(ROOT, source), join(target, destination));
  }
  console.log(`Installed Herdr configuration into ${target}`);
  console.log(`Backup: ${backup}`);
  console.log("Herdr was not restarted or reloaded.");
}

async function filesUnder(path) {
  const result = [];
  if (!(await exists(path))) return result;
  const info = await stat(path);
  if (!info.isDirectory()) return [path];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory() && [".git", "node_modules", ".tmp"].includes(entry.name)) {
      continue;
    }
    result.push(...await filesUnder(join(path, entry.name)));
  }
  return result;
}

async function digest(path, ignoredRelativePaths = new Set()) {
  const info = await stat(path);
  if (!info.isDirectory()) return createHash("sha256").update(await readFile(path)).digest("hex");
  const hash = createHash("sha256");
  const files = (await filesUnder(path)).filter((file) => !ignoredRelativePaths.has(relative(path, file)));
  files.sort();
  for (const file of files) {
    hash.update(relative(path, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

function versionTuple(value) {
  return value.replace(/^v/, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(actual, minimum) {
  const left = versionTuple(actual);
  const right = versionTuple(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return `${result.stdout}${result.stderr}`.trim().split(/\s+/).find((part) => /^v?\d+\.\d+/.test(part));
}

async function repositoryFilesForSecurityScan() {
  const listed = spawnSync(
    "git",
    ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  );
  if (listed.status === 0) {
    const files = listed.stdout
      .split("\0")
      .filter(Boolean)
      .map((path) => join(ROOT, path));
    const present = [];
    for (const file of files) if (await exists(file)) present.push(file);
    return present;
  }
  return filesUnder(ROOT);
}

async function repositorySecurityErrors() {
  const errors = [];
  for (const file of await repositoryFilesForSecurityScan()) {
    const relativePath = relative(ROOT, file);
    const portablePath = relativePath.split(sep).join("/");
    if (relativePath.startsWith(`.git${sep}`) || relativePath.includes(`${sep}node_modules${sep}`)) continue;
    if (FORBIDDEN_REPOSITORY_PREFIXES.some((prefix) => portablePath.startsWith(prefix))) {
      errors.push(`Forbidden runtime-state path: ${portablePath}`);
    }
    if (FORBIDDEN_REPOSITORY_NAMES.has(basename(file))) errors.push(`Forbidden file: ${relativePath}`);
    if (portablePath !== ".env.example" && basename(file).startsWith(".env")) {
      errors.push(`Forbidden environment file: ${portablePath}`);
    }
    if (portablePath === ".env.example") continue;
    const contents = await readFile(file);
    if (contents.includes(0)) continue;
    const text = contents.toString("utf8");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) errors.push(`Possible secret pattern in ${relativePath}`);
    }
  }
  return errors;
}

function subsetErrors(actual, expected, path = "config") {
  const errors = [];
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`Missing configured array: ${path}`];
    for (const value of expected) {
      if (!actual.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
        errors.push(`Missing configured value at ${path}: ${JSON.stringify(value)}`);
      }
    }
    return errors;
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return [`Missing configured object: ${path}`];
    for (const [key, value] of Object.entries(expected)) {
      errors.push(...subsetErrors(actual[key], value, `${path}.${key}`));
    }
    return errors;
  }
  if (actual !== expected) errors.push(`Configuration drift at ${path}: expected ${JSON.stringify(expected)}`);
  return errors;
}

async function doctor(options) {
  const target = targetFor(options);
  const errors = [];
  for (const [source, destination] of COPY_ENTRIES) {
    const expected = join(ROOT, source);
    const actual = join(target, destination);
    if (!(await exists(actual))) {
      errors.push(`Missing managed path: ${destination}`);
      continue;
    }
    if (await digest(expected) !== await digest(actual)) errors.push(`Drift: ${destination}`);
  }

  const roleConfig = await readJson(join(target, "bg-agent-profiles.json"), {});
  errors.push(...roleConfigErrors(roleConfig));
  try {
    const roles = Object.keys(roleConfig.profiles ?? {});
    for (const name of await listProfileNames(target)) {
      const named = await readProfileJson(join(target, "intelligence-profiles", `${name}.json`));
      if (named.name !== name) errors.push(`Profile ${name}: name does not match file name`);
      for (const error of intelligenceGuideErrors(named, roles)) errors.push(`Profile ${name}: ${error}`);
    }
    const selection = await activeSelectionStatus(target);
    errors.push(...selection.errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const overlay = await readJson(join(ROOT, "config", "settings.overlay.json"), {});
  const settings = await readJson(join(target, "settings.json"), {});
  const installedIds = new Set((settings.packages ?? []).map(packageIdentity));
  const installedSources = new Set((settings.packages ?? []).map(packageSource));
  for (const entry of overlay.packages ?? []) {
    if (!packageSourceIsApproved(packageSource(entry))) {
      errors.push(`Pi package source is not a caret npm range or full Git commit: ${packageSource(entry)}`);
    }
    if (!installedIds.has(packageIdentity(entry))) errors.push(`Missing Pi package setting: ${packageSource(entry)}`);
    if (!installedIds.has(packageIdentity(entry))) errors.push(`Missing Pi package setting: ${packageSource(entry)}`);
    else if (!installedSources.has(packageSource(entry))) {
      errors.push(`Pi package source does not match the configured range or commit: ${packageSource(entry)}`);
    }
  }
  const { packages: _packages, ...settingsOverlay } = overlay;
  for (const key of RUNTIME_SETTING_KEYS) delete settingsOverlay[key];
  errors.push(...subsetErrors(settings, settingsOverlay, "settings"));
  const removedPackageSources = await readJson(join(ROOT, "config", "package-removals.json"), []);
  for (const source of removedPackageSources) {
    if (installedIds.has(packageIdentity(source))) errors.push(`Retired Pi package still configured: ${source}`);
  }
  const removedModels = await readJson(join(ROOT, "config", "model-removals.json"), []);
  for (const model of removedModels) {
    if ((settings.enabledModels ?? []).includes(model)) errors.push(`Retired model still enabled: ${model}`);
  }
  const mcp = await readJson(join(target, "mcp.json"), {});
  const mcpOverlay = await readJson(join(ROOT, "config", "mcp.json"), {});
  errors.push(...subsetErrors(mcp, mcpOverlay, "mcp"));

  if (options.live) {
    for (const [source, destination] of HERDR_COPY_ENTRIES) {
      const expected = join(ROOT, source);
      const actual = join(LIVE_HERDR_TARGET, destination);
      if (!(await exists(actual))) errors.push(`Missing Herdr configuration: ${destination}`);
      else if (await digest(expected) !== await digest(actual)) errors.push(`Herdr configuration drift: ${destination}`);
    }
    const nodeVersion = process.version;
    if (!versionAtLeast(nodeVersion, "22.19.0")) errors.push(`Node 22.19+ required; found ${nodeVersion}`);
    const requiredCommands = ["pi", "herdr", "engram", "agent-browser", "claude"];
    const commandVersions = new Map(requiredCommands.map((command) => [command, commandVersion(command)]));
    for (const [command, version] of commandVersions) {
      if (!version) errors.push(`Required command not available: ${command}`);
    }
    const piVersion = commandVersions.get("pi");
    if (piVersion && !versionAtLeast(piVersion, "0.84.4")) {
      errors.push(`Pi 0.84.4+ required; found ${piVersion}`);
    }
    const agentBrowserVersion = commandVersions.get("agent-browser");
    if (agentBrowserVersion && !versionAtLeast(agentBrowserVersion, "0.36.0")) {
      errors.push(`agent-browser 0.36.0+ required; found ${agentBrowserVersion}`);
    }
    const herdrVersion = commandVersions.get("herdr");
    if (herdrVersion && !versionAtLeast(herdrVersion, "0.8.0")) {
      errors.push(`Herdr 0.8.0+ required; found ${herdrVersion}`);
    }
    const engramVersion = commandVersions.get("engram");
    if (engramVersion && !versionAtLeast(engramVersion, "1.20.0")) {
      errors.push(`Engram 1.20.0+ required; found ${engramVersion}`);
    }
    errors.push(...await installedSkillErrors());

    const herdrStatus = spawnSync("herdr", ["integration", "status"], { encoding: "utf8" });
    if (herdrStatus.status !== 0 || !/^pi: current/m.test(herdrStatus.stdout)) {
      errors.push("Herdr Pi integration is missing or outdated; run install-herdr-integration --live");
    }
  }
  errors.push(...await repositorySecurityErrors());

  if (errors.length) {
    console.error(`Doctor found ${errors.length} issue(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Doctor passed for ${target}`);
  console.log("All managed copies, fixed role guardrails, advisor guidance, package settings, and security checks passed.");
}

async function restoreScoped(options, target, backupRoot, runtimeName, expectedDestinations) {
  if (!options.backup) throw new Error(`restore-${runtimeName.toLowerCase()} requires --backup <dir>`);
  assertLiveSafety(options);
  const backup = resolve(expandHome(options.backup));
  const allowedBackupRoot = resolve(target, backupRoot);
  if (!isWithin(allowedBackupRoot, backup) || backup === allowedBackupRoot) {
    throw new Error(`Backup must be inside ${allowedBackupRoot}`);
  }

  const targetPhysical = await realpath(target);
  const backupRootPhysical = await realpath(allowedBackupRoot);
  const backupPhysical = await realpath(backup);
  if (!isWithin(targetPhysical, backupRootPhysical) || !isWithin(backupRootPhysical, backupPhysical)) {
    throw new Error("Backup follows a symlink outside the restore target");
  }

  const manifest = await readJson(join(backup, "manifest.json"));
  if (
    !isObject(manifest) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.target !== "string" ||
    resolve(manifest.target) !== target
  ) {
    throw new Error("Backup manifest target or schema does not match");
  }
  if (!Array.isArray(manifest.entries)) throw new Error("Backup manifest entries are invalid");

  const expected = new Set(expectedDestinations);
  const seen = new Set();
  const filesRoot = join(backup, "files");
  const plans = [];
  for (const entry of manifest.entries) {
    if (!isObject(entry) || typeof entry.destination !== "string" || typeof entry.wasPresent !== "boolean") {
      throw new Error("Backup manifest entry is invalid");
    }
    if (!expected.has(entry.destination) || seen.has(entry.destination)) {
      throw new Error(`Backup manifest destination is not allowed: ${entry.destination}`);
    }
    seen.add(entry.destination);
    const destination = resolve(target, entry.destination);
    const source = resolve(filesRoot, entry.destination);
    if (!isWithin(target, destination) || !isWithin(filesRoot, source)) {
      throw new Error(`Backup manifest destination escapes its restore root: ${entry.destination}`);
    }
    await assertPhysicalParentWithin(target, destination, `Restore destination ${entry.destination}`);
    if (entry.wasPresent && !(await exists(source))) {
      throw new Error(`Backup source is missing: ${entry.destination}`);
    }
    if (entry.wasPresent) {
      const filesRootPhysical = await realpath(filesRoot);
      const sourcePhysical = await realpath(source);
      if (!isWithin(backupPhysical, filesRootPhysical) || !isWithin(filesRootPhysical, sourcePhysical)) {
        throw new Error(`Backup source follows a symlink outside its files root: ${entry.destination}`);
      }
    }
    plans.push({ ...entry, destination, source });
  }
  if (seen.size !== expected.size || [...expected].some((destination) => !seen.has(destination))) {
    throw new Error("Backup manifest does not contain the exact managed destination set");
  }

  // Validate the complete plan before the first destructive operation so a
  // malformed or partial backup cannot leave the target half-restored.
  for (const plan of plans) {
    await rm(plan.destination, { recursive: true, force: true });
    if (plan.wasPresent) {
      await mkdir(dirname(plan.destination), { recursive: true });
      await cp(plan.source, plan.destination, { recursive: true, dereference: false });
    }
  }
  console.log(`Restored ${target} from ${backup}`);
  console.log(`${runtimeName} was not reloaded.`);
}

async function restore(options) {
  return restoreScoped(options, targetFor(options), BACKUP_ROOT, "Pi", managedDestinations());
}

async function restoreHerdr(options) {
  const destinations = HERDR_COPY_ENTRIES.map(([, destination]) => destination);
  return restoreScoped(options, herdrTargetFor(options), HERDR_BACKUP_ROOT, "Herdr", destinations);
}

async function skillGroups() {
  const manifest = await readJson(join(ROOT, "config", "skill-sources.json"), { groups: [] });
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.groups)) {
    throw new Error("Skill source manifest schema or groups are invalid");
  }
  for (const group of manifest.groups) {
    if (
      !isObject(group) ||
      typeof group.sourceUrl !== "string" ||
      !/^[0-9a-f]{40}$/.test(group.commit ?? "") ||
      !/^[0-9a-f]{40}$/.test(group.tree ?? "") ||
      !Array.isArray(group.skills) ||
      group.skills.length === 0
    ) {
      throw new Error(`Skill source is not fully pinned: ${group?.source ?? "unknown"}`);
    }
    group.skills = validatedSkillNames(group.skills, `Skill source ${group.source}`);
  }
  const allSkills = manifest.groups.flatMap((group) => group.skills);
  if (new Set(allSkills).size !== allSkills.length) {
    throw new Error("Skill source manifest selects the same skill more than once");
  }
  return manifest.groups;
}

async function retiredSkills() {
  const removals = await readJson(join(ROOT, "config", "skill-removals.json"), []);
  return validatedSkillNames(removals, "Skill removal manifest");
}

async function installedSkillErrors() {
  const errors = [];
  const groups = await skillGroups();
  const selected = new Set(groups.flatMap((group) => group.skills));
  const retired = await retiredSkills();
  for (const skill of retired) {
    if (selected.has(skill)) errors.push(`Skill is both selected and retired: ${skill}`);
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const piInstalled = skillDestination(join(agentDir, "skills"), skill);
    const globalInstalled = skillDestination(join(homedir(), ".agents", "skills"), skill);
    if (await exists(piInstalled) || await exists(globalInstalled)) {
      errors.push(`Retired skill is still installed: ${skill}`);
    }
  }
  const lock = await readJson(join(ROOT, "config", "third-party-skills.lock.json"), {});
  if (lock.schemaVersion !== 4 || lock.installer !== "skills@^1.5.23" || !isObject(lock.skills)) {
    return ["Third-party skill lock is invalid or stale"];
  }
  for (const group of groups) {
    for (const skill of group.skills) {
      const entry = lock.skills[skill];
      if (
        !isObject(entry) ||
        entry.sourceUrl !== group.sourceUrl ||
        entry.commit !== group.commit ||
        entry.tree !== group.tree ||
        !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")
      ) {
        errors.push(`Skill lock does not match its pinned source: ${skill}`);
        continue;
      }
      const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
      const piInstalled = skillDestination(join(agentDir, "skills"), skill);
      const globalInstalled = skillDestination(join(homedir(), ".agents", "skills"), skill);
      const piPresent = await exists(piInstalled);
      const globalPresent = await exists(globalInstalled);
      if (piPresent && globalPresent && await realpath(piInstalled) !== await realpath(globalInstalled)) {
        errors.push(`Pinned skill has conflicting Pi and canonical copies: ${skill}`);
      }
      const installed = piPresent ? piInstalled : globalPresent ? globalInstalled : undefined;
      if (!installed) errors.push(`Pinned skill is not installed: ${skill}`);
      else if (await digest(installed, GENERATED_SKILL_FILES.get(skill)) !== entry.sha256) {
        errors.push(`Pinned skill content drift: ${skill}`);
      }
    }
  }
  return errors;
}

async function promoteSkillsToCanonical(agentDir, skills) {
  const canonicalRoot = join(homedir(), ".agents", "skills");
  await mkdir(canonicalRoot, { recursive: true });
  for (const skill of skills) {
    const piInstalled = skillDestination(join(agentDir, "skills"), skill);
    if (!(await exists(piInstalled))) throw new Error(`Pi skill installation is missing: ${skill}`);
    await copyReplacing(piInstalled, skillDestination(canonicalRoot, skill));
    await rm(piInstalled, { recursive: true, force: true });
  }
}

async function releaseManagedSkillsFromGenericLock(skills) {
  const path = join(homedir(), ".agents", ".skill-lock.json");
  if (!(await exists(path))) return;
  const lock = await readJson(path, { version: 3, skills: {} });
  if (!isObject(lock.skills)) throw new Error(`Invalid global skill lock: ${path}`);
  for (const skill of skills) delete lock.skills[skill];
  await atomicJson(path, lock);
}

function skillInstallCommand(group, checkout) {
  return [
    "npx",
    "--yes",
    "skills@^1.5.23",
    "add",
    checkout,
    "--global",
    "--copy",
    "--agent",
    "pi",
    "--skill",
    ...group.skills,
    "--yes",
    "--full-depth",
  ];
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    throw new Error(`${command} failed with exit ${result.status}${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout?.trim() ?? "";
}

function exactGitPin(source) {
  if (typeof source !== "string") return undefined;
  const match = source.match(/^git:(.+)@([0-9a-f]{40})$/);
  return match ? { url: match[1], commit: match[2], source } : undefined;
}

async function verifyGitPins() {
  const overlay = await readJson(join(ROOT, "config", "settings.overlay.json"), {});
  const gitSources = (overlay.packages ?? [])
    .map(packageSource)
    .filter((source) => typeof source === "string" && source.startsWith("git:"));
  const pins = gitSources.map(exactGitPin);
  const invalid = gitSources.filter((_, index) => !pins[index]);
  if (invalid.length) throw new Error(`Git package source is not pinned to a full commit: ${invalid.join(", ")}`);

  const temporary = await mkdtemp(join(tmpdir(), "pi-meta-harness-git-pins-"));
  try {
    for (const [index, pin] of pins.entries()) {
      const checkout = join(temporary, String(index));
      await mkdir(checkout, { recursive: true });
      runChecked("git", ["-C", checkout, "init", "--quiet"]);
      const fetched = spawnSync(
        "git",
        ["-C", checkout, "fetch", "--quiet", "--depth", "1", pin.url, pin.commit],
        { encoding: "utf8", timeout: GIT_PIN_FETCH_TIMEOUT_MS },
      );
      if (fetched.error?.code === "ETIMEDOUT") {
        throw new Error(`Timed out fetching exact Git pin after ${GIT_PIN_FETCH_TIMEOUT_MS}ms: ${pin.source}`);
      }
      if (fetched.status !== 0) {
        const detail = `${fetched.stderr ?? ""}${fetched.stdout ?? ""}`.trim();
        throw new Error(`Could not fetch exact Git pin: ${pin.source}${detail ? `\n${detail}` : ""}`);
      }
      const actual = runChecked("git", ["-C", checkout, "rev-parse", "FETCH_HEAD"]);
      if (actual !== pin.commit) throw new Error(`Fetched Git pin resolved to ${actual}, expected ${pin.commit}`);
      console.log(`FETCHED ${pin.source}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(`Verified ${pins.length} exact Git package pin(s).`);
}

async function skillsPlan() {
  for (const group of await skillGroups()) {
    const command = skillInstallCommand(group, "<verified-checkout>");
    console.log(`PIN ${group.sourceUrl}@${group.commit} tree=${group.tree} :: ${command.join(" ")}`);
  }
}

async function installSkills(options) {
  if (!options.live) throw new Error("Third-party global skill installation requires --live");
  assertLiveSafety(options);
  const groups = await skillGroups();
  const skills = groups.flatMap((group) => group.skills);
  const retired = await retiredSkills();
  const selected = new Set(skills);
  const overlap = retired.find((skill) => selected.has(skill));
  if (overlap) throw new Error(`Skill is both selected and retired: ${overlap}`);
  const managedSkills = [...skills, ...retired];
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const piSkillsRoot = join(agentDir, "skills");
  const canonicalSkillsRoot = join(homedir(), ".agents", "skills");
  for (const skill of managedSkills) {
    skillDestination(piSkillsRoot, skill);
    skillDestination(canonicalSkillsRoot, skill);
  }
  const piBackup = await createScopedBackup(
    agentDir,
    managedSkills.map((skill) => join("skills", skill)),
    SKILL_BACKUP_ROOT,
  );
  const canonicalRoot = join(homedir(), ".agents");
  const canonicalBackup = await createScopedBackup(
    canonicalRoot,
    [...managedSkills.map((skill) => join("skills", skill)), ".skill-lock.json"],
    SKILL_BACKUP_ROOT,
  );
  console.log(`Pi skill backup: ${piBackup}`);
  console.log(`Canonical skill backup: ${canonicalBackup}`);
  for (const group of groups) {
    const temporary = await mkdtemp(join(tmpdir(), "pi-meta-harness-skills-"));
    const checkout = join(temporary, "source");
    try {
      await mkdir(checkout, { recursive: true });
      runChecked("git", ["-C", checkout, "init", "--quiet"]);
      runChecked("git", ["-C", checkout, "remote", "add", "origin", group.sourceUrl]);
      runChecked("git", ["-C", checkout, "fetch", "--quiet", "--depth", "1", "origin", group.commit]);
      runChecked("git", ["-C", checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
      const actualCommit = runChecked("git", ["-C", checkout, "rev-parse", "HEAD"]);
      const actualTree = runChecked("git", ["-C", checkout, "rev-parse", "HEAD^{tree}"]);
      if (actualCommit !== group.commit || actualTree !== group.tree) {
        throw new Error(`Pinned skill source verification failed: ${group.source}`);
      }
      const [command, ...args] = skillInstallCommand(group, checkout);
      console.log(`Installing ${group.source}@${group.commit}`);
      runChecked(command, args, { stdio: "inherit", encoding: undefined });
      await promoteSkillsToCanonical(agentDir, group.skills);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  for (const skill of retired) {
    await rm(skillDestination(piSkillsRoot, skill), { recursive: true, force: true });
    await rm(skillDestination(canonicalSkillsRoot, skill), { recursive: true, force: true });
  }
  await releaseManagedSkillsFromGenericLock(managedSkills);
  const verificationErrors = await installedSkillErrors();
  if (verificationErrors.length) throw new Error(verificationErrors.join("\n"));
  console.log("Third-party skills installed from verified commits and hashes. Pi was not reloaded.");
}

function installHerdrIntegration(options) {
  if (!options.live) throw new Error("Herdr integration installation requires --live");
  assertLiveSafety(options);
  const result = spawnSync("herdr", ["integration", "install", "pi"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Herdr integration install failed with exit ${result.status}`);
  console.log("Herdr regenerated its Pi integration. Pi was not reloaded.");
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === "plan") await plan(options);
    else if (options.command === "install") await install(options);
    else if (options.command === "doctor") await doctor(options);
    else if (options.command === "restore") await restore(options);
    else if (options.command === "install-herdr-config") await installHerdrConfig(options);
    else if (options.command === "restore-herdr") await restoreHerdr(options);
    else if (options.command === "verify-git-pins") await verifyGitPins();
    else if (options.command === "skills-plan") await skillsPlan();
    else if (options.command === "install-skills") await installSkills(options);
    else if (options.command === "install-herdr-integration") installHerdrIntegration(options);
    else usage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
