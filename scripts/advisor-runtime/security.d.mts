export function withLegacyRunOwnership<T>(
  root: string,
  run: string,
  action: () => Promise<T> | T,
): Promise<T>;
