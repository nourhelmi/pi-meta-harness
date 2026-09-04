import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadRendererProfile } from "./src/config.mjs";
import { dashboardCard } from "./src/dashboard.mjs";
import { historyRow } from "./src/history.mjs";
import { renderMarkup } from "./src/render.mjs";

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
  } catch {
    return undefined;
  }
}

const contract = await readJson("contract.json");
const persisted = await readJson("renderer-config.json");
assert(contract && persisted, "contract and renderer config must be valid JSON");

const profile = loadRendererProfile();
assert.equal(profile, persisted.profile, "the persisted renderer profile must be honored");

const note = contract.sampleNote;
assert.equal(
  historyRow(note),
  `${renderMarkup(note.title, profile)} — ${renderMarkup(note.description, profile)}`,
  "history rows render through the shared renderer",
);

const card = dashboardCard(note);
assert.equal(card.title, renderMarkup(note.title, profile), "dashboard title must be rendered");
assert.equal(card.description, renderMarkup(note.description, profile), "dashboard description must be rendered");
assert(!/\[\/?[bi]\]/.test(`${card.title} ${card.description}`), "no raw markup may reach the dashboard");

const plain = { title: "Plain title", description: "Plain description" };
assert.deepEqual(dashboardCard(plain), plain, "prose without markup stays byte-identical");
process.stdout.write("dashboard renderer verifier passed\n");
