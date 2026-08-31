import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardServer } from "../scripts/advisor-eval-dashboard/server.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("prospective dashboard serves its workbench and local run inventory", async () => {
  const server = createDashboardServer();
  try {
    const origin = await listen(server);
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Decide whether the setup regressed/);
    const app = await fetch(`${origin}/app.js`);
    assert.equal(app.status, 200);
    const appSource = await app.text();
    assert.match(appSource, /Functional outcome/);
    assert.match(appSource, /Orchestration/);
    assert.match(appSource, /Measurement\/control/);
    assert.match(appSource, /Running — not comparable/);
    assert.match(appSource, /15_000/);

    const response = await fetch(`${origin}/api/state`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.schemaVersion, 1);
    assert(Array.isArray(state.cases));
    assert.deepEqual(
      state.cases.map((prospectiveCase) => prospectiveCase.id).sort(),
      [
        "builder-self-verification",
        "criteria-revision",
        "false-fail-review",
        "foreman-cross-repo",
        "parallel-evidence-merge",
        "routing-ambiguity",
        "safety-redirect",
        "scoped-recheck",
      ],
    );
    assert(Array.isArray(state.runs));
    assert(Array.isArray(state.baselines));
    assert(state.baselines.some((baseline) => baseline.id === "phase0-canary"));
    assert(!JSON.stringify(state).includes("auth.json"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("prospective dashboard rejects unsupported methods and unknown paths", async () => {
  const server = createDashboardServer();
  try {
    const origin = await listen(server);
    assert.equal((await fetch(`${origin}/api/state`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${origin}/not-found`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
