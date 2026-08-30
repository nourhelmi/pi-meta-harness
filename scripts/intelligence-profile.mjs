#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_PROFILE = "codex-max";
export const REQUIRED_ROLES = [
  "scout",
  "planner",
  "reducer",
  "builder",
  "foreman",
  "checker",
  "browser-verifier",
];
const REASONING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const FORBIDDEN_ROLE_POLICY_FIELDS = new Set([
  "model",
  "provider",
  "models",
  "allowedModels",
  "allowedThinkingByModel",
]);
const FORBIDDEN_ROLE_ENFORCEMENT_FIELDS = new Set([
  "tools",
  "excludeTools",
  "turnCapFlag",
]);

const ROLE_FIELDS = new Set([
  "description",
  "agent",
  "harness",
  "skill",
  "skillPath",
  "cliArgs",
  "maxTurns",
  "requireAnchor",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}

export function agentDir(override) {
  return override ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function profileDir(target) {
  return join(target, "intelligence-profiles");
}

export function roleConfigPath(target) {
  return join(target, "bg-agent-profiles.json");
}

export function liveGuidePath(target) {
  return join(target, "advisor-intelligence.json");
}

export function activePath(target) {
  return join(profileDir(target), "ACTIVE");
}

export function roleConfigErrors(config) {
  const errors = [];
  if (!isObject(config)) return ["Advisor role configuration is not an object"];
  if (!nonEmptyString(config.defaultAgent)) errors.push("Advisor role configuration has no defaultAgent");
  if (Object.hasOwn(config, "models")) errors.push("Advisor role configuration must not contain models");
  for (const field of Object.keys(config)) {
    if (!["defaultAgent", "profiles"].includes(field)) errors.push(`Unknown advisor role configuration field: ${field}`);
  }
  const profiles = isObject(config.profiles) ? config.profiles : {};
  if (!Object.keys(profiles).length) errors.push("Advisor role configuration has no profiles");

  for (const role of REQUIRED_ROLES) {
    if (!isObject(profiles[role])) errors.push(`Missing advisor role: ${role}`);
  }
  for (const [role, profile] of Object.entries(profiles)) {
    if (!isObject(profile)) {
      errors.push(`Invalid advisor role: ${role}`);
      continue;
    }
    if (!REQUIRED_ROLES.includes(role)) {
      errors.push(`Unknown advisor role: ${role}`);
    }
    for (const field of FORBIDDEN_ROLE_POLICY_FIELDS) {
      if (Object.hasOwn(profile, field)) errors.push(`Role ${role} contains intelligence policy field: ${field}`);
    }
    for (const field of FORBIDDEN_ROLE_ENFORCEMENT_FIELDS) {
      if (Object.hasOwn(profile, field)) errors.push(`Role ${role} contains deterministic enforcement field: ${field}`);
    }
    for (const field of Object.keys(profile)) {
      if (
        !ROLE_FIELDS.has(field) &&
        !FORBIDDEN_ROLE_POLICY_FIELDS.has(field) &&
        !FORBIDDEN_ROLE_ENFORCEMENT_FIELDS.has(field)
      ) {
        errors.push(`Role ${role} contains unknown field: ${field}`);
      }
    }
    if (!nonEmptyString(profile.description)) errors.push(`Role has no description: ${role}`);
    if (!nonEmptyString(profile.agent)) errors.push(`Role has no agent: ${role}`);
    if (profile.harness !== undefined && !["pi", "native"].includes(profile.harness)) {
      errors.push(`Role has invalid harness constraint: ${role}`);
    }
    if (!nonEmptyString(profile.skill)) errors.push(`Role has no instructed skill: ${role}`);
    if (!nonEmptyString(profile.skillPath)) errors.push(`Role has no skill path: ${role}`);
    if (!stringArray(profile.cliArgs)) errors.push(`Role has invalid CLI args: ${role}`);
    if (!Number.isInteger(profile.maxTurns) || profile.maxTurns < 1) {
      errors.push(`Invalid prompt-cycle cap for role: ${role}`);
    }
    if (profile.requireAnchor !== true) errors.push(`Role does not require an anchor: ${role}`);
  }
  return errors;
}

export function intelligenceGuideErrors(config, configuredRoles = REQUIRED_ROLES) {
  const errors = [];
  const recommendationRoles = configuredRoles.filter((role) => REQUIRED_ROLES.includes(role));
  if (!isObject(config)) return ["Advisor intelligence guide is not an object"];
  if (!nonEmptyString(config.name)) errors.push("Advisor intelligence guide has no name");
  for (const field of Object.keys(config)) {
    if (!["name", "models", "recommendations"].includes(field)) {
      errors.push(`Unknown advisor intelligence guide field: ${field}`);
    }
  }
  const models = isObject(config.models) ? config.models : {};
  const recommendations = isObject(config.recommendations) ? config.recommendations : {};
  if (!Object.keys(models).length) errors.push("Advisor intelligence guide has no models");

  for (const [modelId, entry] of Object.entries(models)) {
    if (!nonEmptyString(modelId) || !isObject(entry)) {
      errors.push(`Invalid intelligence-guide entry: ${modelId}`);
      continue;
    }
    for (const field of Object.keys(entry)) {
      if (!["character", "defaultThinking"].includes(field)) {
        errors.push(`Model ${modelId} has unknown guidance field: ${field}`);
      }
    }
    if (!nonEmptyString(entry.character)) errors.push(`Model has no character guidance: ${modelId}`);
    if (!REASONING_LEVELS.has(entry.defaultThinking)) {
      errors.push(`Model has invalid default reasoning guidance: ${modelId}`);
    }
  }

  for (const role of recommendationRoles) {
    const choices = recommendations[role];
    if (!Array.isArray(choices) || choices.length === 0) {
      errors.push(`Role has no recommendations: ${role}`);
      continue;
    }
    const seen = new Set();
    for (const [index, choice] of choices.entries()) {
      if (!isObject(choice)) {
        errors.push(`Role ${role} has invalid recommendation at index ${index}`);
        continue;
      }
      for (const field of Object.keys(choice)) {
        if (!["model", "thinking", "fit"].includes(field)) {
          errors.push(`Role ${role} recommendation has unknown field: ${field}`);
        }
      }
      if (!nonEmptyString(choice.model) || !models[choice.model]) {
        errors.push(`Role ${role} references unknown model: ${choice.model}`);
      }
      if (!REASONING_LEVELS.has(choice.thinking)) {
        errors.push(`Role ${role} recommends invalid reasoning ${choice.thinking} for model: ${choice.model}`);
      }
      if (!nonEmptyString(choice.fit)) errors.push(`Role ${role} recommendation has no fit guidance at index ${index}`);
      const identity = `${choice.model}/${choice.thinking}`;
      if (seen.has(identity)) errors.push(`Role ${role} repeats recommendation: ${identity}`);
      seen.add(identity);
    }
  }
  for (const role of Object.keys(recommendations)) {
    if (!recommendationRoles.includes(role)) errors.push(`Recommendations reference unknown role: ${role}`);
  }
  return errors;
}

export async function listProfileNames(target) {
  const dir = profileDir(target);
  const entries = await readdir(dir);
  const names = entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  if (!names.length) throw new Error(`No intelligence profiles in ${dir}`);
  return names;
}

export async function readJson(path) {
  const contents = await readFile(path, "utf8");
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON: ${path}`, { cause: error });
  }
}

export async function readActivePointer(target) {
  try {
    const contents = await readFile(activePath(target), "utf8");
    const name = contents.trim();
    return name ? { status: "named", name } : { status: "empty" };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    throw error;
  }
}

export async function readActiveName(target) {
  const pointer = await readActivePointer(target);
  return pointer.status === "named" ? pointer.name : undefined;
}

export async function configuredRoleNames(target) {
  const config = await readJson(roleConfigPath(target));
  const errors = roleConfigErrors(config);
  if (errors.length) throw new Error(`Invalid advisor role configuration:\n- ${errors.join("\n- ")}`);
  return Object.keys(config.profiles);
}

export async function inferProfileName(target, live) {
  const bytes = live ?? await readFile(liveGuidePath(target));
  for (const name of await listProfileNames(target)) {
    const candidate = await readFile(join(profileDir(target), `${name}.json`));
    if (Buffer.compare(bytes, candidate) === 0) return name;
  }
  return undefined;
}

export async function activeSelectionStatus(target) {
  const errors = [];
  let names;
  try {
    names = await listProfileNames(target);
  } catch (error) {
    return {
      pointer: await readActivePointer(target),
      liveMatch: undefined,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const pointer = await readActivePointer(target);
  if (pointer.status === "missing") {
    errors.push("Missing active intelligence profile pointer: intelligence-profiles/ACTIVE");
  } else if (pointer.status === "empty") {
    errors.push("Active intelligence profile pointer is empty: intelligence-profiles/ACTIVE");
  } else if (!names.includes(pointer.name)) {
    errors.push(`ACTIVE names unknown installed intelligence profile: ${pointer.name}`);
  }

  let live;
  try {
    live = await readFile(liveGuidePath(target));
  } catch (error) {
    if (error.code === "ENOENT") {
      const suffix = pointer.status === "named" ? ` (ACTIVE names ${pointer.name})` : "";
      errors.push(`Missing live advisor intelligence guide: advisor-intelligence.json${suffix}`);
    } else {
      throw error;
    }
  }

  const liveMatch = live ? await inferProfileName(target, live) : undefined;
  if (live && pointer.status === "named" && names.includes(pointer.name)) {
    const selected = await readFile(join(profileDir(target), `${pointer.name}.json`));
    if (Buffer.compare(live, selected) !== 0) {
      const detail = liveMatch
        ? `advisor-intelligence.json matches ${liveMatch}`
        : "advisor-intelligence.json matches no installed named profile";
      errors.push(`Active intelligence profile mismatch: ACTIVE names ${pointer.name}, but ${detail}`);
    }
  }

  return { pointer, liveMatch, names, errors };
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
  const roles = await configuredRoleNames(target);
  const errors = intelligenceGuideErrors(parsed, roles);
  if (parsed.name !== name) errors.unshift(`Profile name ${parsed.name} does not match file name ${name}`);
  if (errors.length) throw new Error(`Invalid profile ${name}:\n- ${errors.join("\n- ")}`);

  const live = liveGuidePath(target);
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

export async function materializeProfile(target, name = DEFAULT_PROFILE) {
  return applyNamedProfile(target, name, { backupLive: false });
}

export async function statusLines(target) {
  const names = await listProfileNames(target);
  const selection = await activeSelectionStatus(target);
  const recorded = selection.pointer.status === "named" ? selection.pointer.name : `(${selection.pointer.status})`;
  const active = selection.liveMatch ?? "custom/unmatched";
  const lines = [
    `Target: ${target}`,
    `Active file: ${recorded}`,
    `Live guide matches: ${active}`,
    `Profiles: ${names.join(", ")}`,
  ];
  for (const error of selection.errors) lines.push(`Integrity error: ${error}`);
  if (selection.liveMatch) {
    const guide = await readJson(join(profileDir(target), `${selection.liveMatch}.json`));
    for (const [role, choices] of Object.entries(guide.recommendations)) {
      const preferred = choices[0];
      lines.push(`Preferred ${role}: ${preferred.model} (${preferred.thinking}) — ${preferred.fit}`);
    }
  }
  lines.push("The fixed bg_agent role configuration is unchanged. Recommendations guide subsequent advisor choices but do not restrict launches.");
  lines.push("This session's /model and already-running workers are unchanged.");
  return lines;
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
