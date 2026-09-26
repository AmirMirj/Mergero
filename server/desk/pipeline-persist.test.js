// Isolated DATA_DIR so this never touches the running app's data/db.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mergero-desk-"));
process.env.DATA_DIR = dir;

const { default: express } = await import("express");
const desk = await import("./routes.js");
const db = await import("../db.js");

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function json(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json() };
}

const profile = {
  company_name: "Nordic Screened Test Oy",
  sector: "B2B SaaS & Digital Services",
  products: "Fleet software for industrial workshops",
  customers: "Nordic industrials",
  ebitda: "€2.1M",
  verified: true,
  source_url: "https://nordic-screened-test.example",
  geographic_hint: "finland helsinki",
};

test("screened company added to pipeline stays on the homepage", async (t) => {
  await db.init();
  const app = express();
  app.use(express.json());
  desk.register(app, { baseUrl: "http://127.0.0.1:0" });
  const { server, url } = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const before = await json(`${url}/api/prospects`);
  assert.equal(before.status, 200);
  const beforeCount = before.body.count;
  assert.ok(!before.body.data.some((p) => p.company_name === profile.company_name));

  const buyers = await json(`${url}/api/buyers`);
  const buyer = buyers.body.data[0];
  assert.ok(buyer?.id, "seed buyers should be available");

  const added = await json(`${url}/api/deals/from-match`, {
    method: "POST",
    body: JSON.stringify({ buyer_id: buyer.id, profile }),
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.data.target, profile.company_name);

  const deals = await json(`${url}/api/deals`);
  assert.ok(deals.body.data.some((d) => d.target === profile.company_name));

  // Pipeline homepage is GET /api/prospects — this is what setTab('prospects') reloads.
  const home = await json(`${url}/api/prospects`);
  assert.equal(home.body.count, beforeCount + 1);
  const row = home.body.data.find((p) => p.company_name === profile.company_name);
  assert.ok(row, "screened company must remain on the pipeline homepage");
  assert.equal(row.country, "FI");
  assert.equal(row.sector, profile.sector);

  // Same company + another buyer must not duplicate the homepage row.
  const other = buyers.body.data.find((b) => b.id !== buyer.id) || buyer;
  await json(`${url}/api/deals/from-match`, {
    method: "POST",
    body: JSON.stringify({ buyer_id: other.id, profile }),
  });
  const home2 = await json(`${url}/api/prospects`);
  assert.equal(home2.body.data.filter((p) => p.company_name === profile.company_name).length, 1);

  await new Promise((r) => setTimeout(r, 80));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "db.json"), "utf8"));
  assert.ok(saved.companies.some((c) => c.name === profile.company_name), "company must be written to the store");
  assert.ok(saved.desk.deals.some((d) => d.profile?.company_name === profile.company_name));
});

test("every company is scored against the same buyer mandates", async (t) => {
  await db.init();
  const app = express();
  app.use(express.json());
  desk.register(app, { baseUrl: "http://127.0.0.1:0" });
  const { server, url } = await listen(app);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const buyers = await json(`${url}/api/buyers`);
  const n = buyers.body.count;
  assert.ok(n >= 2, "seed book should have more than one mandate");

  const home = await json(`${url}/api/prospects`);
  assert.ok(home.body.data.length >= 2);
  const counts = new Set();
  for (const row of home.body.data) {
    assert.equal(row.mandate_count, n, `${row.company_name} list row must use the full book`);
    const d = await json(`${url}/api/prospects/${row.company_id}`);
    const scored = d.body.data.scored;
    const suggested = d.body.data.hypothesis.suggested_buyers;
    assert.equal(scored.match_stats.n, n, `${row.company_name} match_stats.n`);
    assert.equal(scored.best_buyers.length, n, `${row.company_name} best_buyers`);
    assert.equal(suggested.length, n, `${row.company_name} suggested_buyers`);
    assert.equal(new Set(scored.best_buyers.map((b) => b.buyer_id)).size, n);
    counts.add(scored.best_buyers.length);
  }
  assert.equal(counts.size, 1, "every company must be scored against the same number of mandates");
});
