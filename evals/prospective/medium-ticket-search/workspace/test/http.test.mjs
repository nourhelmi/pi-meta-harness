import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createTicketServer } from "../src/http.mjs";
import { tickets } from "../data/tickets.mjs";

async function withServer(callback) {
  const server = createTicketServer(structuredClone(tickets));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("combined search has stable ordering and whole-result page counts", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/tickets?q=%20INVOICE%20&status=open&tag=%20BILLING%20&tag=urgent&pageSize=1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.items.map((item) => item.id), ["T-001"]);
    assert.equal(body.total, 2);
    assert.equal(body.totalPages, 2);
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 1);
    const second = await fetch(`${base}/tickets?q=invoice&status=open&tag=billing&tag=urgent&pageSize=1&page=2`);
    assert.deepEqual((await second.json()).items.map((item) => item.id), ["T-009"]);
  });
});

test("customer search, empty pages, and existing validation remain intact", async () => {
  await withServer(async (base) => {
    const customer = await fetch(`${base}/tickets?q=birch`);
    assert.equal((await customer.json()).total, 3);
    const empty = await fetch(`${base}/tickets?q=nonexistent&page=2`);
    assert.deepEqual(await empty.json(), { items: [], total: 0, page: 2, pageSize: 20, totalPages: 0 });
    for (const query of ["page=0", "page=1.5", "pageSize=51", "status=unknown", "sort="]) {
      const response = await fetch(`${base}/tickets?${query}`);
      assert.equal(response.status, 400, query);
      assert.deepEqual(await response.json(), { error: "invalid_query" });
    }
    assert.equal((await fetch(`${base}/unknown`)).status, 404);
    assert.equal((await fetch(`${base}/tickets`, { method: "POST" })).status, 405);
  });
});
