import { constants, type Stats } from "node:fs";
import {
  lstat as nodeLstat,
  open as nodeOpen,
  readdir as nodeReaddir,
  realpath as nodeRealpath,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  stateRootSettingSchema,
  TRACE_FILE_MAX,
  TRACE_FILE_MAX_BYTES,
  TRACE_FILE_NAME_PATTERN,
  TRACE_LINE_MAX_BYTES,
  TRACE_RECORD_MAX,
  type TraceDetail,
  type TraceDetailResponse,
  type TraceListResponse,
  type TraceReadError,
  type TraceSummary,
} from "./contracts.js";
import {
  parseTrace,
  projectTrace,
  validateTrace,
  validationProblemsFromEvents,
} from "./trace-projector.js";

interface DirectoryEntry {
  readonly name: string;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ReadOnlyFileHandle {
  stat(): Promise<Stats>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface TraceFileSystem {
  readonly noFollowFlag: number | undefined;
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<readonly DirectoryEntry[]>;
  open(path: string, flags: number): Promise<ReadOnlyFileHandle>;
}

const nodeFileSystem: TraceFileSystem = {
  noFollowFlag:
    typeof constants.O_NOFOLLOW === "number" && constants.O_NOFOLLOW !== 0
      ? constants.O_NOFOLLOW
      : undefined,
  lstat: nodeLstat,
  realpath: nodeRealpath,
  async readdir(path) {
    return nodeReaddir(path, { withFileTypes: true });
  },
  open: nodeOpen,
};

class TracePolicyError extends Error {
  readonly code: TraceReadError["code"];
  readonly partial?: boolean;

  constructor(
    code: TraceReadError["code"],
    message: string,
    options: { partial?: boolean; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "TracePolicyError";
    this.code = code;
    this.partial = options.partial;
  }
}

interface TraceDirectorySnapshot {
  readonly rootPath: string;
  readonly rootIdentity: Stats;
  readonly tracesPath: string;
  readonly tracesIdentity: Stats;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function filesystemError(
  error: unknown,
  fallbackCode: TraceReadError["code"],
  message: string,
): TracePolicyError {
  if (
    isNodeError(error) &&
    (error.code === "EACCES" || error.code === "EPERM")
  ) {
    return new TracePolicyError(
      "TRACE_PERMISSION_DENIED",
      `${message}: permission denied`,
      { cause: error },
    );
  }
  return new TracePolicyError(fallbackCode, message, { cause: error });
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new TracePolicyError("REQUEST_ABORTED", "Trace read was cancelled");
  }
}

function toPublicError(error: unknown): TraceReadError {
  if (error instanceof TracePolicyError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "TRACE_READ_FAILED",
    message: error instanceof Error ? error.message : "Trace read failed",
  };
}

async function checkedLstat(
  fs: TraceFileSystem,
  path: string,
  code: TraceReadError["code"],
  message: string,
): Promise<Stats> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    throw filesystemError(error, code, message);
  }
}

async function checkedRealpath(
  fs: TraceFileSystem,
  path: string,
  code: TraceReadError["code"],
  message: string,
): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch (error) {
    throw filesystemError(error, code, message);
  }
}

async function resolveTraceDirectory(
  fs: TraceFileSystem,
  stateRoot: string,
): Promise<TraceDirectorySnapshot> {
  const parsedRoot = stateRootSettingSchema.safeParse(stateRoot);
  if (!parsedRoot.success) {
    throw new TracePolicyError(
      "INVALID_CONFIGURATION",
      parsedRoot.error.issues[0]?.message ?? "Invalid advisor state root",
    );
  }
  if (fs.noFollowFlag === undefined) {
    throw new TracePolicyError(
      "NOFOLLOW_UNAVAILABLE",
      "This host cannot prove O_NOFOLLOW descriptor identity",
    );
  }

  const configuredRoot = parsedRoot.data;
  const configuredRootStats = await checkedLstat(
    fs,
    configuredRoot,
    "ROOT_UNAVAILABLE",
    "Configured advisor state root is unavailable",
  );
  if (configuredRootStats.isSymbolicLink()) {
    throw new TracePolicyError(
      "ROOT_SYMLINK",
      "Configured advisor state root must not be a symlink",
    );
  }
  if (!configuredRootStats.isDirectory()) {
    throw new TracePolicyError(
      "ROOT_NOT_DIRECTORY",
      "Configured advisor state root is not a directory",
    );
  }
  const realRoot = await checkedRealpath(
    fs,
    configuredRoot,
    "ROOT_UNAVAILABLE",
    "Configured advisor state root cannot be resolved",
  );
  const realRootStats = await checkedLstat(
    fs,
    realRoot,
    "ROOT_UNAVAILABLE",
    "Resolved advisor state root is unavailable",
  );
  if (
    !realRootStats.isDirectory() ||
    realRootStats.isSymbolicLink() ||
    !sameIdentity(configuredRootStats, realRootStats)
  ) {
    throw new TracePolicyError(
      "ROOT_IDENTITY_DRIFT",
      "Configured advisor state root identity cannot be proven",
    );
  }

  const tracesPath = join(realRoot, "traces");
  const tracesStats = await checkedLstat(
    fs,
    tracesPath,
    "TRACES_UNAVAILABLE",
    "Canonical traces directory is unavailable",
  );
  if (tracesStats.isSymbolicLink()) {
    throw new TracePolicyError(
      "TRACES_SYMLINK",
      "Canonical traces directory must not be a symlink",
    );
  }
  if (!tracesStats.isDirectory()) {
    throw new TracePolicyError(
      "TRACES_NOT_DIRECTORY",
      "Canonical traces path is not a directory",
    );
  }
  const realTraces = await checkedRealpath(
    fs,
    tracesPath,
    "TRACES_UNAVAILABLE",
    "Canonical traces directory cannot be resolved",
  );
  const realTracesStats = await checkedLstat(
    fs,
    realTraces,
    "TRACES_UNAVAILABLE",
    "Resolved canonical traces directory is unavailable",
  );
  if (
    realTraces !== tracesPath ||
    !realTracesStats.isDirectory() ||
    realTracesStats.isSymbolicLink() ||
    !sameIdentity(tracesStats, realTracesStats)
  ) {
    throw new TracePolicyError(
      "TRACES_IDENTITY_DRIFT",
      "Canonical traces directory identity cannot be proven",
    );
  }

  return {
    rootPath: realRoot,
    rootIdentity: realRootStats,
    tracesPath: realTraces,
    tracesIdentity: realTracesStats,
  };
}

async function assertDirectoryStable(
  fs: TraceFileSystem,
  snapshot: TraceDirectorySnapshot,
): Promise<void> {
  const rootStats = await checkedLstat(
    fs,
    snapshot.rootPath,
    "ROOT_UNAVAILABLE",
    "Advisor state root disappeared during the trace read",
  );
  if (
    rootStats.isSymbolicLink() ||
    !rootStats.isDirectory() ||
    !sameIdentity(snapshot.rootIdentity, rootStats)
  ) {
    throw new TracePolicyError(
      "ROOT_IDENTITY_DRIFT",
      "Advisor state root identity changed during the trace read",
    );
  }
  const rootRealpath = await checkedRealpath(
    fs,
    snapshot.rootPath,
    "ROOT_UNAVAILABLE",
    "Advisor state root disappeared during the trace read",
  );
  if (rootRealpath !== snapshot.rootPath) {
    throw new TracePolicyError(
      "ROOT_IDENTITY_DRIFT",
      "Advisor state root real path changed during the trace read",
    );
  }

  const tracesStats = await checkedLstat(
    fs,
    snapshot.tracesPath,
    "TRACES_UNAVAILABLE",
    "Canonical traces directory disappeared during the trace read",
  );
  if (
    tracesStats.isSymbolicLink() ||
    !tracesStats.isDirectory() ||
    !sameIdentity(snapshot.tracesIdentity, tracesStats)
  ) {
    throw new TracePolicyError(
      "TRACES_IDENTITY_DRIFT",
      "Canonical traces directory identity changed during the trace read",
    );
  }
  const tracesRealpath = await checkedRealpath(
    fs,
    snapshot.tracesPath,
    "TRACES_UNAVAILABLE",
    "Canonical traces directory disappeared during the trace read",
  );
  if (tracesRealpath !== snapshot.tracesPath) {
    throw new TracePolicyError(
      "TRACES_IDENTITY_DRIFT",
      "Canonical traces directory real path changed during the trace read",
    );
  }
}

async function readDescriptorSnapshot(
  fs: TraceFileSystem,
  directory: TraceDirectorySnapshot,
  fileName: string,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  if (
    !TRACE_FILE_NAME_PATTERN.test(fileName) ||
    basename(fileName) !== fileName
  ) {
    throw new TracePolicyError(
      "TRACE_NAME_INVALID",
      "Selected trace name is not a direct canonical .jsonl filename",
    );
  }
  assertNotAborted(signal);
  const filePath = join(directory.tracesPath, fileName);
  const before = await checkedLstat(
    fs,
    filePath,
    "TRACE_DISAPPEARED",
    `Trace ${fileName} is no longer available`,
  );
  if (before.isSymbolicLink()) {
    throw new TracePolicyError(
      "TRACE_SYMLINK",
      `Trace ${fileName} must not be a symlink`,
    );
  }
  if (!before.isFile()) {
    throw new TracePolicyError(
      "TRACE_NOT_REGULAR",
      `Trace ${fileName} is not a regular file`,
    );
  }
  if (before.size > TRACE_FILE_MAX_BYTES) {
    throw new TracePolicyError(
      "TRACE_TOO_LARGE",
      `Trace ${fileName} exceeds the 4 MiB limit`,
    );
  }
  const realFile = await checkedRealpath(
    fs,
    filePath,
    "TRACE_DISAPPEARED",
    `Trace ${fileName} disappeared before it could be opened`,
  );
  if (dirname(realFile) !== directory.tracesPath || realFile !== filePath) {
    throw new TracePolicyError(
      "TRACE_OUTSIDE_DIRECTORY",
      `Trace ${fileName} is not contained directly in the canonical traces directory`,
    );
  }

  let handle: ReadOnlyFileHandle;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY | (fs.noFollowFlag ?? 0),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new TracePolicyError(
        "TRACE_SYMLINK",
        `Trace ${fileName} became a symlink before it could be opened`,
        { cause: error },
      );
    }
    throw filesystemError(
      error,
      "TRACE_DISAPPEARED",
      `Trace ${fileName} disappeared before it could be opened`,
    );
  }

  let closeError: unknown;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new TracePolicyError(
        "TRACE_IDENTITY_DRIFT",
        `Trace ${fileName} identity changed while it was opened`,
      );
    }
    if (opened.size < before.size) {
      throw new TracePolicyError(
        "TRACE_SHRANK",
        `Trace ${fileName} shrank before its snapshot was captured`,
      );
    }
    if (opened.size > TRACE_FILE_MAX_BYTES) {
      throw new TracePolicyError(
        "TRACE_TOO_LARGE",
        `Trace ${fileName} exceeds the 4 MiB limit`,
      );
    }
    const capturedSize = opened.size;
    const bytes = Buffer.alloc(capturedSize);
    let offset = 0;
    while (offset < capturedSize) {
      assertNotAborted(signal);
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(64 * 1024, capturedSize - offset),
        offset,
      );
      if (bytesRead <= 0) {
        throw new TracePolicyError(
          "TRACE_SHRANK",
          `Trace ${fileName} shrank while its descriptor was being read`,
        );
      }
      offset += bytesRead;
    }
    assertNotAborted(signal);

    const descriptorAfter = await handle.stat();
    if (!descriptorAfter.isFile() || !sameIdentity(opened, descriptorAfter)) {
      throw new TracePolicyError(
        "TRACE_IDENTITY_DRIFT",
        `Trace ${fileName} descriptor identity changed during the read`,
      );
    }
    if (descriptorAfter.size < capturedSize) {
      throw new TracePolicyError(
        "TRACE_SHRANK",
        `Trace ${fileName} shrank during the read`,
      );
    }
    if (descriptorAfter.size > TRACE_FILE_MAX_BYTES) {
      throw new TracePolicyError(
        "TRACE_TOO_LARGE",
        `Trace ${fileName} exceeded the 4 MiB limit during the read`,
      );
    }

    const pathAfter = await checkedLstat(
      fs,
      filePath,
      "TRACE_DISAPPEARED",
      `Trace ${fileName} disappeared during the read`,
    );
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameIdentity(opened, pathAfter)
    ) {
      throw new TracePolicyError(
        "TRACE_IDENTITY_DRIFT",
        `Trace ${fileName} was replaced during the read`,
      );
    }
    if (pathAfter.size < capturedSize) {
      throw new TracePolicyError(
        "TRACE_SHRANK",
        `Trace ${fileName} shrank during the read`,
      );
    }
    if (pathAfter.size > TRACE_FILE_MAX_BYTES) {
      throw new TracePolicyError(
        "TRACE_TOO_LARGE",
        `Trace ${fileName} exceeded the 4 MiB limit during the read`,
      );
    }
    const realFileAfter = await checkedRealpath(
      fs,
      filePath,
      "TRACE_DISAPPEARED",
      `Trace ${fileName} disappeared during the read`,
    );
    if (
      realFileAfter !== filePath ||
      dirname(realFileAfter) !== directory.tracesPath
    ) {
      throw new TracePolicyError(
        "TRACE_OUTSIDE_DIRECTORY",
        `Trace ${fileName} escaped the canonical traces directory during the read`,
      );
    }
    await assertDirectoryStable(fs, directory);
    return bytes;
  } catch (error) {
    if (error instanceof TracePolicyError) throw error;
    throw filesystemError(
      error,
      "TRACE_READ_FAILED",
      `Trace ${fileName} could not be read safely`,
    );
  } finally {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
    if (closeError !== undefined) {
      throw filesystemError(
        closeError,
        "TRACE_READ_FAILED",
        `Trace ${fileName} descriptor could not be closed`,
      );
    }
  }
}

function parseSnapshot(
  fileName: string,
  bytes: Buffer,
): { partial: boolean; detail: TraceDetail } {
  const lastNewline = bytes.lastIndexOf(0x0a);
  const partial = bytes.length > 0 && lastNewline !== bytes.length - 1;
  if (lastNewline < 0) {
    throw new TracePolicyError(
      "NO_COMPLETE_EVENT",
      `Trace ${fileName} has no complete newline-terminated event`,
      { partial },
    );
  }
  const completeBytes = bytes.subarray(0, lastNewline + 1);
  const tailBytes = bytes.subarray(lastNewline + 1);
  if (tailBytes.length > TRACE_LINE_MAX_BYTES) {
    throw new TracePolicyError(
      "LINE_TOO_LARGE",
      `Trace ${fileName} has an unterminated line over 256 KiB`,
      { partial },
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      tailBytes,
      { stream: true },
    );
  } catch (error) {
    throw new TracePolicyError(
      "INVALID_UTF8",
      `Trace ${fileName} contains invalid UTF-8 in the unterminated tail`,
      { partial, cause: error },
    );
  }
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < completeBytes.length; index += 1) {
    if (completeBytes[index] !== 0x0a) continue;
    const lineBytes = completeBytes.subarray(lineStart, index);
    if (lineBytes.length > TRACE_LINE_MAX_BYTES) {
      throw new TracePolicyError(
        "LINE_TOO_LARGE",
        `Trace ${fileName} has a complete line over 256 KiB`,
        { partial },
      );
    }
    try {
      lines.push(decoder.decode(lineBytes));
    } catch (error) {
      throw new TracePolicyError(
        "INVALID_UTF8",
        `Trace ${fileName} contains invalid UTF-8 in a complete event`,
        { partial, cause: error },
      );
    }
    lineStart = index + 1;
  }
  const records = lines.filter((line) => line.trim().length > 0);
  if (records.length === 0) {
    throw new TracePolicyError(
      "NO_COMPLETE_EVENT",
      `Trace ${fileName} has no complete event`,
      { partial },
    );
  }
  if (records.length > TRACE_RECORD_MAX) {
    throw new TracePolicyError(
      "RECORD_LIMIT",
      `Trace ${fileName} exceeds 4096 complete records`,
      { partial },
    );
  }

  let events;
  try {
    events = parseTrace(`${lines.join("\n")}\n`);
  } catch (error) {
    throw new TracePolicyError(
      "MALFORMED_JSON",
      `Trace ${fileName} has malformed complete JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { partial, cause: error },
    );
  }
  const validation = validateTrace(events);
  if (!validation.ok) {
    const shown = validation.problems
      .slice(0, 4)
      .map(
        (problem) => `${problem.code} seq ${problem.seq}: ${problem.message}`,
      )
      .join("; ");
    const remaining = validation.problems.length - 4;
    throw new TracePolicyError(
      "INVALID_TRACE",
      `Trace ${fileName} failed canonical validation: ${shown}${
        remaining > 0 ? `; ${remaining} more problem(s)` : ""
      }`,
      { partial },
    );
  }
  const projection = projectTrace(events);
  if (projection.run === null) {
    throw new TracePolicyError(
      "NO_COMPLETE_EVENT",
      `Trace ${fileName} has no projectable run`,
      { partial },
    );
  }
  return {
    partial,
    detail: {
      fileName,
      partial,
      projection,
      validationProblems: validationProblemsFromEvents(events),
    },
  };
}

async function readTraceFromDirectory(
  fs: TraceFileSystem,
  directory: TraceDirectorySnapshot,
  fileName: string,
  signal: AbortSignal | undefined,
): Promise<TraceDetailResponse> {
  try {
    const bytes = await readDescriptorSnapshot(fs, directory, fileName, signal);
    const { detail } = parseSnapshot(fileName, bytes);
    return { ok: true, trace: detail };
  } catch (error) {
    const partial =
      error instanceof TracePolicyError ? error.partial : undefined;
    return {
      ok: false,
      ...(TRACE_FILE_NAME_PATTERN.test(fileName) ? { fileName } : {}),
      ...(partial === undefined ? {} : { partial }),
      error: toPublicError(error),
    };
  }
}

function summarizeTrace(
  response: TraceDetailResponse,
  fileName: string,
): TraceSummary {
  if (!response.ok) {
    return {
      ok: false,
      fileName,
      ...(response.partial === undefined ? {} : { partial: response.partial }),
      error: response.error,
    };
  }
  const { projection, partial } = response.trace;
  const run = projection.run!;
  return {
    ok: true,
    fileName,
    partial,
    runId: run.id,
    host: run.host,
    workstream: run.workstream,
    lastState: projection.nodes.at(-1)?.state ?? "created",
    lastAt: run.lastAt,
  };
}

export function createTraceStore(fs: TraceFileSystem = nodeFileSystem) {
  return {
    async listTraces(
      stateRoot: string,
      signal?: AbortSignal,
    ): Promise<TraceListResponse> {
      try {
        assertNotAborted(signal);
        const directory = await resolveTraceDirectory(fs, stateRoot);
        let entries: readonly DirectoryEntry[];
        try {
          entries = await fs.readdir(directory.tracesPath);
        } catch (error) {
          throw filesystemError(
            error,
            "TRACES_UNAVAILABLE",
            "Canonical traces directory cannot be listed",
          );
        }
        const matchingNames = entries
          .filter((entry) => TRACE_FILE_NAME_PATTERN.test(entry.name))
          .map((entry) => entry.name)
          .sort((left, right) => left.localeCompare(right));
        if (matchingNames.length > TRACE_FILE_MAX) {
          throw new TracePolicyError(
            "TRACE_FILE_LIMIT",
            "Canonical traces directory contains more than 256 matching files",
          );
        }

        const traces: TraceSummary[] = [];
        for (const fileName of matchingNames) {
          assertNotAborted(signal);
          const entry = entries.find(
            (candidate) => candidate.name === fileName,
          )!;
          if (entry.isSymbolicLink() || !entry.isFile()) continue;
          const response = await readTraceFromDirectory(
            fs,
            directory,
            fileName,
            signal,
          );
          traces.push(summarizeTrace(response, fileName));
        }
        await assertDirectoryStable(fs, directory);
        return { ok: true, traces };
      } catch (error) {
        return { ok: false, error: toPublicError(error) };
      }
    },

    async readTrace(
      stateRoot: string,
      fileName: string,
      signal?: AbortSignal,
    ): Promise<TraceDetailResponse> {
      try {
        assertNotAborted(signal);
        const directory = await resolveTraceDirectory(fs, stateRoot);
        return await readTraceFromDirectory(fs, directory, fileName, signal);
      } catch (error) {
        return {
          ok: false,
          ...(TRACE_FILE_NAME_PATTERN.test(fileName) ? { fileName } : {}),
          error: toPublicError(error),
        };
      }
    },
  };
}

export const traceStore = createTraceStore();
