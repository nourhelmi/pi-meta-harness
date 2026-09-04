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
	{
		id: "003-private-thread-initialization",
		sql: `CREATE TABLE IF NOT EXISTS meta_harness_private_launch_reservation (
      run_id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
      input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64),
      logical_parent_thread_id TEXT NOT NULL,
      logical_parent_environment_id TEXT NOT NULL,
      graph_id TEXT,
      node_id TEXT,
      project_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      provider_id TEXT NOT NULL CHECK(provider_id = 'pi'),
      model TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      role_state_locator TEXT NOT NULL,
      role_state_sha256 TEXT NOT NULL CHECK(length(role_state_sha256) = 64),
      thread_id TEXT UNIQUE,
      environment_id TEXT,
      generation INTEGER CHECK(generation IS NULL OR generation >= 1),
      initialization_state TEXT NOT NULL CHECK(initialization_state IN ('reserved','resolving','initialized','stalled','unknown')),
      receipt_sha256 TEXT CHECK(receipt_sha256 IS NULL OR length(receipt_sha256) = 64),
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      initialized_at INTEGER,
      CHECK((thread_id IS NULL AND environment_id IS NULL AND generation IS NULL) OR (thread_id IS NOT NULL AND environment_id IS NOT NULL AND generation IS NOT NULL))
    );
    CREATE TRIGGER IF NOT EXISTS meta_harness_private_launch_immutable
    BEFORE UPDATE OF run_id, reservation_id, request_fingerprint, input_sha256,
      logical_parent_thread_id, logical_parent_environment_id, graph_id,
      node_id, project_id, host_id, cwd, provider_id, model, reasoning,
      role_state_locator, role_state_sha256, created_at
    ON meta_harness_private_launch_reservation
    BEGIN
      SELECT RAISE(ABORT, 'private launch reservation identity is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS meta_harness_private_launch_no_delete
    BEFORE DELETE ON meta_harness_private_launch_reservation
    BEGIN
      SELECT RAISE(ABORT, 'private launch reservations are append-only');
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
	bootstrapTokenHash?: string;
  bootstrapClaimedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PrivateRoleState {
	role: string;
	runDir: string;
	resultPath: string;
	maxTurns: number;
	launchModel: string;
	launchThinking: string;
	allowSubagents: boolean;
	runId: string;
	graphId?: string;
	nodeId?: string;
}

export type PrivateInitializationState = "reserved" | "resolving" | "initialized" | "stalled" | "unknown";

export interface PrivateLaunchReservation {
	runId: string;
	reservationId: string;
	requestFingerprint: string;
	inputSha256: string;
	logicalParentThreadId: string;
	logicalParentEnvironmentId: string;
	graphId?: string;
	nodeId?: string;
	projectId: string;
	hostId: string;
	cwd: string;
	providerId: "pi";
	model: string;
	reasoning: string;
	roleStateLocator: string;
	roleStateSha256: string;
	threadId?: string;
	environmentId?: string;
	generation?: number;
	initializationState: PrivateInitializationState;
	receiptSha256?: string;
	errorCode?: string;
	createdAt: number;
	updatedAt: number;
	initializedAt?: number;
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

export function newPrivateReservationId(): string {
	return randomBytes(32).toString("base64url");
}

function privateReservationFromRow(found: Record<string, unknown>): PrivateLaunchReservation {
	return {
		runId: String(found.run_id),
		reservationId: String(found.reservation_id),
		requestFingerprint: String(found.request_fingerprint),
		inputSha256: String(found.input_sha256),
		logicalParentThreadId: String(found.logical_parent_thread_id),
		logicalParentEnvironmentId: String(found.logical_parent_environment_id),
		...(found.graph_id ? { graphId: String(found.graph_id) } : {}),
		...(found.node_id ? { nodeId: String(found.node_id) } : {}),
		projectId: String(found.project_id),
		hostId: String(found.host_id),
		cwd: String(found.cwd),
		providerId: "pi",
		model: String(found.model),
		reasoning: String(found.reasoning),
		roleStateLocator: String(found.role_state_locator),
		roleStateSha256: String(found.role_state_sha256),
		...(found.thread_id ? { threadId: String(found.thread_id) } : {}),
		...(found.environment_id ? { environmentId: String(found.environment_id) } : {}),
		...(found.generation ? { generation: Number(found.generation) } : {}),
		initializationState: String(found.initialization_state) as PrivateInitializationState,
		...(found.receipt_sha256 ? { receiptSha256: String(found.receipt_sha256) } : {}),
		...(found.error_code ? { errorCode: String(found.error_code) } : {}),
		createdAt: Number(found.created_at),
		updatedAt: Number(found.updated_at),
		...(found.initialized_at ? { initializedAt: Number(found.initialized_at) } : {}),
	};
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
		...(found.bootstrap_claimed_at ? { bootstrapClaimedAt: Number(found.bootstrap_claimed_at) } : {}),
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
		expectedWorkspaceProvisionType: String(found.expected_workspace_provision_type) as "unmanaged",
    bootstrapRequired: Number(found.bootstrap_required) === 1,
    ...(found.thread_id ? { threadId: String(found.thread_id) } : {}),
		...(found.environment_id ? { environmentId: String(found.environment_id) } : {}),
    state: String(found.state) as LaunchReservationState,
		...(found.failure_reason ? { failureReason: String(found.failure_reason) } : {}),
    createdAt: Number(found.created_at),
    updatedAt: Number(found.updated_at),
    ...(found.bound_at ? { boundAt: Number(found.bound_at) } : {}),
  };
}

export interface LegacyPrivateRoleStateRow {
	runId: string;
	hostId: string;
	roleState: PrivateRoleState;
}

export interface MigratedPrivateRoleStateReference {
	locator: string;
	sha256: string;
	state?: PrivateInitializationState;
	errorCode?: string;
}

export function hasLegacyPrivateRoleStateColumn(db: Database.Database): boolean {
	const table = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta_harness_private_launch_reservation'")
		.get();
	if (!table) return false;
	const columns = db.prepare("PRAGMA table_info(meta_harness_private_launch_reservation)").all() as Array<{
		name: string;
	}>;
	return columns.some((column) => column.name === "role_state_json");
}

export function listLegacyPrivateRoleStateRows(
	db: Database.Database,
): LegacyPrivateRoleStateRow[] {
	if (!hasLegacyPrivateRoleStateColumn(db)) return [];
	return (
		db.prepare("SELECT run_id, host_id, role_state_json FROM meta_harness_private_launch_reservation").all() as Array<{
			run_id: string;
			host_id: string;
			role_state_json: string;
		}>
	).map((row) => ({
		runId: row.run_id,
		hostId: row.host_id,
		roleState: JSON.parse(row.role_state_json) as PrivateRoleState,
	}));
}

export function migrateLegacyPrivateRoleStateRows(
	db: Database.Database,
	references: ReadonlyMap<string, MigratedPrivateRoleStateReference>,
): void {
	if (!hasLegacyPrivateRoleStateColumn(db)) return;
	const rows = listLegacyPrivateRoleStateRows(db);
	for (const row of rows) {
		if (!references.has(row.runId)) {
			throw new Error(`missing private role state migration reference for ${row.runId}`);
		}
	}
	db.transaction(() => {
		db.exec(`
      DROP TRIGGER IF EXISTS meta_harness_private_launch_immutable;
      DROP TRIGGER IF EXISTS meta_harness_private_launch_no_delete;
      ALTER TABLE meta_harness_private_launch_reservation RENAME TO meta_harness_private_launch_reservation_legacy;
    `);
		db.exec(correlationMigrations[2].sql);
		const insert = db.prepare(`INSERT INTO meta_harness_private_launch_reservation(
      run_id,reservation_id,request_fingerprint,input_sha256,logical_parent_thread_id,
      logical_parent_environment_id,graph_id,node_id,project_id,host_id,cwd,
      provider_id,model,reasoning,role_state_locator,role_state_sha256,thread_id,
      environment_id,generation,initialization_state,receipt_sha256,error_code,
      created_at,updated_at,initialized_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
		const legacyRows = db.prepare("SELECT * FROM meta_harness_private_launch_reservation_legacy").all() as Array<
			Record<string, unknown>
		>;
		for (const legacy of legacyRows) {
			const reference = references.get(String(legacy.run_id));
			if (!reference) throw new Error("private role state migration reference disappeared");
			insert.run(
				legacy.run_id,
				legacy.reservation_id,
				legacy.request_fingerprint,
				legacy.input_sha256,
				legacy.logical_parent_thread_id,
				legacy.logical_parent_environment_id,
				legacy.graph_id,
				legacy.node_id,
				legacy.project_id,
				legacy.host_id,
				legacy.cwd,
				legacy.provider_id,
				legacy.model,
				legacy.reasoning,
				reference.locator,
				reference.sha256,
				legacy.thread_id,
				legacy.environment_id,
				legacy.generation,
				reference.state ?? legacy.initialization_state,
				legacy.receipt_sha256,
				reference.errorCode ?? legacy.error_code,
				legacy.created_at,
				legacy.updated_at,
				legacy.initialized_at,
			);
		}
		db.exec("DROP TABLE meta_harness_private_launch_reservation_legacy");
	})();
	db.pragma("wal_checkpoint(TRUNCATE)");
	db.exec("VACUUM");
	db.pragma("wal_checkpoint(TRUNCATE)");
}

export function createCorrelationStore(db: Database.Database) {
  for (const migration of correlationMigrations) db.exec(migration.sql);
	if (hasLegacyPrivateRoleStateColumn(db)) {
		throw new Error("legacy private role state must be migrated before opening the correlation store");
	}

  const correlationRow = (runId: string) =>
		db.prepare("SELECT * FROM meta_harness_correlation WHERE run_id = ?").get(runId) as
			| Record<string, unknown>
			| undefined;
  const reservationRow = (runId: string) =>
		db.prepare("SELECT * FROM meta_harness_bootstrap_launch_reservation WHERE run_id = ?").get(runId) as
			| Record<string, unknown>
			| undefined;
  const reservationByHashRow = (bootstrapTokenHash: string) =>
    db
			.prepare("SELECT * FROM meta_harness_bootstrap_launch_reservation WHERE bootstrap_token_hash = ?")
      .get(bootstrapTokenHash) as Record<string, unknown> | undefined;
	const privateReservationRow = (runId: string) =>
		db.prepare("SELECT * FROM meta_harness_private_launch_reservation WHERE run_id = ?").get(runId) as
			| Record<string, unknown>
			| undefined;
	const privateReservationByIdRow = (reservationId: string) =>
		db.prepare("SELECT * FROM meta_harness_private_launch_reservation WHERE reservation_id = ?").get(reservationId) as
			| Record<string, unknown>
			| undefined;

  const getByRun = (runId: string): Correlation | undefined => {
		const privateFound = privateReservationRow(runId);
		if (privateFound) {
			const reservation = privateReservationFromRow(privateFound);
			if (!reservation.threadId) return undefined;
			return {
				runId: reservation.runId,
				threadId: reservation.threadId,
				logicalParentThreadId: reservation.logicalParentThreadId,
				...(reservation.graphId ? { graphId: reservation.graphId } : {}),
				...(reservation.nodeId ? { nodeId: reservation.nodeId } : {}),
				hostId: reservation.hostId,
				createdAt: reservation.createdAt,
				updatedAt: reservation.updatedAt,
			};
		}
    const found = correlationRow(runId);
    return found ? correlationFromRow(found) : undefined;
  };
	const getReservationByRun = (runId: string): LaunchReservation | undefined => {
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
				return raced ? { kind: "unavailable", reservation: raced } : { kind: "missing" };
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
				.prepare("SELECT run_id FROM meta_harness_correlation WHERE bootstrap_token_hash = ?")
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
			const legacyRows = db
				.prepare("SELECT run_id FROM meta_harness_correlation ORDER BY created_at ASC")
				.all() as Array<{ run_id: string }>;
			const privateRows = db
        .prepare(
					"SELECT run_id FROM meta_harness_private_launch_reservation WHERE thread_id IS NOT NULL ORDER BY created_at ASC",
        )
        .all() as Array<{ run_id: string }>;
			const rows = [...legacyRows, ...privateRows];
      return rows.flatMap((found) => {
        const value = getByRun(found.run_id);
        return value ? [value] : [];
      });
    },
		getPrivateReservationByRun(runId: string): PrivateLaunchReservation | undefined {
			const found = privateReservationRow(runId);
			return found ? privateReservationFromRow(found) : undefined;
		},
		getPrivateReservationById(reservationId: string): PrivateLaunchReservation | undefined {
			const found = privateReservationByIdRow(reservationId);
			return found ? privateReservationFromRow(found) : undefined;
		},
		listPrivateReservations(): PrivateLaunchReservation[] {
			return (
				db.prepare("SELECT * FROM meta_harness_private_launch_reservation ORDER BY created_at ASC").all() as Array<
					Record<string, unknown>
				>
			).map(privateReservationFromRow);
		},
		reservePrivate(value: PrivateLaunchReservation): {
			created: boolean;
			reservation: PrivateLaunchReservation;
		} {
			return db.transaction(() => {
				const prior = privateReservationRow(value.runId);
				if (prior)
					return {
						created: false,
						reservation: privateReservationFromRow(prior),
					};
				db.prepare(
					`INSERT INTO meta_harness_private_launch_reservation(
          run_id,reservation_id,request_fingerprint,input_sha256,logical_parent_thread_id,
          logical_parent_environment_id,graph_id,node_id,project_id,host_id,cwd,
          provider_id,model,reasoning,role_state_locator,role_state_sha256,initialization_state,
          created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`,
				).run(
					value.runId,
					value.reservationId,
					value.requestFingerprint,
					value.inputSha256,
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
					value.roleStateLocator,
					value.roleStateSha256,
					value.createdAt,
					value.updatedAt,
				);
				const created = privateReservationRow(value.runId);
				if (!created) throw new Error("private launch reservation was not persisted");
				return {
					created: true,
					reservation: privateReservationFromRow(created),
				};
			})();
		},
		bindPrivate(
			reservationId: string,
			threadId: string,
			environmentId: string,
			generation: number,
		): PrivateLaunchReservation | undefined {
			const now = Date.now();
			let outcome = db
				.prepare(
					`UPDATE meta_harness_private_launch_reservation
        SET thread_id=?, environment_id=?, generation=?, initialization_state='resolving', updated_at=?
        WHERE reservation_id=? AND initialization_state='reserved' AND thread_id IS NULL`,
				)
				.run(threadId, environmentId, generation, now, reservationId);
			if (outcome.changes === 0) {
				outcome = db
					.prepare(
						`UPDATE meta_harness_private_launch_reservation
          SET generation=?, initialization_state='resolving', error_code=NULL, updated_at=?
          WHERE reservation_id=? AND thread_id=? AND environment_id=?
            AND initialization_state='initialized' AND generation < ?`,
					)
					.run(generation, now, reservationId, threadId, environmentId, generation);
			}
			const row = privateReservationByIdRow(reservationId);
			if (outcome.changes !== 1 && row) {
				const current = privateReservationFromRow(row);
				if (
					current.threadId !== threadId ||
					current.environmentId !== environmentId ||
					current.generation !== generation
				)
					return undefined;
				return current;
			}
			return row ? privateReservationFromRow(row) : undefined;
		},
		markPrivate(
			runId: string,
			state: Exclude<PrivateInitializationState, "reserved" | "resolving">,
			errorCode?: string,
		): PrivateLaunchReservation | undefined {
			const now = Date.now();
			db.prepare(
				`UPDATE meta_harness_private_launch_reservation
        SET initialization_state=?, error_code=?, updated_at=?, initialized_at=CASE WHEN ?='initialized' THEN ? ELSE initialized_at END
        WHERE run_id=? AND initialization_state IN ('reserved','resolving')`,
			).run(state, errorCode?.slice(0, 255) ?? null, now, state, now, runId);
			const row = privateReservationRow(runId);
			return row ? privateReservationFromRow(row) : undefined;
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
				db.prepare("SELECT * FROM meta_harness_bootstrap_launch_reservation ORDER BY created_at ASC").all() as Array<
					Record<string, unknown>
				>
      ).map(reservationFromRow);
    },
    bind(
      bootstrapTokenHash: string,
      threadId: string,
      environmentId: string,
      claimedAt?: number,
    ): ReservationBindResult {
			return bindTransaction(bootstrapTokenHash, threadId, environmentId, claimedAt);
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
  };
}
