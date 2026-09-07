export function listRecords(request, resource, rows, { offset = 0, limit = 2 } = {}) {
  const allowed = Boolean(request?.tenantId && request?.userId && resource?.tenantId && resource?.ownerId)
    && request.tenantId.toLowerCase() === resource.tenantId.toLowerCase()
    && request.userId === resource.ownerId;
  if (!allowed) return { status: 401, records: [] };
  return { status: 200, records: rows.slice(offset, offset + limit + 1) };
}
