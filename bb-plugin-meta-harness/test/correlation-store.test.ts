import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createCorrelationStore,
  fingerprint,
  tokenHash,
  type LaunchReservation,
} from "../src/correlation-store.js";

function reservation(overrides: Partial<LaunchReservation> = {}): LaunchReservation {
  return {
    runId: "r",
    bootstrapTokenHash: tokenHash("token"),
    requestFingerprint: fingerprint({ runId: "r", prompt: "work" }),
    logicalParentThreadId: "p",
    logicalParentEnvironmentId: "parent-environment",
    graphId: "g",
    nodeId: "n",
    projectId: "project",
    hostId: "h",
    cwd: "/worktree",
    providerId: "pi",
    model: "openai/gpt-5.6",
    reasoning: "high",
    expectedOrigin: "plugin",
    expectedOriginPluginId: "meta-harness",
    expectedVisibility: "visible",
    expectedParentThreadId: null,
    expectedOriginKind: null,
    expectedWorkspaceProvisionType: "unmanaged",
    bootstrapRequired: true,
    state: "reserved",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("correlation store", () => {
  it("stores only reconstructible identity, is unique by run/thread, and claims a thread-bound token once", () => {
    const db = new Database(":memory:");
    const store = createCorrelationStore(db);
    store.insert({ runId: "r", threadId: "t", logicalParentThreadId: "p", graphId: "g", nodeId: "n", hostId: "h", bootstrapTokenHash: tokenHash("token"), createdAt: 1, updatedAt: 1 });
    expect(store.getByRun("r")).toMatchObject({ runId: "r", threadId: "t", logicalParentThreadId: "p", graphId: "g", nodeId: "n", hostId: "h" });
    expect(store.list()).toHaveLength(1);
    expect(Object.keys(store.getByRun("r") ?? {}).sort()).toEqual(["bootstrapTokenHash", "createdAt", "graphId", "hostId", "logicalParentThreadId", "nodeId", "runId", "threadId", "updatedAt"]);
    expect(store.claimBootstrap("token", "wrong")).toBeUndefined();
    expect(store.claimBootstrap("token", "t")?.runId).toBe("r");
    expect(store.claimBootstrap("token", "t")).toBeUndefined();
    expect(createCorrelationStore(db).getByRun("r")?.bootstrapClaimedAt).toEqual(expect.any(Number));
    expect(() => store.insert({ runId: "r", threadId: "t2", logicalParentThreadId: "p", hostId: "h", bootstrapTokenHash: tokenHash("other"), createdAt: 1, updatedAt: 1 })).toThrow();
    expect(() => store.insert({ runId: "r2", threadId: "t", logicalParentThreadId: "p", hostId: "h", bootstrapTokenHash: tokenHash("other-2"), createdAt: 1, updatedAt: 1 })).toThrow();
  });

  it("reserves before launch, stores only the token SHA-256, and atomically binds correlation", () => {
    const db = new Database(":memory:");
    const store = createCorrelationStore(db);
    const first = store.reserve(reservation());
    expect(first.created).toBe(true);
    expect(first.reservation).toMatchObject({
      runId: "r",
      state: "reserved",
      bootstrapTokenHash: tokenHash("token"),
    });
    expect(JSON.stringify(first.reservation)).not.toContain('"token"');

    const duplicate = store.reserve(
      reservation({
        bootstrapTokenHash: tokenHash("discarded-new-token"),
        requestFingerprint: fingerprint({ changed: true }),
      }),
    );
    expect(duplicate).toEqual({ created: false, reservation: first.reservation });

    const binding = store.bind(tokenHash("token"), "thread", "environment");
    expect(binding).toMatchObject({
      kind: "bound",
      reservation: { state: "bound", threadId: "thread", environmentId: "environment" },
      correlation: { runId: "r", threadId: "thread" },
    });
    expect(store.bind(tokenHash("token"), "thread", "environment")).toMatchObject({
      kind: "bound",
    });
    expect(store.bind(tokenHash("token"), "other", "environment")).toMatchObject({
      kind: "thread-mismatch",
    });
    expect(store.listReservations()).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
    expect(() =>
      db.prepare(
        "UPDATE meta_harness_bootstrap_launch_reservation SET model = 'other/model' WHERE run_id = 'r'",
      ).run(),
    ).toThrow(/immutable/u);
    expect(() =>
      db.prepare(
        "DELETE FROM meta_harness_bootstrap_launch_reservation WHERE run_id = 'r'",
      ).run(),
    ).toThrow(/append-only/u);
  });

  it("rolls a failed bind back to reserved with no partial correlation", () => {
    const db = new Database(":memory:");
    const store = createCorrelationStore(db);
    store.reserve(reservation());
    db.exec(`
      CREATE TRIGGER reject_correlation_insert
      BEFORE INSERT ON meta_harness_correlation
      BEGIN
        SELECT RAISE(ABORT, 'correlation denied');
      END;
    `);
    expect(() => store.bind(tokenHash("token"), "thread", "environment")).toThrow(
      /correlation denied/u,
    );
    expect(store.getReservationByRun("r")).toMatchObject({ state: "reserved" });
    expect(store.getByRun("r")).toBeUndefined();
  });
});
