import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createWakeAdmissionStore } from "../src/wake-admission.js";

describe("wake admission", () => {
  it("admits one common-path claimant, keeps run binding, and reconstructs ambiguity as unknown", () => {
    const db = new Database(":memory:");
    const store = createWakeAdmissionStore(db);
    expect(store.admit("p", "g", "r")).toEqual({ state: "claimed", admitted: true });
    expect(store.admit("p", "g", "r")).toEqual({ state: "claimed", admitted: false });
    expect(() => store.admit("p", "g", "other-run")).toThrow(/another run/);
    expect(createWakeAdmissionStore(db).reconcileClaimed()).toBe(1);
    expect(store.list()).toEqual([{ logicalParentThreadId: "p", settlementGeneration: "g", runId: "r", state: "unknown" }]);
    expect(store.retry("p", "g")).toBe(true);
    expect(store.admit("p", "g", "r")).toEqual({ state: "claimed", admitted: true });
    store.mark("p", "g", "sent");
    expect(store.admit("p", "g", "r")).toEqual({ state: "sent", admitted: false });
  });

  it("requires explicit operator disposition for unknown admission", () => {
    const store = createWakeAdmissionStore(new Database(":memory:"));
    store.admit("p", "retry", "r");
    store.mark("p", "retry", "unknown");
    expect(store.retry("p", "retry")).toBe(true);
    expect(store.retry("p", "retry")).toBe(false);
    store.admit("p", "skip", "r");
    store.mark("p", "skip", "unknown");
    expect(store.skip("p", "skip")).toBe(true);
	expect(store.admit("p", "skip", "r")).toEqual({ state: "unknown", admitted: false });
	expect(store.retry("p", "skip")).toBe(false);
	expect(store.list()).toContainEqual(expect.objectContaining({ logicalParentThreadId: "p", settlementGeneration: "skip", state: "unknown", operatorSkippedAt: expect.any(Number) }));
  });
});
