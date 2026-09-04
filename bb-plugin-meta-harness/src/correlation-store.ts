import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export const correlationMigrations = [
  {
    id: "001-correlation",
    sql: `CREATE TABLE IF NOT EXISTS meta_harness_correlation (
      run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, logical_parent_thread_id TEXT NOT NULL,
      graph_id TEXT, node_id TEXT, host_id TEXT NOT NULL, bootstrap_token_hash TEXT NOT NULL UNIQUE,
      bootstrap_claimed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`,
  },
  {
    id: "002-bootstrap-launch-reservation",
    sql: `CREATE TABLE IF NOT EXISTS meta_harness_bootstrap_launch_reservation (
      run_id TEXT PRIMARY KEY,
      bootstrap_token_hash TEXT NOT NULL UNIQUE CHECK(length(bootstrap_token_hash) = 64),
      request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
      logical_parent_thread_id TEXT NOT NULL,
      logical_parent_environment_id TEXT NOT NULL,
      graph_id TEXT,
      node_id TEXT,
      project_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      expected_origin TEXT NOT NULL,
      expected_origin_plugin_id TEXT NOT NULL,
      expected_visibility TEXT NOT NULL,
      expected_parent_thread_id TEXT,
      expected_origin_kind TEXT,
      expected_workspace_provision_type TEXT NOT NULL,
      bootstrap_required INTEGER NOT NULL CHECK(bootstrap_required IN (0, 1)),
      thread_id TEXT UNIQUE,
      environment_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('reserved', 'bound', 'failed', 'unknown')),
      failure_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      bound_at INTEGER,
      CHECK(
        (thread_id IS NULL AND environment_id IS NULL AND bound_at IS NULL)
        OR (thread_id IS NOT NULL AND environment_id IS NOT NULL AND bound_at IS NOT NULL)
      ),
      CHECK(state <> 'bound' OR thread_id IS NOT NULL),
      CHECK(state <> 'reserved' OR thread_id IS NULL),
      CHECK(provider_id = 'pi'),
      CHECK(expected_origin = 'plugin'),
      CHECK(expected_visibility = 'visible'),
      CHECK(expected_parent_thread_id IS NULL),
      CHECK(expected_origin_kind IS NULL),
      CHECK(expected_workspace_provision_type = 'unmanaged')
    );
    CREATE TRIGGER IF NOT EXISTS meta_harness_bootstrap_launch_immutable
    BEFORE UPDATE OF
      run_id, bootstrap_token_hash, request_fingerprint,
      logical_parent_thread_id, logical_parent_environment_id, graph_id,
      node_id, project_id, host_id, cwd, provider_id, model, reasoning,
      expected_origin, expected_origin_plugin_id, expected_visibility,
      expected_parent_thread_id, expected_origin_kind,
      expected_workspace_provision_type, bootstrap_required, created_at
    ON meta_harness_bootstrap_launch_reservation
    WHEN
      NEW.run_id IS NOT OLD.run_id OR
      NEW.bootstrap_token_hash IS NOT OLD.bootstrap_token_hash OR
      NEW.request_fingerprint IS NOT OLD.request_fingerprint OR
      NEW.logical_parent_thread_id IS NOT OLD.logical_parent_thread_id OR
      NEW.logical_parent_environment_id IS NOT OLD.logical_parent_environment_id OR
      NEW.graph_id IS NOT OLD.graph_id OR
      NEW.node_id IS NOT OLD.node_id OR
      NEW.project_id IS NOT OLD.project_id OR
      NEW.host_id IS NOT OLD.host_id OR
      NEW.cwd IS NOT OLD.cwd OR
      NEW.provider_id IS NOT OLD.provider_id OR
      NEW.model IS NOT OLD.model OR
      NEW.reasoning IS NOT OLD.reasoning OR
      NEW.expected_origin IS NOT OLD.expected_origin OR
      NEW.expected_origin_plugin_id IS NOT OLD.expected_origin_plugin_id OR
      NEW.expected_visibility IS NOT OLD.expected_visibility OR
      NEW.expected_parent_thread_id IS NOT OLD.expected_parent_thread_id OR
      NEW.expected_origin_kind IS NOT OLD.expected_origin_kind OR
      NEW.expected_workspace_provision_type IS NOT OLD.expected_workspace_provision_type OR
      NEW.bootstrap_required IS NOT OLD.bootstrap_required OR
      NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'launch reservation identity is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS meta_harness_bootstrap_launch_no_delete
    BEFORE DELETE ON meta_harness_bootstrap_launch_reservation
    BEGIN
      SELECT RAISE(ABORT, 'launch reservations are append-only');
    END;`,
  },
] as const;

export interface Correlation {
  runId: string;
  threadId: string;
  logicalParentThreadId: string;
  graphId?: string;
  nodeId?: string;
  hostId: string;
  bootstrapTokenHash: string;
  bootstrapClaimedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type LaunchReservationState = "reserved" | "bound" | "failed" | "unknown";

export interface LaunchReservation {
  runId: string;
  bootstrapTokenHash: string;
  requestFingerprint: string;
  logicalParentThreadId: string;
  logicalParentEnvironmentId: string;
  graphId?: string;
  nodeId?: string;
  projectId: string;
  hostId: string;
  cwd: string;
  providerId: string;
  model: string;
  reasoning: string;
  expectedOrigin: "plugin";
  expectedOriginPluginId: string;
  expectedVisibility: "visible";
  expectedParentThreadId: null;
  expectedOriginKind: null;
  expectedWorkspaceProvisionType: "unmanaged";
  bootstrapRequired: boolean;
  threadId?: string;
  environmentId?: string;
  state: LaunchReservationState;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
  boundAt?: number;
}

export type ReservationBindResult =
  | { kind: "bound"; reservation: LaunchReservation; correlation: Correlation }
  | { kind: "missing" }
  | { kind: "unavailable"; reservation: LaunchReservation }
  | { kind: "thread-mismatch"; reservation: LaunchReservation };

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function newBootstrapToken(): string {
  return randomBytes(32).toString("base64url");
}

function correlationFromRow(found: Record<string, unknown>): Correlation {
  return {
    runId: String(found.run_id),
    threadId: String(found.thread_id),
    logicalParentThreadId: String(found.logical_parent_thread_id),
    ...(found.graph_id ? { graphId: String(found.graph_id) } : {}),
    ...(found.node_id ? { nodeId: String(found.node_id) } : {}),
    hostId: String(found.host_id),
    bootstrapTokenHash: String(found.bootstrap_token_hash),
    ...(found.bootstrap_claimed_at
      ? { bootstrapClaimedAt: Number(found.bootstrap_claimed_at) }
      : {}),
    createdAt: Number(found.created_at),
    updatedAt: Number(found.updated_at),
  };
}

function reservationFromRow(found: Record<string, unknown>): LaunchReservation {
  return {
    runId: String(found.run_id),
    bootstrapTokenHash: String(found.bootstrap_token_hash),
    requestFingerprint: String(found.request_fingerprint),
    logicalParentThreadId: String(found.logical_parent_thread_id),
    logicalParentEnvironmentId: String(found.logical_parent_environment_id),
    ...(found.graph_id ? { graphId: String(found.graph_id) } : {}),
    ...(found.node_id ? { nodeId: String(found.node_id) } : {}),
    projectId: String(found.project_id),
    hostId: String(found.host_id),
    cwd: String(found.cwd),
    providerId: String(found.provider_id),
    model: String(found.model),
    reasoning: String(found.reasoning),
    expectedOrigin: String(found.expected_origin) as "plugin",
    expectedOriginPluginId: String(found.expected_origin_plugin_id),
    expectedVisibility: String(found.expected_visibility) as "visible",
    expectedParentThreadId: null,
    expectedOriginKind: null,
    expectedWorkspaceProvisionType: String(
      found.expected_workspace_provision_type,
    ) as "unmanaged",
    bootstrapRequired: Number(found.bootstrap_required) === 1,
    ...(found.thread_id ? { threadId: String(found.thread_id) } : {}),
    ...(found.environment_id
      ? { environmentId: String(found.environment_id) }
      : {}),
    state: String(found.state) as LaunchReservationState,
    ...(found.failure_reason
      ? { failureReason: String(found.failure_reason) }
      : {}),
    createdAt: Number(found.created_at),
    updatedAt: Number(found.updated_at),
    ...(found.bound_at ? { boundAt: Number(found.bound_at) } : {}),
  };
}

export function createCorrelationStore(db: Database.Database) {
  for (const migration of correlationMigrations) db.exec(migration.sql);

  const correlationRow = (runId: string) =>
    db
      .prepare("SELECT * FROM meta_harness_correlation WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
  const reservationRow = (runId: string) =>
    db
      .prepare(
        "SELECT * FROM meta_harness_bootstrap_launch_reservation WHERE run_id = ?",
      )
      .get(runId) as Record<string, unknown> | undefined;
  const reservationByHashRow = (bootstrapTokenHash: string) =>
    db
      .prepare(
        "SELECT * FROM meta_harness_bootstrap_launch_reservation WHERE bootstrap_token_hash = ?",
      )
      .get(bootstrapTokenHash) as Record<string, unknown> | undefined;

  const getByRun = (runId: string): Correlation | undefined => {
    const found = correlationRow(runId);
    return found ? correlationFromRow(found) : undefined;
  };
  const getReservationByRun = (
    runId: string,
  ): LaunchReservation | undefined => {
    const found = reservationRow(runId);
    return found ? reservationFromRow(found) : undefined;
  };

  const insertCorrelation = db.prepare(
    `INSERT INTO meta_harness_correlation(
      run_id, thread_id, logical_parent_thread_id, graph_id, node_id, host_id,
      bootstrap_token_hash, bootstrap_claimed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const bindTransaction = db.transaction(
    (
      bootstrapTokenHash: string,
      threadId: string,
      environmentId: string,
      claimedAt?: number,
    ): ReservationBindResult => {
      const raw = reservationByHashRow(bootstrapTokenHash);
      if (!raw) return { kind: "missing" };
      const current = reservationFromRow(raw);
      if (current.state === "bound") {
        if (current.threadId !== threadId || current.environmentId !== environmentId) {
          return { kind: "thread-mismatch", reservation: current };
        }
        const correlation = getByRun(current.runId);
        if (!correlation) return { kind: "unavailable", reservation: current };
        return { kind: "bound", reservation: current, correlation };
      }
      if (current.state !== "reserved") {
        return { kind: "unavailable", reservation: current };
      }

      const now = Date.now();
      const updated = db
        .prepare(
          `UPDATE meta_harness_bootstrap_launch_reservation
             SET state = 'bound', thread_id = ?, environment_id = ?, bound_at = ?, updated_at = ?
           WHERE run_id = ? AND state = 'reserved' AND thread_id IS NULL`,
        )
        .run(threadId, environmentId, now, now, current.runId);
      if (updated.changes !== 1) {
        const raced = getReservationByRun(current.runId);
        return raced
          ? { kind: "unavailable", reservation: raced }
          : { kind: "missing" };
      }

      const correlation: Correlation = {
        runId: current.runId,
        threadId,
        logicalParentThreadId: current.logicalParentThreadId,
        ...(current.graphId ? { graphId: current.graphId } : {}),
        ...(current.nodeId ? { nodeId: current.nodeId } : {}),
        hostId: current.hostId,
        bootstrapTokenHash: current.bootstrapTokenHash,
        ...(claimedAt === undefined ? {} : { bootstrapClaimedAt: claimedAt }),
        createdAt: current.createdAt,
        updatedAt: now,
      };
      insertCorrelation.run(
        correlation.runId,
        correlation.threadId,
        correlation.logicalParentThreadId,
        correlation.graphId ?? null,
        correlation.nodeId ?? null,
        correlation.hostId,
        correlation.bootstrapTokenHash,
        correlation.bootstrapClaimedAt ?? null,
        correlation.createdAt,
        correlation.updatedAt,
      );
      const reservation = getReservationByRun(current.runId);
      if (!reservation) throw new Error("bound launch reservation disappeared");
      return { kind: "bound", reservation, correlation };
    },
  );

  return {
    getByRun,
    getByToken(token: string): Correlation | undefined {
      const found = db
        .prepare(
          "SELECT run_id FROM meta_harness_correlation WHERE bootstrap_token_hash = ?",
        )
        .get(tokenHash(token)) as { run_id: string } | undefined;
      return found ? getByRun(found.run_id) : undefined;
    },
    insert(value: Correlation): Correlation {
      insertCorrelation.run(
        value.runId,
        value.threadId,
        value.logicalParentThreadId,
        value.graphId ?? null,
        value.nodeId ?? null,
        value.hostId,
        value.bootstrapTokenHash,
        value.bootstrapClaimedAt ?? null,
        value.createdAt,
        value.updatedAt,
      );
      return value;
    },
    list(): Correlation[] {
      const rows = db
        .prepare(
          "SELECT run_id FROM meta_harness_correlation ORDER BY created_at ASC",
        )
        .all() as Array<{ run_id: string }>;
      return rows.flatMap((found) => {
        const value = getByRun(found.run_id);
        return value ? [value] : [];
      });
    },
    reserve(value: LaunchReservation): {
      created: boolean;
      reservation: LaunchReservation;
    } {
      return db.transaction(() => {
        const prior = getReservationByRun(value.runId);
        if (prior) return { created: false, reservation: prior };
        db.prepare(
          `INSERT INTO meta_harness_bootstrap_launch_reservation(
            run_id, bootstrap_token_hash, request_fingerprint,
            logical_parent_thread_id, logical_parent_environment_id, graph_id,
            node_id, project_id, host_id, cwd, provider_id, model, reasoning,
            expected_origin, expected_origin_plugin_id, expected_visibility,
            expected_parent_thread_id, expected_origin_kind,
            expected_workspace_provision_type, bootstrap_required, thread_id,
            environment_id, state, failure_reason, created_at, updated_at, bound_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'reserved', NULL, ?, ?, NULL)`,
        ).run(
          value.runId,
          value.bootstrapTokenHash,
          value.requestFingerprint,
          value.logicalParentThreadId,
          value.logicalParentEnvironmentId,
          value.graphId ?? null,
          value.nodeId ?? null,
          value.projectId,
          value.hostId,
          value.cwd,
          value.providerId,
          value.model,
          value.reasoning,
          value.expectedOrigin,
          value.expectedOriginPluginId,
          value.expectedVisibility,
          value.expectedParentThreadId,
          value.expectedOriginKind,
          value.expectedWorkspaceProvisionType,
          value.bootstrapRequired ? 1 : 0,
          value.createdAt,
          value.updatedAt,
        );
        const reservation = getReservationByRun(value.runId);
        if (!reservation) throw new Error("launch reservation was not persisted");
        return { created: true, reservation };
      })();
    },
    getReservationByRun,
    getReservationByToken(token: string): LaunchReservation | undefined {
      const found = reservationByHashRow(tokenHash(token));
      return found ? reservationFromRow(found) : undefined;
    },
    listReservations(): LaunchReservation[] {
      return (
        db
          .prepare(
            "SELECT * FROM meta_harness_bootstrap_launch_reservation ORDER BY created_at ASC",
          )
          .all() as Array<Record<string, unknown>>
      ).map(reservationFromRow);
    },
    bind(
      bootstrapTokenHash: string,
      threadId: string,
      environmentId: string,
      claimedAt?: number,
    ): ReservationBindResult {
      return bindTransaction(
        bootstrapTokenHash,
        threadId,
        environmentId,
        claimedAt,
      );
    },
    mark(
      runId: string,
      state: Exclude<LaunchReservationState, "reserved" | "bound">,
      failureReason: string,
    ): LaunchReservation | undefined {
      const now = Date.now();
      db.prepare(
        `UPDATE meta_harness_bootstrap_launch_reservation
            SET state = ?, failure_reason = ?, updated_at = ?
          WHERE run_id = ? AND state IN ('reserved', 'bound')`,
      ).run(state, failureReason.slice(0, 4096), now, runId);
      return getReservationByRun(runId);
    },
    claimBootstrap(token: string, threadId: string): Correlation | undefined {
      const now = Date.now();
      const outcome = db
        .prepare(
          `UPDATE meta_harness_correlation
              SET bootstrap_claimed_at = ?, updated_at = ?
            WHERE bootstrap_token_hash = ? AND thread_id = ?
              AND bootstrap_claimed_at IS NULL`,
        )
        .run(now, now, tokenHash(token), threadId);
      if (outcome.changes !== 1) return undefined;
      const found = db
        .prepare(
          "SELECT run_id FROM meta_harness_correlation WHERE bootstrap_token_hash = ?",
        )
        .get(tokenHash(token)) as { run_id: string };
      return getByRun(found.run_id);
    },
  };
}
