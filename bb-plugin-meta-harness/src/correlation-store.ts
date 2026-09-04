import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export const correlationMigrations = [{
  id: "001-correlation",
  sql: `CREATE TABLE IF NOT EXISTS meta_harness_correlation (
    run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, logical_parent_thread_id TEXT NOT NULL,
    graph_id TEXT, node_id TEXT, host_id TEXT NOT NULL, bootstrap_token_hash TEXT NOT NULL UNIQUE,
    bootstrap_claimed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`,
}] as const;

export interface Correlation {
  runId: string; threadId: string; logicalParentThreadId: string; graphId?: string;
  nodeId?: string; hostId: string; bootstrapTokenHash: string; bootstrapClaimedAt?: number;
  createdAt: number; updatedAt: number;
}

export function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function newBootstrapToken(): string { return randomBytes(32).toString("base64url"); }

export function createCorrelationStore(db: Database.Database) {
  for (const migration of correlationMigrations) db.exec(migration.sql);
  const row = (runId: string) => db.prepare("SELECT * FROM meta_harness_correlation WHERE run_id=?").get(runId) as Record<string, unknown> | undefined;
  return {
    getByRun(runId: string): Correlation | undefined {
      const found = row(runId); if (!found) return undefined;
      return { runId: String(found.run_id), threadId: String(found.thread_id), logicalParentThreadId: String(found.logical_parent_thread_id), ...(found.graph_id ? { graphId: String(found.graph_id) } : {}), ...(found.node_id ? { nodeId: String(found.node_id) } : {}), hostId: String(found.host_id), bootstrapTokenHash: String(found.bootstrap_token_hash), ...(found.bootstrap_claimed_at ? { bootstrapClaimedAt: Number(found.bootstrap_claimed_at) } : {}), createdAt: Number(found.created_at), updatedAt: Number(found.updated_at) };
    },
    getByToken(token: string): Correlation | undefined {
      const found = db.prepare("SELECT run_id FROM meta_harness_correlation WHERE bootstrap_token_hash=?").get(tokenHash(token)) as { run_id: string } | undefined;
      return found ? this.getByRun(found.run_id) : undefined;
    },
		insert(value: Correlation): Correlation {
		db.prepare("INSERT INTO meta_harness_correlation(run_id,thread_id,logical_parent_thread_id,graph_id,node_id,host_id,bootstrap_token_hash,bootstrap_claimed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(value.runId, value.threadId, value.logicalParentThreadId, value.graphId ?? null, value.nodeId ?? null, value.hostId, value.bootstrapTokenHash, value.bootstrapClaimedAt ?? null, value.createdAt, value.updatedAt);
			return value;
		},
		list(): Correlation[] {
			const rows = db.prepare("SELECT run_id FROM meta_harness_correlation ORDER BY created_at ASC").all() as Array<{ run_id: string }>;
			return rows.flatMap((found) => {
				const value = this.getByRun(found.run_id);
				return value ? [value] : [];
			});
		},
    claimBootstrap(token: string, threadId: string): Correlation | undefined {
      const now = Date.now();
      const outcome = db.prepare("UPDATE meta_harness_correlation SET bootstrap_claimed_at=?, updated_at=? WHERE bootstrap_token_hash=? AND thread_id=? AND bootstrap_claimed_at IS NULL").run(now, now, tokenHash(token), threadId);
      if (outcome.changes !== 1) return undefined;
      const found = db.prepare("SELECT run_id FROM meta_harness_correlation WHERE bootstrap_token_hash=?").get(tokenHash(token)) as { run_id: string };
      return this.getByRun(found.run_id);
    },
  };
}
