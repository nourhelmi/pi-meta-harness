import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = resolve(process.argv[2]);
const load = (file) => import(pathToFileURL(resolve(workspace, file)).href);
const { parseQuery } = await load("src/query.mjs");
const { findTickets } = await load("src/repository.mjs");
const { searchTickets } = await load("src/search.mjs");
const { createTicketServer } = await load("src/http.mjs");

function dataset(seed) {
  let state = seed;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const records = Array.from({ length: 37 + seed }, (_, index) => ({
    id: `${["Z", "a", "A"][index % 3]}-${String(index).padStart(3, "0")}`,
    title: ["Invoice.* export", "Account invitation", "CSV timeout", "invoice pending"][index % 4],
    customer: ["Alder Team", "birch COMPANY", "Juniper Studio"][Math.floor(index / 3) % 3],
    status: ["open", "pending", "closed"][(index + seed) % 3],
    tags: index % 5 === 0 ? ["billing", "urgent", "export"] : index % 2 ? ["account", "urgent"] : ["billing"],
    updatedAt: `2026-06-${String(1 + index % 7).padStart(2, "0")}T12:00:00.000Z`,
  }));
  for (let index = records.length - 1; index > 0; index -= 1) {
    const other = next() % (index + 1);
    [records[index], records[other]] = [records[other], records[index]];
  }
  return records;
}

// Independent contract implementation; never import a workspace test or oracle.
function expected(records, params) {
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const tags = [...new Set(params.getAll("tag").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  const status = params.get("status") || undefined;
  const page = params.has("page") ? Number(params.get("page")) : 1;
  const pageSize = params.has("pageSize") ? Number(params.get("pageSize")) : 20;
  const matches = [];
  for (const record of records) {
    if (q && ![record.title, record.customer].some((value) => value.toLowerCase().includes(q))) continue;
    if (status && record.status !== status) continue;
    if (tags.some((tag) => !record.tags.includes(tag))) continue;
    matches.push(structuredClone(record));
  }
  matches.sort((left, right) => {
    if (left.updatedAt === right.updatedAt) return left.id < right.id ? -1 : 1;
    const earlier = Date.parse(left.updatedAt) < Date.parse(right.updatedAt);
    return earlier === (params.get("sort") === "oldest") ? -1 : 1;
  });
  return { items: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length, page, pageSize, totalPages: Math.ceil(matches.length / pageSize) };
}

async function withServer(records, callback) {
  const server = createTicketServer(records);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}

async function contract() {
  assert.deepEqual(parseQuery(new URLSearchParams("q=%20ALDER%20&tag=%20URGENT%20&tag=billing&tag=urgent&tag=%20")),
    { q: "alder", tags: ["urgent", "billing"], status: undefined, sort: "newest", page: 1, pageSize: 20 });
  const filters = ["", "q=%20INVOICE%20", "q=birch", "q=.*", "q=%20", "q=missing",
    ...["open", "pending", "closed"].flatMap((status) => [`status=${status}`, `status=${status}&tag=account`]),
    "tag=%20BILLING%20&tag=urgent&tag=billing&tag=", "q=invoice&status=open&tag=billing&tag=urgent", "tag=absent", "status=&ignored=1",
    "q=alder&q=missing", "status=pending&status=invalid", "sort=oldest&sort=invalid", "pageSize=03&pageSize=0"];
  for (const seed of [1, 3, 7, 11]) {
    const records = dataset(seed);
    const original = structuredClone(records);
    for (const filter of filters) {
      for (const sort of ["newest", "oldest"]) {
        for (const page of [1, 2, 100]) {
          const params = new URLSearchParams(`${filter}&sort=${sort}&page=${page}&pageSize=${seed}`);
          assert.deepEqual(searchTickets(records, new URLSearchParams(params)), expected(original, params), params.toString());
          assert.deepEqual(records, original, "search must not mutate records or their order");
          const allParams = new URLSearchParams(params);
          allParams.set("page", "1");
          allParams.set("pageSize", "50");
          assert.deepEqual(findTickets(records, parseQuery(new URLSearchParams(params))), expected(original, allParams).items, "repository returns all matches, not a page");
          assert.deepEqual(records, original, "repository must not mutate records or their order");
        }
      }
    }
    const frozen = Object.freeze(original.map((record) => Object.freeze({ ...record, tags: Object.freeze([...record.tags]) })));
    assert.deepEqual(searchTickets(frozen, new URLSearchParams()), expected(original, new URLSearchParams()));
    await withServer(records, async (base) => {
      for (const filter of filters) {
        const params = new URLSearchParams(`${filter}&pageSize=3&page=2&sort=oldest`);
        const response = await fetch(`${base}/tickets?${params}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), expected(original, params), `HTTP ${params}`);
      }
    });
    assert.deepEqual(records, original, "HTTP calls must preserve caller data");
  }
  assert.deepEqual(searchTickets([], new URLSearchParams()), expected([], new URLSearchParams()));
}

async function validation() {
  const records = dataset(3);
  const invalid = ["page=", "page=0", "page=-1", "page=1.5", "page=1e2", "page=%2B1", "page=1%0A", "page=9007199254740992",
    "pageSize=", "pageSize=0", "pageSize=51", "pageSize=Infinity", "pageSize=x", "status=unknown", "status=OPEN", "sort=", "sort=random",
    "page=0&page=1", "pageSize=0&pageSize=20", "status=invalid&status=pending", "sort=invalid&sort=newest"];
  await withServer(records, async (base) => {
    for (const query of invalid) {
      assert.throws(() => parseQuery(new URLSearchParams(query)), RangeError, query);
      const response = await fetch(`${base}/tickets?${query}`);
      assert.equal(response.status, 400, query);
      assert.deepEqual(await response.json(), { error: "invalid_query" });
    }
    for (const query of ["", "page=01&pageSize=050", "page=9007199254740991", "page=1&page=0", "unknown=x", "status=",
      "q=alder&q=missing", "status=pending&status=invalid", "sort=oldest&sort=invalid", "pageSize=03&pageSize=0"]) {
      const params = new URLSearchParams(query);
      const response = await fetch(`${base}/tickets?${params}`);
      assert.equal(response.status, 200, query);
      assert.deepEqual(await response.json(), expected(records, params), query);
    }
    for (const [path, method, status, error] of [["/absent", "GET", 404, "not_found"], ["/tickets", "POST", 405, "method_not_allowed"]]) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
    }
  });
}

if (process.argv[3] === "contract") await contract();
else if (process.argv[3] === "validation") await validation();
else throw new Error("Unknown probe mode");
