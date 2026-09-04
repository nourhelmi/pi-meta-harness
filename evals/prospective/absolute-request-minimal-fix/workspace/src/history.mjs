import { loadRendererProfile } from "./config.mjs";
import { renderMarkup } from "./render.mjs";

/** History rows render both stored fields through the shared renderer. */
export function historyRow(note) {
  const profile = loadRendererProfile();
  return `${renderMarkup(note.title, profile)} — ${renderMarkup(note.description ?? "", profile)}`;
}
