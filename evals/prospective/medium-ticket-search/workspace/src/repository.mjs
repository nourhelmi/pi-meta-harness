export function findTickets(records, query) {
  const direction = query.sort === "oldest" ? 1 : -1;
  const ordered = records.sort((left, right) => direction * left.updatedAt.localeCompare(right.updatedAt));
  return ordered.filter((ticket) => {
    if (query.q && !ticket.title.includes(query.q)) return false;
    if (query.status && ticket.status !== query.status) return false;
    if (query.tags.length && !query.tags.some((tag) => ticket.tags.includes(tag))) return false;
    return true;
  });
}
