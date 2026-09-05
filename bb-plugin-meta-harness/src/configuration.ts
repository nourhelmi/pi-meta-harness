const CONTROL_CHARACTER = /\p{Cc}/u;
const NON_PRINTING_CHARACTER = /[\p{C}\p{Zl}\p{Zp}]/u;
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/u;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function hostIdProblem(value: string): string | null {
  if (value.trim().length === 0 || NON_PRINTING_CHARACTER.test(value)) {
    return "Host id must be a nonempty printable identifier";
  }
  if (utf8ByteLength(value) > 128) {
    return "Host id must be at most 128 UTF-8 bytes";
  }
  return null;
}

export function stateRootContentProblem(value: string): string | null {
  if (CONTROL_CHARACTER.test(value)) {
    return "Advisor state root must not contain control characters";
  }
  if (utf8ByteLength(value) > 4096) {
    return "Advisor state root must be at most 4096 UTF-8 bytes";
  }
  return null;
}

export function hasValidConfiguration(
  hostId: unknown,
  stateRoot: unknown,
): boolean {
  const looksAbsolute =
    typeof stateRoot === "string" &&
    (stateRoot.startsWith("/") ||
      stateRoot.startsWith("\\") ||
      WINDOWS_DRIVE_ROOT.test(stateRoot));
  return (
    typeof hostId === "string" &&
    typeof stateRoot === "string" &&
    hostIdProblem(hostId) === null &&
    looksAbsolute &&
    stateRootContentProblem(stateRoot) === null
  );
}
