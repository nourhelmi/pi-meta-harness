import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(origin, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`advisor UI exited with code ${child.exitCode}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The child may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("advisor UI did not start");
}

async function writeGraph(graphsDir, graphId) {
  await writeFile(join(graphsDir, `${graphId}.json`), `${JSON.stringify({
    graphId,
    goal: `Exercise ${graphId}`,
    nodes: [{ id: "probe", role: "scout", task: "Probe refresh", anchor: "Visible" }],
    waves: [["probe"]],
  })}\n`);
}

test("advisor UI force-refreshes graph inventory without a new Pi session", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "advisor-ui-refresh-"));
  const stateHome = join(temp, "state");
  const graphsDir = join(stateHome, "project-a", "graphs");
  await mkdir(graphsDir, { recursive: true });
  await writeGraph(graphsDir, "first-graph");

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["scripts/advisor-ui/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ADVISOR_STATE_HOME: stateHome,
      ADVISOR_UI_PORT: String(port),
      PI_CODING_AGENT_DIR: join(temp, "pi-agent"),
    },
    stdio: "ignore",
  });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    await rm(temp, { recursive: true, force: true });
  });

  await waitForServer(origin, child);
  const initialResponse = await fetch(`${origin}/api/state?refresh=1`);
  assert.equal(initialResponse.headers.get("cache-control"), "no-store");
  const initial = await initialResponse.json();
  assert.deepEqual(initial.projects[0].graphs.map((graph) => graph.graphId), ["first-graph"]);

  await writeGraph(graphsDir, "second-graph");
  const refreshed = await (await fetch(`${origin}/api/state?refresh=1`)).json();
  assert.deepEqual(
    refreshed.projects[0].graphs.map((graph) => graph.graphId).sort(),
    ["first-graph", "second-graph"],
  );

  const appSource = await (await fetch(`${origin}/app.js`)).text();
  assert.match(appSource, /visibilitychange/);
  assert.match(appSource, /cache: "no-store"/);
  assert.match(appSource, /label: "Current work"/);
  assert.match(appSource, /projectForSession\(session\)/);
  assert.match(appSource, /graph\.virtual \? "Current sessions"/);
  assert.doesNotMatch(appSource, /setInterval\(poll/);
});
