import type Database from "better-sqlite3";

export type WakeState = "pending" | "claimed" | "sent" | "unknown";
export interface WakeAdmission { logicalParentThreadId: string; settlementGeneration: string; runId: string; state: WakeState; operatorSkippedAt?: number }
export const wakeMigrations = [{ id: "002-wakes", sql: `CREATE TABLE IF NOT EXISTS meta_harness_wake_admission (
  logical_parent_thread_id TEXT NOT NULL, settlement_generation TEXT NOT NULL, run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','sent','unknown')), operator_skipped_at INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY(logical_parent_thread_id, settlement_generation)
);` }] as const;

export function createWakeAdmissionStore(db: Database.Database) {
  for (const migration of wakeMigrations) db.exec(migration.sql);
  return {
		admit(parent: string, generation: string, runId: string): { state: WakeState; admitted: boolean } {
			db.prepare("INSERT OR IGNORE INTO meta_harness_wake_admission(logical_parent_thread_id,settlement_generation,run_id,state,operator_skipped_at,updated_at) VALUES(?,?,?,?,NULL,?)").run(parent, generation, runId, "pending", Date.now());
			const existing = db.prepare("SELECT run_id,state FROM meta_harness_wake_admission WHERE logical_parent_thread_id=? AND settlement_generation=?").get(parent, generation) as { run_id: string; state: WakeState };
			if (existing.run_id !== runId) throw new Error("settlement generation is already bound to another run");
			const claim = db.prepare("UPDATE meta_harness_wake_admission SET state='claimed',updated_at=? WHERE logical_parent_thread_id=? AND settlement_generation=? AND state='pending'").run(Date.now(), parent, generation);
      return claim.changes === 1
        ? { state: "claimed", admitted: true }
        : { state: (db.prepare("SELECT state FROM meta_harness_wake_admission WHERE logical_parent_thread_id=? AND settlement_generation=?").get(parent, generation) as { state: WakeState }).state, admitted: false };
    },
    mark(parent: string, generation: string, state: Extract<WakeState, "sent" | "unknown">): void {
	  db.prepare("UPDATE meta_harness_wake_admission SET state=?,operator_skipped_at=NULL,updated_at=? WHERE logical_parent_thread_id=? AND settlement_generation=? AND state='claimed'").run(state, Date.now(), parent, generation);
    },
    reconcileClaimed(): number {
      return db.prepare("UPDATE meta_harness_wake_admission SET state='unknown',updated_at=? WHERE state='claimed'").run(Date.now()).changes;
    },
		retry(parent: string, generation: string): boolean { return db.prepare("UPDATE meta_harness_wake_admission SET state='pending',updated_at=? WHERE logical_parent_thread_id=? AND settlement_generation=? AND state='unknown' AND operator_skipped_at IS NULL").run(Date.now(), parent, generation).changes === 1; },
		skip(parent: string, generation: string): boolean { const now = Date.now(); return db.prepare("UPDATE meta_harness_wake_admission SET operator_skipped_at=?,updated_at=? WHERE logical_parent_thread_id=? AND settlement_generation=? AND state='unknown' AND operator_skipped_at IS NULL").run(now, now, parent, generation).changes === 1; },
		list(): WakeAdmission[] {
			return (db.prepare("SELECT logical_parent_thread_id,settlement_generation,run_id,state,operator_skipped_at FROM meta_harness_wake_admission ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>).map((row) => ({ logicalParentThreadId: String(row.logical_parent_thread_id), settlementGeneration: String(row.settlement_generation), runId: String(row.run_id), state: row.state as WakeState, ...(row.operator_skipped_at ? { operatorSkippedAt: Number(row.operator_skipped_at) } : {}) }));
    },
  };
}
