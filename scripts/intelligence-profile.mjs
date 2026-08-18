#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_PROFILE = "codex-max";
export const ALLOWED_CURSOR_MODEL = "cursor/grok-4.6";
export const REQUIRED_ROLES = [
  "scout",
  "planner",
  "reducer",
  "builder",
  "checker",
  "browser-verifier",
];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function agentDir(override) {
  return override ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function profileDir(target) {
  return join(target, "intelligence-profiles");
}

export function liveMapPath(target) {
  return join(target, "bg-agent-profiles.json");
}

export function activePath(target) {
  return join(profileDir(target), "ACTIVE");
}

export function intelligenceMapErrors(config) {
  const errors = [];
  const models = isObject(config.models) ? config.models : {};
  const profiles = isObject(config.profiles) ? config.profiles : {};
  if (!Object.keys(models).length) errors.push("Advisor intelligence map has no models");

  for (const [modelId, entry] of Object.entries(models)) {
    if (modelId.startsWith("cursor/") && modelId !== ALLOWED_CURSOR_MODEL) {
      errors.push(`Cursor model is not allowed: ${modelId} (only ${ALLOWED_CURSOR_MODEL})`);
    }
    if (!isObject(entry)) {
      errors.push(`Invalid intelligence-map entry: ${modelId}`);
      continue;
    }
    if (!Array.isArray(entry.thinking) || entry.thinking.length === 0) {
      errors.push(`Model has no allowed reasoning levels: ${modelId}`);
    }
    if (typeof entry.defaultThinking !== "string" || !entry.thinking?.includes(entry.defaultThinking)) {
      errors.push(`Model default reasoning is not allowed: ${modelId}`);
    }
    if (typeof entry.character !== "string" || !entry.character.trim()) {
      errors.push(`Model has no character guidance: ${modelId}`);
    }
  }

  for (const role of REQUIRED_ROLES) {
    const profile = profiles[role];
    if (!isObject(profile)) {
      errors.push(`Missing advisor role: ${role}`);
      continue;
    }
    if (!Number.isInteger(profile.maxTurns) || profile.maxTurns < 1) {
      errors.push(`Invalid prompt-cycle cap for role: ${role}`);
    }
    if (profile.requireAnchor !== true) errors.push(`Role does not require an anchor: ${role}`);
    if (!Array.isArray(profile.allowedModels) || profile.allowedModels.length === 0) {
      errors.push(`Role has no allowed models: ${role}`);
      continue;
    }
    for (const modelId of profile.allowedModels) {
      if (!models[modelId]) errors.push(`Role ${role} references unknown model: ${modelId}`);
    }
  }
  return errors;
}

export async function listProfileNames(target) {
  const dir = profileDir(target);
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  if (!names.length) throw new Error(`No intelligence profiles in ${dir}`);
  return names;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readActiveName(target) {
  try {
    const name = (await readFile(activePath(target), "utf8")).trim();
    return name || undefined;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function inferProfileName(target, live) {
  const bytes = live ?? await readFile(liveMapPath(target));
  for (const name of await listProfileNames(target)) {
    const candidate = await readFile(join(profileDir(target), `${name}.json`));
    if (Buffer.compare(bytes, candidate) === 0) return name;
  }
  return undefined;
}

async function atomicCopy(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  await copyFile(source, temp);
  await rename(temp, destination);
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, contents);
  await rename(temp, path);
}

export async function applyNamedProfile(target, name, { backupLive = true } = {}) {
  const names = await listProfileNames(target);
  if (!names.includes(name)) {
    throw new Error(`Unknown intelligence profile "${name}". Available: ${names.join(", ")}`);
  }
  const source = join(profileDir(target), `${name}.json`);
  const parsed = await readJson(source);
  const errors = intelligenceMapErrors(parsed);
  if (errors.length) throw new Error(`Invalid profile ${name}:\n- ${errors.join("\n- ")}`);

  const live = liveMapPath(target);
  if (backupLive) {
    try {
      const previous = await readFile(live);
      const stamp = new Date().toISOString().replaceAll(":", "-");
      await atomicWrite(join(profileDir(target), ".backups", `${stamp}.json`), previous);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await atomicCopy(source, live);
  await atomicWrite(activePath(target), `${name}\n`);
  return name;
}

export async function ensureActiveProfile(target) {
  const names = await listProfileNames(target);
  const recorded = await readActiveName(target);
  if (recorded && names.includes(recorded)) {
    return applyNamedProfile(target, recorded, { backupLive: false });
  }
  const inferred = await inferProfileName(target).catch(() => undefined);
  const name = inferred && names.includes(inferred) ? inferred : DEFAULT_PROFILE;
  return applyNamedProfile(target, name, { backupLive: false });
}

export async function statusLines(target) {
  const names = await listProfileNames(target);
  const recorded = await readActiveName(target);
  const inferred = await inferProfileName(target).catch(() => undefined);
  const live = inferred ?? "custom/unmatched";
  return [
    `Target: ${target}`,
    `Active file: ${recorded ?? "(missing)"}`,
    `Live map matches: ${live}`,
    `Profiles: ${names.join(", ")}`,
    "This session's /model is unchanged. Subsequent bg_agent launches read the live map.",
    "If the advisor session itself was on Sol, switch it to Fable or Grok after a lean/heavy cutover.",
  ];
}

function usage() {
  console.error("Usage: intelligence-profile [name] [--target <pi-agent-dir>]");
  console.error("       intelligence-profile --list [--target <pi-agent-dir>]");
  process.exitCode = 2;
}

export async function runCli(argv) {
  const args = [...argv];
  let target;
  const targetIndex = args.indexOf("--target");
  if (targetIndex >= 0) {
    target = args[targetIndex + 1];
    args.splice(targetIndex, 2);
  }
  target = agentDir(target);
  if (args[0] === "--list" || args.length === 0) {
    for (const line of await statusLines(target)) console.log(line);
    if (args[0] === "--list") return;
    return;
  }
  if (args[0] === "--help" || args.length !== 1 || args[0].startsWith("-")) {
    usage();
    return;
  }
  const name = await applyNamedProfile(target, args[0]);
  console.log(`Switched intelligence profile to ${name}`);
  for (const line of await statusLines(target)) console.log(line);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
