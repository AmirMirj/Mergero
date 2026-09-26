// MGX Deal Engine connector: live buyer mandates instead of a copied list.
// Mergero queries MGX through its API (and MCP); nothing is exported. Timo: the fields that matter are sector,
// financials/company size, deal type and geography. With MGX_API_URL set, the sync calls the API; without it, a clearly
// labelled sample (data/mock/mgx_buyers.json, same shape) stands in so the flow can be shown end to end.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(here, "..", "data", "mock", "mgx_buyers.json");

const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((err) => {
  console.error(`[${req.method} ${req.path}]`, err?.message || err);
  res.status(err.status || 500).json({ error: err?.message || String(err) });
});

export function config() {
  return { url: String(process.env.MGX_API_URL || "").replace(/\/+$/, ""), key: process.env.MGX_API_KEY || "", path: process.env.MGX_BUYERS_PATH || "/buyers" };
}

const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : String(v).split(/[,;|]/)).map((x) => String(x).trim()).filter(Boolean);
const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const TYPES = { pe: "PE", private_equity: "PE", "private equity": "PE", family_office: "family_office", "family office": "family_office", fo: "family_office", strategic: "strategic", corporate: "strategic", industrial: "strategic" };

// One MGX mandate → the engine's buyer shape. Accepts both nested (size: {...}) and flat field names.
export function normalize(r) {
  const size = r.size || r.financials || {};
  const id = r.mandate_id || r.id;
  return {
    mgx_id: id ? String(id) : null,
    name: r.buyer_label || r.name || "MGX buyer mandate",
    buyer_type: TYPES[String(r.buyer_type || r.type || "").toLowerCase()] || "PE",
    sectors: list(r.sectors ?? r.sector),
    geographies: list(r.geographies ?? r.geography).map((g) => g.toUpperCase()),
    revenue_min_eur: num(size.revenue_min_eur ?? r.revenue_min_eur),
    revenue_max_eur: num(size.revenue_max_eur ?? r.revenue_max_eur),
    ebitda_min_eur: num(size.ebitda_min_eur ?? r.ebitda_min_eur),
    ebitda_max_eur: num(size.ebitda_max_eur ?? r.ebitda_max_eur),
    deal_types: list(r.deal_types ?? r.deal_type).map((d) => d.toLowerCase()),
    thesis: r.thesis || r.description || "",
    active: r.active !== false && r.status !== "closed",
  };
}

async function fetchMandates() {
  const cfg = config();
  if (!cfg.url) {
    const rows = JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8"));
    return { source: "mgx-sample", rows: Array.isArray(rows) ? rows : rows.mandates || [] };
  }
  const r = await fetch(`${cfg.url}${cfg.path}`, { headers: { accept: "application/json", ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error(`MGX API answered ${r.status} ${r.statusText}`), { status: 502 });
  const body = await r.json();
  return { source: "mgx", rows: Array.isArray(body) ? body : body.mandates || body.buyers || body.items || [] };
}

// Upsert by MGX id: new mandates are added, known ones refreshed, mandates MGX no longer lists are marked inactive.
export async function sync() {
  const { source, rows } = await fetchMandates();
  const s = db.load();
  const seen = new Set();
  let added = 0, updated = 0;
  for (const raw of rows) {
    const b = normalize(raw);
    if (!b.mgx_id) continue;
    seen.add(b.mgx_id);
    const existing = s.buyers.find((x) => x.mgx_id === b.mgx_id);
    if (existing) { Object.assign(existing, b, { source, synced_at: db.now() }); updated++; }
    else { s.buyers.push({ id: db.uid("b"), ...b, source, synced_at: db.now() }); added++; }
  }
  let deactivated = 0;
  for (const b of s.buyers) if (b.mgx_id && b.source === source && !seen.has(b.mgx_id) && b.active) { b.active = false; deactivated++; }
  s.mgx = { last_sync: db.now(), source, mandates: seen.size };
  db.save();
  return { source, mandates: seen.size, added, updated, deactivated, total_buyers: s.buyers.length };
}

export function status() {
  const cfg = config();
  const s = db.load();
  return { connected: Boolean(cfg.url), mode: cfg.url ? "api" : "sample", url: cfg.url || null, last_sync: s.mgx?.last_sync || null, mandates: s.buyers.filter((b) => b.mgx_id).length };
}

export function register(app) {
  app.get("/api/mgx/status", (req, res) => res.json(status()));
  app.post("/api/mgx/sync", wrap(async (req, res) => res.json(await sync())));
}
