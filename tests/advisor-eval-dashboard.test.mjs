import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { compareProspectiveArtifacts } from "../scripts/advisor-prospective-results.mjs";
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
        "absolute-request-minimal-fix",
        "advisor-direct-capability",
        "advisor-direct-repair",
        "advisor-plan-adaptation",
        "builder-self-verification",
        "cohesive-medium-maker",
        "criteria-revision",
        "false-fail-review",
        "foreman-blocked-decision",
        "foreman-cross-repo",
        "medium-ticket-search",
        "parallel-evidence-merge",
        "risk-triggered-checker",
        "routing-ambiguity",
        "safety-redirect",
        "scoped-recheck",
        "single-maker-fast-path",
        "two-defects-ship-small-first",
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

test("dashboard renders process counters and token floors, with unknown legacy values and neutral diagnostic tone", async () => {
  class Element {
    constructor(text = "") { this.text = text; this.children = []; this.dataset = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll() { return []; }
    setAttribute() {}
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(" "); }
  }
  const elements = new Map();
  const document = {
    querySelector: (selector) => {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    },
    createElement: () => new Element(),
    createTextNode: (text) => new Element(text),
  };
  const artifact = (id, process) => ({
    id, key: `run:${id}`, kind: "run",
    manifest: { case: { id: "test" }, evaluation: { fingerprint: { algorithm: "test", value: "same" } } },
    result: { status: "passed", reward: 1, checks: [], process },
  });
  const before = artifact("legacy");
  const after = artifact("new", { launches: 2, resumes: 1, blockedSettlements: 1, failedSettlements: 0,
    successfulSettlements: 2, repairRounds: 1, compactions: 1, postCompactionFloorTokens: [100_000, null], doctrineReads: 0 });
  const source = await readFile(new URL("../scripts/advisor-eval-dashboard/app.js", import.meta.url), "utf8");
  // Exercise the real renderers without timers, networking, or a browser dependency.
  const renderers = source.slice(0, source.indexOf('$("#open-search").addEventListener'));
  runInNewContext(`${renderers}\nsnapshot = fixtures; selectEvidence("run:new"); renderRuler(comparison);`, {
    document, Node: Element, fixtures: { runs: [before, after], baselines: [] }, comparison: compareProspectiveArtifacts(before, after),
  });
  const evidence = elements.get("#evidence-list").textContent;
  assert.match(evidence, /Diagnostic only · missing sources are unknown/);
  assert.match(evidence, /Worker launches 2/);
  assert.match(evidence, /Failed settlements 0/);
  assert.match(evidence, /Post-compaction floor tokens \[100000, —\]/);
  assert.match(evidence, /Guide reads —/);
  const ruler = elements.get("#trajectory-ruler").children[0];
  assert.match(ruler.textContent, /Worker launches — 2/);
  assert.match(ruler.textContent, /Blocked settlements — 1/);
  assert.match(ruler.textContent, /Repair rounds — 1/);
  assert.match(ruler.textContent, /Root compactions — 1/);
  assert(ruler.children.filter((child) => child.dataset.tone).every((child) => child.dataset.tone === "neutral"));
});
