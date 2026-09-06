import { parseQuery } from "./query.mjs";
import { findTickets } from "./repository.mjs";

export function searchTickets(records, params) {
  const query = parseQuery(params);
  const start = (query.page - 1) * query.pageSize;
  const page = records.slice(start, start + query.pageSize);
  const items = findTickets(page, query);
  return {
    items,
    total: items.length,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.ceil(items.length / query.pageSize),
  };
}
