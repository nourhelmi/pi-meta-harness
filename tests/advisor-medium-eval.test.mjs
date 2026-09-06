import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAdvisorPrompt, loadProspectiveCase, processChecks, verifyProspectiveWorkspace } from "../scripts/advisor-prospective.mjs";

const repositoryRepair = `export function findTickets(records, query) {
  return records.filter((ticket) =>
    (!query.q || [ticket.title, ticket.customer].some((text) => text.toLowerCase().includes(query.q))) &&
    (!query.status || query.status === ticket.status) &&
    query.tags.every((tag) => ticket.tags.includes(tag))
  ).sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return (a.updatedAt < b.updatedAt ? -1 : 1) * (query.sort === "oldest" ? 1 : -1);
  });
}
`;
const searchRepair = `import { parseQuery } from "./query.mjs";
import { findTickets } from "./repository.mjs";
export function searchTickets(records, params) {
  const query = parseQuery(params);
  const all = findTickets(records, query);
  const start = (query.page - 1) * query.pageSize;
  return { items: all.slice(start, start + query.pageSize), total: all.length,
    page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(all.length / query.pageSize) };
}
`;
const regressionTests = `import assert from "node:assert/strict";
import test from "node:test";
import { searchTickets } from "../src/search.mjs";
import { tickets } from "../data/tickets.mjs";
test("filter before paging and retain full counts", () => {
  const result = searchTickets(structuredClone(tickets), new URLSearchParams("status=open&tag=billing&tag=urgent&pageSize=1&page=2"));
  assert.deepEqual(result.items.map((ticket) => ticket.id), ["T-009"]);
  assert.equal(result.total, 2);
  assert.equal(result.totalPages, 2);
});
test("multiple searches preserve caller ordering and records", () => {
  const records = structuredClone(tickets);
  const original = structuredClone(records);
  for (const sort of ["oldest", "newest"]) {
    searchTickets(records, new URLSearchParams({ sort }));
    assert.deepEqual(records, original);
  }
});
`;

async function fixture() {
  const loaded = await loadProspectiveCase("medium-ticket-search");
  const workspace = await mkdtemp(join(tmpdir(), "advisor-medium-case-"));
  await cp(loaded.workspaceSource, workspace, { recursive: true });
  return { loaded, workspace };
}

async function repair(workspace) {
  const queryPath = join(workspace, "src/query.mjs");
  const query = (await readFile(queryPath, "utf8"))
    .replace('q: params.get("q") ?? "",', 'q: (params.get("q") ?? "").trim().toLowerCase(),')
    .replace('tags: params.has("tag") ? [params.get("tag")] : [],', 'tags: [...new Set(params.getAll("tag").map((tag) => tag.trim().toLowerCase()).filter(Boolean))],')
    .replace('if (!/^\\d+$/.test(raw))', 'if (!raw.length || /\\D/.test(raw))');
  await writeFile(queryPath, query);
  await writeFile(join(workspace, "src/repository.mjs"), repositoryRepair);
  await writeFile(join(workspace, "src/search.mjs"), searchRepair);
  await writeFile(join(workspace, "test/search-regression.test.mjs"), regressionTests);
}

const check = (result, id) => result.checks.find((entry) => entry.id === id)?.passed;

test("medium application case rejects the broken fixture and passes a complete bounded repair", async () => {
  const { loaded, workspace } = await fixture();
  try {
    const before = await verifyProspectiveWorkspace(loaded, workspace);
    assert.equal(before.reward, 0);
    assert.equal(check(before, "search-contract"), false);
    assert.equal(check(before, "public-check-passes"), false);
    assert.equal(check(before, "regression-coverage"), false);
    await repair(workspace);
    const after = await verifyProspectiveWorkspace(loaded, workspace);
    assert.equal(after.reward, 1, JSON.stringify(after.checks));
    assert.deepEqual(after.checks.map((entry) => entry.id).sort(), loaded.definition.acceptance.map((entry) => entry.id).sort());
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("medium oracle rejects partial fixes, wrong tag semantics, mutation, and public-fixture hardcoding", async () => {
  const { loaded, workspace } = await fixture();
  try {
    await repair(workspace);
    const queryPath = join(workspace, "src/query.mjs");
    await cp(join(loaded.workspaceSource, "src/query.mjs"), queryPath);
    assert.equal(check(await verifyProspectiveWorkspace(loaded, workspace), "search-contract"), false);
    await repair(workspace);
    for (const broken of [
      repositoryRepair.replace("query.tags.every", "query.tags.some"),
      repositoryRepair.replace("return records.filter", "records.reverse(); return records.filter"),
    ]) {
      await writeFile(join(workspace, "src/repository.mjs"), broken);
      assert.equal(check(await verifyProspectiveWorkspace(loaded, workspace), "search-contract"), false);
    }
    await repair(workspace);
    await writeFile(join(workspace, "src/search.mjs"), 'import { tickets } from "../data/tickets.mjs";\n' + searchRepair.replace("findTickets(records, query)", "findTickets(tickets, query)"));
    const hardcoded = await verifyProspectiveWorkspace(loaded, workspace);
    assert.equal(check(hardcoded, "public-check-passes"), true, "known data can fool public tests");
    assert.equal(check(hardcoded, "search-contract"), false, "independent data must catch hardcoding");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("medium oracle requires useful added tests and protects immutable HTTP evidence and persistent artifacts", async () => {
  const { loaded, workspace } = await fixture();
  try {
    await repair(workspace);
    await writeFile(join(workspace, "test/search-regression.test.mjs"), 'import test from "node:test";\ntest("empty", () => {});\n');
    const empty = await verifyProspectiveWorkspace(loaded, workspace);
    assert.equal(check(empty, "public-check-passes"), true);
    assert.equal(check(empty, "regression-coverage"), false);
    await repair(workspace);
    const httpPath = join(workspace, "src/http.mjs");
    await writeFile(httpPath, `${await readFile(httpPath, "utf8")}\n// unauthorized change\n`);
    assert.equal(check(await verifyProspectiveWorkspace(loaded, workspace), "bounded-surface"), false);
    await cp(join(loaded.workspaceSource, "src/http.mjs"), httpPath);
    await writeFile(join(workspace, "test/search-regression.test.mjs"), regressionTests + '\nimport { writeFileSync } from "node:fs";\nwriteFileSync("generated.txt", "not allowed");\n');
    assert.equal(check(await verifyProspectiveWorkspace(loaded, workspace), "bounded-surface"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("medium oracle rejects a candidate that drops only pending tickets", async () => {
  const { loaded, workspace } = await fixture();
  try {
    await repair(workspace);
    await writeFile(join(workspace, "src/repository.mjs"), repositoryRepair.replace(
      "return records.filter", 'if (query.status === "pending") return []; return records.filter',
    ));
    const result = await verifyProspectiveWorkspace(loaded, workspace);
    assert.equal(check(result, "public-check-passes"), true, "the public examples do not cover this branch");
    assert.equal(check(result, "search-contract"), false, "external probes must catch pending-only data loss");
    assert.equal(result.reward, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("medium oracle rejects last-value semantics for every repeated scalar", async () => {
  const { loaded, workspace } = await fixture();
  try {
    await repair(workspace);
    const path = join(workspace, "src/query.mjs");
    const correct = await readFile(path, "utf8");
    for (const key of ["q", "status", "sort", "page", "pageSize"]) {
      await writeFile(path, correct.replace("export function parseQuery(params) {", `export function parseQuery(params) {
        const values = params.getAll(${JSON.stringify(key)});
        if (values.length > 1) params.set(${JSON.stringify(key)}, values.at(-1));
      `));
      const result = await verifyProspectiveWorkspace(loaded, workspace);
      assert.equal(result.reward, 0, key);
      assert.equal(check(result, "validation-preserved"), false, key);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("medium task permits direct or delegated ownership without a prescribed chain", async () => {
  const { definition } = await loadProspectiveCase("medium-ticket-search");
  const completion = { schemaVersion: 1, status: "completed" };
  for (const events of [[], [{ kind: "worker_launch", role: "builder" }, { kind: "worker_status", role: "builder", status: "successful" }]]) {
    assert(processChecks({ events }, completion, definition).every((entry) => entry.passed));
  }
  assert.equal(processChecks(undefined, completion, definition).find((entry) => entry.id === "root-trajectory").passed, false);
  const prompt = buildAdvisorPrompt(definition, "/tmp/completion.json", "medium-test");
  assert.match(prompt, /no required role chain/);
  assert.doesNotMatch(prompt, /root advisor must not implement|must use.*builder/i);
});
