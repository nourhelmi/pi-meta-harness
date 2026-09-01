import { basename, dirname, resolve } from "node:path";

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function validatedSkillNames(value, label) {
  if (!Array.isArray(value) || value.some((skill) => typeof skill !== "string" || !SKILL_NAME_PATTERN.test(skill))) {
    throw new Error(`${label} contains an unsafe skill name`);
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) throw new Error(`${label} contains duplicate skill names`);
  return unique;
}

export function skillDestination(root, skill) {
  const safeRoot = resolve(root);
  if (!SKILL_NAME_PATTERN.test(skill)) throw new Error(`Unsafe skill name: ${skill}`);
  const destination = resolve(safeRoot, skill);
  if (dirname(destination) !== safeRoot || basename(destination) !== skill) {
    throw new Error(`Skill destination escapes its root: ${skill}`);
  }
  return destination;
}
