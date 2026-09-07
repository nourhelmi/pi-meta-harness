import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifierEnvironment, workspaceChecks } from "../../workspace-checks.mjs";

export async function verify(workspace) {
  const probes = {
    "seconds-converted": `
      for (const issuedAtMs of [0, 1000, 900000]) for (const ttlSeconds of [1, 5, 60]) {
        assert.equal(isExpired(issuedAtMs, issuedAtMs + ttlSeconds * 1000 - 1, ttlSeconds), false);
        assert.equal(isExpired(issuedAtMs, issuedAtMs + ttlSeconds * 1000 + 1, ttlSeconds), true);
      }
    `,
    "inclusive-boundary": `
      for (const issuedAtMs of [0, 1000, 900000]) for (const ttlSeconds of [0, 1, 5, 60]) {
        const ttlMs = ttlSeconds * 1000;
        assert.equal(hasElapsed(ttlMs, ttlMs), true);
        assert.equal(hasElapsed(ttlMs - 1, ttlMs), false);
        assert.equal(hasElapsed(ttlMs + 1, ttlMs), true);
        assert.equal(isExpired(issuedAtMs, issuedAtMs + ttlMs, ttlSeconds), true);
      }
    `,
    "hidden-future-issuance": `
      for (const ttlSeconds of [0, 1, 60]) assert.equal(isExpired(5000, 4000, ttlSeconds), false);
    `,
  };
  const checks = Object.entries(probes).map(([id, source]) => {
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { isExpired } from "./src/expiry.mjs";
      import { hasElapsed } from "./src/boundary.mjs";
      ${source}
    `], { cwd: workspace, env: verifierEnvironment(), encoding: "utf8", timeout: 30_000 });
    return { id, passed: probe.status === 0, evidence: `independent ${id} probe exited ${probe.status ?? "without status"}` };
  });
  checks.push(...await workspaceChecks(workspace, fileURLToPath(new URL("../workspace/", import.meta.url)), ["src/expiry.mjs", "src/boundary.mjs", "checker-note.md"]));
  return { checks };
}
