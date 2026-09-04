import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCorrelationStore,
  fingerprint,
  hasLegacyPrivateRoleStateColumn,
  listLegacyPrivateRoleStateRows,
  migrateLegacyPrivateRoleStateRows,
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
	it("scrubs legacy durable role payloads while preserving only locator and digest", () => {
		const directory = mkdtempSync(join(tmpdir(), "meta-private-db-proof-"));
		const databasePath = join(directory, "plugin.sqlite");
		const db = new Database(databasePath);
		db.exec(`CREATE TABLE meta_harness_private_launch_reservation (
			run_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE,
			request_fingerprint TEXT NOT NULL, input_sha256 TEXT NOT NULL,
			logical_parent_thread_id TEXT NOT NULL, logical_parent_environment_id TEXT NOT NULL,
			graph_id TEXT, node_id TEXT, project_id TEXT NOT NULL, host_id TEXT NOT NULL,
			cwd TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning TEXT NOT NULL,
			role_state_json TEXT NOT NULL, thread_id TEXT UNIQUE, environment_id TEXT,
			generation INTEGER, initialization_state TEXT NOT NULL, receipt_sha256 TEXT,
			error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
			initialized_at INTEGER
		)`);
		const secret = `legacy-${randomBytes(48).toString("base64url")}`;
		const roleState = {
			role: "builder",
			runDir: "/tmp/advisor/runs/legacy-run",
			resultPath: "/tmp/advisor/runs/legacy-run/result.md",
			maxTurns: 32,
			launchModel: "openai/gpt-5.6",
			launchThinking: "high",
			allowSubagents: false,
			runId: "legacy-run",
			control: secret,
		};
		db.prepare(
			`INSERT INTO meta_harness_private_launch_reservation VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		).run(
			"legacy-run", "reservation", "1".repeat(64), "2".repeat(64), "parent", "parent-env",
			null, null, "project", "host", "/worktree", "pi", "openai/gpt-5.6", "high",
			JSON.stringify(roleState), "thread", "environment", 1, "initialized", "3".repeat(64),
			null, 1, 2, 2,
		);
		expect(hasLegacyPrivateRoleStateColumn(db)).toBe(true);
		expect(listLegacyPrivateRoleStateRows(db)).toHaveLength(1);
		migrateLegacyPrivateRoleStateRows(
			db,
			new Map([
				[
					"legacy-run",
					{
						locator: "/tmp/advisor/runs/legacy-run/private-role-state.json",
						sha256: "4".repeat(64),
					},
				],
			]),
		);
		expect(hasLegacyPrivateRoleStateColumn(db)).toBe(false);
		const columns = db
			.prepare("PRAGMA table_info(meta_harness_private_launch_reservation)")
			.all() as Array<{ name: string }>;
		expect(columns.map(({ name }) => name)).not.toContain("role_state_json");
		const rows = db
			.prepare("SELECT * FROM meta_harness_private_launch_reservation")
			.all();
		expect(JSON.stringify(rows)).not.toContain(secret);
		expect(rows).toMatchObject([
			{
				role_state_locator: "/tmp/advisor/runs/legacy-run/private-role-state.json",
				role_state_sha256: "4".repeat(64),
			},
		]);
		const tableNames = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
			.all() as Array<{ name: string }>;
		const variants = [
			secret,
			Buffer.from(secret).toString("base64"),
			Buffer.from(secret).toString("base64url"),
			Buffer.from(secret).toString("hex"),
			encodeURIComponent(secret),
		];
		const inventory = tableNames.map(({ name }) => {
			const tableRows = db.prepare(`SELECT * FROM "${name}"`).all();
			const encoded = JSON.stringify(tableRows);
			const matches = variants.reduce(
				(count, variant) => count + (encoded.split(variant).length - 1),
				0,
			);
			expect(matches).toBe(0);
			return { name, rows: tableRows.length, matches };
		});
		db.close();
		const databaseBytes = readFileSync(databasePath);
		const databaseFileMatches = variants.reduce(
			(count, variant) => count + (databaseBytes.includes(Buffer.from(variant)) ? 1 : 0),
			0,
		);
		expect(databaseFileMatches).toBe(0);
		const proofRoot = process.env.BB_PRIVATE_PROOF_DIR;
		if (proofRoot !== undefined) {
			mkdirSync(proofRoot, { recursive: true });
			writeFileSync(
				join(proofRoot, "meta-surfaces.json"),
				JSON.stringify({
					surface: "meta-plugin-sqlite",
					canarySha256: createHash("sha256").update(secret).digest("hex"),
					legacyColumnScrubbed: true,
					inventory: [...inventory, { name: "plugin.sqlite bytes", rows: 1, matches: databaseFileMatches }],
					scan: {
						method: "raw, base64, base64url, hex, uri-component",
						totalSurfaces: inventory.length + 1,
						totalMatches:
							inventory.reduce((count, table) => count + table.matches, 0) +
							databaseFileMatches,
					},
				}),
			);
		}
		rmSync(directory, { recursive: true, force: true });
	});
	it("keeps legacy correlation rows readable and unique by run/thread", () => {
    const db = new Database(":memory:");
    const store = createCorrelationStore(db);
		store.insert({
			runId: "r",
			threadId: "t",
			logicalParentThreadId: "p",
			graphId: "g",
			nodeId: "n",
			hostId: "h",
			bootstrapTokenHash: tokenHash("token"),
			createdAt: 1,
			updatedAt: 1,
		});
		expect(store.getByRun("r")).toMatchObject({
			runId: "r",
			threadId: "t",
			logicalParentThreadId: "p",
			graphId: "g",
			nodeId: "n",
			hostId: "h",
		});
    expect(store.list()).toHaveLength(1);
		expect(Object.keys(store.getByRun("r") ?? {}).sort()).toEqual([
			"bootstrapTokenHash",
			"createdAt",
			"graphId",
			"hostId",
			"logicalParentThreadId",
			"nodeId",
			"runId",
			"threadId",
			"updatedAt",
		]);
		expect(() =>
			store.insert({
				runId: "r",
				threadId: "t2",
				logicalParentThreadId: "p",
				hostId: "h",
				bootstrapTokenHash: tokenHash("other"),
				createdAt: 1,
				updatedAt: 1,
			}),
		).toThrow();
		expect(() =>
			store.insert({
				runId: "r2",
				threadId: "t",
				logicalParentThreadId: "p",
				hostId: "h",
				bootstrapTokenHash: tokenHash("other-2"),
				createdAt: 1,
				updatedAt: 1,
			}),
		).toThrow();
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
		expect(duplicate).toEqual({
			created: false,
			reservation: first.reservation,
		});

    const binding = store.bind(tokenHash("token"), "thread", "environment");
    expect(binding).toMatchObject({
      kind: "bound",
			reservation: {
				state: "bound",
				threadId: "thread",
				environmentId: "environment",
			},
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
			db.prepare("UPDATE meta_harness_bootstrap_launch_reservation SET model = 'other/model' WHERE run_id = 'r'").run(),
    ).toThrow(/immutable/u);
		expect(() => db.prepare("DELETE FROM meta_harness_bootstrap_launch_reservation WHERE run_id = 'r'").run()).toThrow(
			/append-only/u,
		);
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
		expect(() => store.bind(tokenHash("token"), "thread", "environment")).toThrow(/correlation denied/u);
    expect(store.getReservationByRun("r")).toMatchObject({ state: "reserved" });
    expect(store.getByRun("r")).toBeUndefined();
  });
});
