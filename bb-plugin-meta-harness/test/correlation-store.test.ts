import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createCorrelationStore, tokenHash } from "../src/correlation-store.js";

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
});
