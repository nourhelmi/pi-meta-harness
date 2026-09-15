export function withLegacyRunOwnership<T>(
  root: string,
  run: string,
  action: () => Promise<T> | T,
): Promise<T>;

export function canonicalLocation(path: string): string;
export function artifactRead(root: string, name: string): { text: string; bytes: number; nextOffset: number; eof: boolean };
