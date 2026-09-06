const STATUSES = new Set(["open", "pending", "closed"]);

function positiveInteger(params, key, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!params.has(key)) return fallback;
  const raw = params.get(key);
  if (!/^\d+$/.test(raw)) throw new RangeError(`Invalid ${key}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`Invalid ${key}`);
  return value;
}

export function parseQuery(params) {
  const status = params.get("status") || undefined;
  if (status && !STATUSES.has(status)) throw new RangeError("Invalid status");
  const sort = params.get("sort") ?? "newest";
  if (sort !== "newest" && sort !== "oldest") throw new RangeError("Invalid sort");
  return {
    q: params.get("q") ?? "",
    status,
    tags: params.has("tag") ? [params.get("tag")] : [],
    sort,
    page: positiveInteger(params, "page", 1),
    pageSize: positiveInteger(params, "pageSize", 20, 50),
  };
}
