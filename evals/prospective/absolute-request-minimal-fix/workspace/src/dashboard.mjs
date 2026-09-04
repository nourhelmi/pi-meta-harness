/** Dashboard card for the active note. */
export function dashboardCard(note) {
  return { title: note.title, description: note.description ?? "" };
}
