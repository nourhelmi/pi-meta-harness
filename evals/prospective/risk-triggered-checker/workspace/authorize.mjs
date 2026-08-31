export function canRead(request, resource) {
  return resource.tenantId === request.tenantId || resource.ownerId === request.userId;
}
