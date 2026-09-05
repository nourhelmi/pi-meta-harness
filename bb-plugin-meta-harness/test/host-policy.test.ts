import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TRACE_FILE_MAX_BYTES,
  TRACE_LINE_MAX_BYTES,
  TRACE_RECORD_MAX,
} from "../src/contracts.js";
import {
  createTraceStore,
  type ReadOnlyFileHandle,
  type TraceFileSystem,
} from "../src/trace-policy.js";
import { asJsonl, syntheticDoneEvents, withRunId } from "./fixtures.js";

const metaRoot = resolve(import.meta.dirname, "../..");
const doneFixturePath = resolve(
  metaRoot,
  "config/advisor-core/fixtures/one-worker-done.jsonl",
);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function baseFileSystem(
  overrides: Partial<TraceFileSystem> = {},
): TraceFileSystem {
  return {
    noFollowFlag: constants.O_NOFOLLOW,
    lstat,
    realpath,
    async readdir(path) {
      return readdir(path, { withFileTypes: true });
    },
    open,
    ...overrides,
  };
}

describe("fail-closed canonical trace file policy", () => {
  let stateRoot: string;
  let tracesPath: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "bb-trace-policy-"));
    tracesPath = join(stateRoot, "traces");
    await mkdir(tracesPath);
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  async function writeTrace(
    fileName = "valid.jsonl",
    content = asJsonl(syntheticDoneEvents()),
  ): Promise<string> {
    const path = join(tracesPath, fileName);
    await writeFile(path, content);
    return path;
  }

  it("reads and lists only direct regular canonical files without mutation", async () => {
    const path = await writeTrace();
    const before = sha256(await readFile(path));
    await writeFile(join(tracesPath, "notes.txt"), "not a trace");
    await mkdir(join(tracesPath, "nested.jsonl"));
    await symlink(path, join(tracesPath, "linked.jsonl"));

    const store = createTraceStore();
    const listed = await store.listTraces(stateRoot);
    expect(listed).toMatchObject({
      ok: true,
      traces: [
        {
          ok: true,
          fileName: "valid.jsonl",
          runId: "synthetic-run-1",
          host: "codex",
          workstream: "surface-test",
          lastState: "settled",
        },
      ],
    });
    const detail = await store.readTrace(stateRoot, "valid.jsonl");
    expect(detail).toMatchObject({
      ok: true,
      trace: {
        partial: false,
        validationProblems: {
          "builder-1": ["Evidence section is terse"],
        },
      },
    });
    expect(sha256(await readFile(path))).toBe(before);
  });

  it("rejects traversal, root/traces/file symlinks, and nonregular files", async () => {
    const store = createTraceStore();
    await writeTrace();
    expect(await store.readTrace(stateRoot, "../outside.jsonl")).toMatchObject({
      ok: false,
      error: { code: "TRACE_NAME_INVALID" },
    });

    const rootLink = `${stateRoot}-link`;
    await symlink(stateRoot, rootLink);
    try {
      expect(await store.listTraces(rootLink)).toMatchObject({
        ok: false,
        error: { code: "ROOT_SYMLINK" },
      });
    } finally {
      await unlink(rootLink);
    }

    const tracesRoot = await mkdtemp(join(tmpdir(), "bb-traces-link-"));
    const linkedRoot = await mkdtemp(join(tmpdir(), "bb-traces-owner-"));
    await mkdir(join(linkedRoot, "actual"));
    await symlink(join(linkedRoot, "actual"), join(tracesRoot, "traces"));
    try {
      expect(await store.listTraces(tracesRoot)).toMatchObject({
        ok: false,
        error: { code: "TRACES_SYMLINK" },
      });
    } finally {
      await rm(tracesRoot, { recursive: true, force: true });
      await rm(linkedRoot, { recursive: true, force: true });
    }

    const outside = join(stateRoot, "outside.jsonl");
    await writeFile(outside, asJsonl(syntheticDoneEvents()));
    await symlink(outside, join(tracesPath, "outside-link.jsonl"));
    expect(
      await store.readTrace(stateRoot, "outside-link.jsonl"),
    ).toMatchObject({
      ok: false,
      error: { code: "TRACE_SYMLINK" },
    });

    await mkdir(join(tracesPath, "directory.jsonl"));
    expect(await store.readTrace(stateRoot, "directory.jsonl")).toMatchObject({
      ok: false,
      error: { code: "TRACE_NOT_REGULAR" },
    });
  });

  it("fails closed when O_NOFOLLOW is unavailable", async () => {
    const store = createTraceStore(baseFileSystem({ noFollowFlag: undefined }));
    expect(await store.listTraces(stateRoot)).toMatchObject({
      ok: false,
      error: { code: "NOFOLLOW_UNAVAILABLE" },
    });
  });

  it("rejects invalid UTF-8, malformed JSON, ordering errors, and no complete event", async () => {
    const store = createTraceStore();
    await writeFile(
      join(tracesPath, "utf8.jsonl"),
      Buffer.concat([
        Buffer.from('{"bad":"'),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
      ]),
    );
    expect(await store.readTrace(stateRoot, "utf8.jsonl")).toMatchObject({
      ok: false,
      error: { code: "INVALID_UTF8" },
    });

    await writeTrace("malformed.jsonl", '{"v":}\n');
    expect(await store.readTrace(stateRoot, "malformed.jsonl")).toMatchObject({
      ok: false,
      error: { code: "MALFORMED_JSON" },
    });

    const gap = structuredClone(syntheticDoneEvents());
    gap[2]!.seq = 99;
    await writeTrace("gap.jsonl", asJsonl(gap));
    expect(await store.readTrace(stateRoot, "gap.jsonl")).toMatchObject({
      ok: false,
      error: { code: "INVALID_TRACE" },
    });

    await writeTrace("fragment.jsonl", '{"v":1');
    expect(await store.readTrace(stateRoot, "fragment.jsonl")).toMatchObject({
      ok: false,
      partial: true,
      error: { code: "NO_COMPLETE_EVENT" },
    });
  });

  it("preserves and rejects leading and later-line BOMs without mutation", async () => {
    const events = syntheticDoneEvents();
    const cases = [
      {
        fileName: "leading-bom.jsonl",
        content: events
          .map(
            (event, index) =>
              `${index === 0 ? "\uFEFF" : ""}${JSON.stringify(event)}`,
          )
          .join("\n"),
      },
      {
        fileName: "later-bom.jsonl",
        content: events
          .map(
            (event, index) =>
              `${index === 3 ? "\uFEFF" : ""}${JSON.stringify(event)}`,
          )
          .join("\n"),
      },
    ];

    for (const { fileName, content } of cases) {
      const path = await writeTrace(fileName, `${content}\n`);
      const before = sha256(await readFile(path));
      const response = await createTraceStore().readTrace(stateRoot, fileName);
      expect(response).toMatchObject({
        ok: false,
        error: { code: "MALFORMED_JSON" },
      });
      expect(response).not.toHaveProperty("trace");
      expect(sha256(await readFile(path))).toBe(before);
    }
  });

  it("rejects definitely invalid UTF-8 tails through detail and list reads without mutation", async () => {
    const complete = Buffer.from(asJsonl(syntheticDoneEvents()));
    const cases = [
      { fileName: "tail-ff.jsonl", invalidBytes: Buffer.from([0xff]) },
      {
        fileName: "tail-c0-80-fe.jsonl",
        invalidBytes: Buffer.from([0xc0, 0x80, 0xfe]),
      },
    ];
    const hashes = new Map<string, string>();

    for (const { fileName, invalidBytes } of cases) {
      const path = join(tracesPath, fileName);
      await writeFile(
        path,
        Buffer.concat([
          complete,
          Buffer.from('{"partial":"'),
          invalidBytes,
        ]),
      );
      hashes.set(fileName, sha256(await readFile(path)));
      const response = await createTraceStore().readTrace(stateRoot, fileName);
      expect(response).toMatchObject({
        ok: false,
        partial: true,
        error: { code: "INVALID_UTF8" },
      });
      expect(response).not.toHaveProperty("trace");
      expect(sha256(await readFile(path))).toBe(hashes.get(fileName));
    }

    const listed = await createTraceStore().listTraces(stateRoot);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    for (const { fileName } of cases) {
      const summary = listed.traces.find(
        (candidate) => candidate.fileName === fileName,
      );
      expect(summary).toMatchObject({
        ok: false,
        partial: true,
        error: { code: "INVALID_UTF8" },
      });
      expect(summary).not.toHaveProperty("runId");
      expect(sha256(await readFile(join(tracesPath, fileName)))).toBe(
        hashes.get(fileName),
      );
    }
  });

  it("tolerates a torn terminal multibyte sequence as a partial append without mutation", async () => {
    const path = join(tracesPath, "torn-multibyte.jsonl");
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from(asJsonl(syntheticDoneEvents())),
        Buffer.from('{"note":"'),
        Buffer.from([0xe2, 0x82]),
      ]),
    );
    const before = sha256(await readFile(path));
    const detail = await createTraceStore().readTrace(
      stateRoot,
      "torn-multibyte.jsonl",
    );
    expect(detail).toMatchObject({
      ok: true,
      trace: {
        partial: true,
        projection: { run: { lastSeq: 7 } },
      },
    });
    const listed = await createTraceStore().listTraces(stateRoot);
    expect(listed).toMatchObject({
      ok: true,
      traces: [
        {
          ok: true,
          fileName: "torn-multibyte.jsonl",
          partial: true,
          runId: "synthetic-run-1",
        },
      ],
    });
    expect(sha256(await readFile(path))).toBe(before);
  });

  it("omits one unterminated append fragment and rereads appended events from scratch", async () => {
    const path = await writeTrace(
      "append.jsonl",
      `${asJsonl(syntheticDoneEvents())}{"v":1`,
    );
    const store = createTraceStore();
    const partial = await store.readTrace(stateRoot, "append.jsonl");
    expect(partial).toMatchObject({
      ok: true,
      trace: {
        partial: true,
        projection: { run: { lastSeq: 7 }, nodes: [{ progress: [{}] }] },
      },
    });

    const runningEvents = syntheticDoneEvents().slice(0, 2);
    await writeFile(path, asJsonl(runningEvents));
    expect(await store.readTrace(stateRoot, "append.jsonl")).toMatchObject({
      ok: true,
      trace: { projection: { nodes: [{ state: "running", progress: [] }] } },
    });
    await appendFile(
      path,
      `${JSON.stringify({ ...syntheticDoneEvents()[2], seq: 3 })}\n`,
    );
    expect(await store.readTrace(stateRoot, "append.jsonl")).toMatchObject({
      ok: true,
      trace: {
        projection: {
          run: { lastSeq: 3 },
          nodes: [
            {
              state: "running",
              progress: [{ note: "Descriptor checks passed." }],
            },
          ],
        },
      },
    });
  });

  it("rereads a same-name replacement and never serves the previous projection", async () => {
    const path = await writeTrace("replace.jsonl");
    const store = createTraceStore();
    expect(await store.readTrace(stateRoot, "replace.jsonl")).toMatchObject({
      ok: true,
      trace: { projection: { run: { id: "synthetic-run-1" } } },
    });
    await rename(path, `${path}.old`);
    await writeFile(
      path,
      asJsonl(withRunId(syntheticDoneEvents(), "replacement-run-2")),
    );
    expect(await store.readTrace(stateRoot, "replace.jsonl")).toMatchObject({
      ok: true,
      trace: { projection: { run: { id: "replacement-run-2" } } },
    });
  });

  it("detects disappearance, same-name TOCTOU replacement, shrink, and permission failure", async () => {
    const disappearedPath = await writeTrace("disappear.jsonl");
    const disappearingStore = createTraceStore(
      baseFileSystem({
        async open(path, flags) {
          if (path.endsWith("/disappear.jsonl")) await unlink(path);
          return open(path, flags);
        },
      }),
    );
    expect(
      await disappearingStore.readTrace(stateRoot, "disappear.jsonl"),
    ).toMatchObject({ ok: false, error: { code: "TRACE_DISAPPEARED" } });

    const racePath = await writeTrace("race.jsonl");
    let replaced = false;
    const raceStore = createTraceStore(
      baseFileSystem({
        async open(path, flags) {
          if (path.endsWith("/race.jsonl") && !replaced) {
            replaced = true;
            await rename(path, `${path}.old`);
            await writeFile(
              path,
              asJsonl(withRunId(syntheticDoneEvents(), "race-replacement")),
            );
          }
          return open(path, flags);
        },
      }),
    );
    expect(await raceStore.readTrace(stateRoot, "race.jsonl")).toMatchObject({
      ok: false,
      error: { code: "TRACE_IDENTITY_DRIFT" },
    });

    const shrinkPath = await writeTrace("shrink.jsonl");
    let shrunk = false;
    const shrinkStore = createTraceStore(
      baseFileSystem({
        async open(path, flags): Promise<ReadOnlyFileHandle> {
          const handle = await open(path, flags);
          return {
            stat: () => handle.stat(),
            async read(buffer, offset, length, position) {
              const result = await handle.read(
                buffer,
                offset,
                length,
                position,
              );
              if (path.endsWith("/shrink.jsonl") && !shrunk) {
                shrunk = true;
                await truncate(path, Math.max(0, length - 1));
              }
              return result;
            },
            close: () => handle.close(),
          };
        },
      }),
    );
    expect(
      await shrinkStore.readTrace(stateRoot, "shrink.jsonl"),
    ).toMatchObject({
      ok: false,
      error: { code: "TRACE_SHRANK" },
    });

    const deniedPath = await writeTrace("denied.jsonl");
    const permissionStore = createTraceStore(
      baseFileSystem({
        async lstat(path) {
          if (path.endsWith("/denied.jsonl")) {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          return lstat(path);
        },
      }),
    );
    expect(
      await permissionStore.readTrace(stateRoot, "denied.jsonl"),
    ).toMatchObject({
      ok: false,
      error: { code: "TRACE_PERMISSION_DENIED" },
    });
  });

  it("rejects file, line, record, and directory-count overflow", async () => {
    const store = createTraceStore();
    await writeFile(
      join(tracesPath, "file-overflow.jsonl"),
      Buffer.alloc(TRACE_FILE_MAX_BYTES + 1, 0x20),
    );
    expect(
      await store.readTrace(stateRoot, "file-overflow.jsonl"),
    ).toMatchObject({
      ok: false,
      error: { code: "TRACE_TOO_LARGE" },
    });

    await writeFile(
      join(tracesPath, "line-overflow.jsonl"),
      `${" ".repeat(TRACE_LINE_MAX_BYTES + 1)}\n`,
    );
    expect(
      await store.readTrace(stateRoot, "line-overflow.jsonl"),
    ).toMatchObject({
      ok: false,
      error: { code: "LINE_TOO_LARGE" },
    });

    await writeFile(
      join(tracesPath, "partial-line-overflow.jsonl"),
      `${asJsonl(syntheticDoneEvents())}${"x".repeat(TRACE_LINE_MAX_BYTES + 1)}`,
    );
    expect(
      await store.readTrace(stateRoot, "partial-line-overflow.jsonl"),
    ).toMatchObject({
      ok: false,
      partial: true,
      error: { code: "LINE_TOO_LARGE" },
    });

    await writeFile(
      join(tracesPath, "record-overflow.jsonl"),
      `${Array.from({ length: TRACE_RECORD_MAX + 1 }, () => "{}").join("\n")}\n`,
    );
    expect(
      await store.readTrace(stateRoot, "record-overflow.jsonl"),
    ).toMatchObject({
      ok: false,
      error: { code: "RECORD_LIMIT" },
    });

    await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        writeFile(join(tracesPath, `limit-${index}.jsonl`), ""),
      ),
    );
    expect(await store.listTraces(stateRoot)).toMatchObject({
      ok: false,
      error: { code: "TRACE_FILE_LIMIT" },
    });
  });

  it("reads the repository fixture through the same descriptor path", async () => {
    await writeFile(
      join(tracesPath, "meta-fixture.jsonl"),
      await readFile(doneFixturePath),
    );
    expect(
      await createTraceStore().readTrace(stateRoot, "meta-fixture.jsonl"),
    ).toMatchObject({
      ok: true,
      trace: { projection: { run: { id: "fixture-one-worker-done" } } },
    });
  });
});
