import { readFileSync } from "node:fs";

export const SUPPORTED_PROFILES = ["stars", "caps"];
export const DEFAULT_PROFILE = "caps";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * Read the renderer profile the admin panel persisted in `renderer-config.json`.
 * An unreadable or malformed record keeps the code default so a corrupt store
 * can never select an unknown renderer.
 */
export function loadRendererProfile() {
  let record;
  try {
    record = JSON.parse(readFileSync(new URL("../renderer-config.json", import.meta.url), "utf8"));
  } catch {
    return DEFAULT_PROFILE;
  }
  if (!SUPPORTED_PROFILES.includes(record?.profile) || !ISO_TIMESTAMP.test(String(record?.updatedAt))) {
    return DEFAULT_PROFILE;
  }
  return record.profile;
}
