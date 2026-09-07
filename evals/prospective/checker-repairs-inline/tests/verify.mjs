import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifierEnvironment, workspaceChecks } from "../../workspace-checks.mjs";

const probes = {
  "exact-tenant-boundary": `
    for (const [tenantId, resourceTenant] of [["acme", "ACME"], ["ACME", "acme"], ["Tenant-A", "tenant-a"]]) {
      const result = listRecords({ tenantId, userId: "u" }, { tenantId: resourceTenant, ownerId: "u" }, ["secret"]);
      assert.notEqual(result.status, 200);
      assert.deepEqual(result.records, []);
    }
  `,
  "exact-page-size": `
    const request = { tenantId: "acme", userId: "u" };
    const resource = { tenantId: "acme", ownerId: "u" };
    for (const length of [0, 1, 5, 11]) {
      const rows = Array.from({ length }, (_, id) => ({ id }));
      const before = structuredClone(rows);
      for (const offset of [0, 1, 4, 12]) for (const limit of [0, 1, 2, 7]) {
        assert.deepEqual(listRecords(request, resource, rows, { offset, limit }), { status: 200, records: rows.slice(offset, offset + limit) });
      }
      assert.deepEqual(rows, before);
    }
  `,
  "forbidden-error-code": `
    for (const [request, resource] of [
      [{ tenantId: "a", userId: "u" }, { tenantId: "b", ownerId: "u" }],
      [{ tenantId: "a", userId: "u" }, { tenantId: "a", ownerId: "v" }],
      [undefined, { tenantId: "a", ownerId: "u" }],
      [{ tenantId: "a", userId: "u" }, undefined],
      [{ userId: "u" }, { tenantId: "a", ownerId: "u" }],
      [{ tenantId: "a" }, { tenantId: "a", ownerId: "u" }],
      [{ tenantId: "a", userId: "u" }, { ownerId: "u" }],
      [{ tenantId: "a", userId: "u" }, { tenantId: "a" }],
    ]) assert.deepEqual(listRecords(request, resource, ["secret"]), { status: 403, records: [] });
  `,
  "hidden-valid-read-preserved": `
    for (const tenantId of ["acme", "ACME", "Tenant-A"]) {
      assert.deepEqual(listRecords({ tenantId, userId: "u" }, { tenantId, ownerId: "u" }, ["ok"]), { status: 200, records: ["ok"] });
    }
  `,
};

export async function verify(workspace) {
  const checks = Object.entries(probes).map(([id, source]) => {
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { listRecords } from "./records.mjs";
      ${source}
    `], { cwd: workspace, env: verifierEnvironment(), encoding: "utf8", timeout: 30_000 });
    return { id, passed: probe.status === 0, evidence: `independent ${id} probe exited ${probe.status ?? "without status"}` };
  });
  checks.push(...await workspaceChecks(workspace, fileURLToPath(new URL("../workspace/", import.meta.url)), ["records.mjs", "maker-result.md", "checker-note.md"]));
  return { checks };
}
