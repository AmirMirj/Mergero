// Integration surface for the teammate's components (scraper → profiles, NLP matcher → matches, mass mailer ↔ outbox/inbound).
// Everything here is a plain JSON contract (see docs/integration.md) so his parts can replace the built-in agents one by one.
// New file: registers via register(app). Mock payloads live in data/mock/ so the merge can be demoed before his code lands.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = path.join(here, "..", "data", "mock");
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(`[${req.method} ${req.path}]`, err?.message || err); res.status(err.status || 500).json({ error: err?.message || String(err) }); });
const bad = (m) => Object.assign(new Error(m), { status: 400 });

// Resolve a company by id, registry id, website host or exact name (his scraper may only know the domain).
function findCompanyLoose(ref = {}) {
  const { companies } = db.load();
  const host = (u) => { try { return new URL(u.startsWith("http") ? u : `https://${u}`).host.replace(/^www\./, ""); } catch { return ""; } };
  return companies.find((c) => c.id === ref.company_id) ||
    (ref.registry_id && companies.find((c) => c.registry_id === ref.registry_id)) ||
    (ref.website && companies.find((c) => c.website && host(c.website) === host(ref.website))) ||
    (ref.name && companies.find((c) => c.name.toLowerCase() === String(ref.name).toLowerCase())) || null;
}

// 1. Scraper output → company.research (same shape the built-in research step writes, so enrichment/outreach use it unchanged).
export function importProfiles(profiles, { source = "teammate-scraper" } = {}) {
  if (!Array.isArray(profiles)) throw bad("profiles must be an array");
  const s = db.load();
  const results = [];
  for (const p of profiles) {
    let c = findCompanyLoose(p.company || {});
    if (!c) {
      c = db.normalizeCompany({ ...(p.company || {}), owner: p.company?.owner || {}, source: `Scraper import (${source})` });
      s.companies.unshift(c);
    }
    const facts = (p.facts || []).map((f, i) => ({
      id: f.id || `x${i + 1}`, category: f.category || "other", claim: f.claim || f.text || "", quote: f.quote || "", url: f.url || f.source || "",
      as_of: f.as_of || f.date || null, confidence: f.confidence || "medium",
    })).filter((f) => f.claim);
    c.research = {
      ...(c.research || {}), source, imported_at: db.now(), facts, financials: p.financials || c.research?.financials || null,
      site: p.site || c.research?.site || null, pages_read: p.pages_read ?? c.research?.pages_read ?? null, summary: p.summary || c.research?.summary || "",
    };
    // Fill blanks from filed/scraped financials without overwriting database values.
    const fin = p.financials || {};
    if (c.revenue_eur == null && fin.revenue_eur != null) c.revenue_eur = Number(fin.revenue_eur);
    if (c.ebitda_eur == null && (fin.ebitda_eur ?? fin.ebit_eur) != null) c.ebitda_eur = Number(fin.ebitda_eur ?? fin.ebit_eur);
    if (c.employees == null && fin.employees != null) c.employees = Number(fin.employees);
    if (!c.website && p.company?.website) c.website = p.company.website;
    db.touch(c);
    results.push({ company_id: c.id, name: c.name, facts: facts.length });
  }
  return results;
}

// 2. NLP matcher output → company.matches (buyer_id + fit + reason; buyer may be referenced by name).
export function importMatches(matches, { replace = false } = {}) {
  if (!Array.isArray(matches)) throw bad("matches must be an array");
  const s = db.load();
  const byName = Object.fromEntries(s.buyers.map((b) => [b.name.toLowerCase(), b]));
  const touched = new Map();
  for (const m of matches) {
    const c = findCompanyLoose(m);
    const b = s.buyers.find((x) => x.id === m.buyer_id) || byName[String(m.buyer_name || "").toLowerCase()];
    if (!c || !b) continue;
    if (!touched.has(c.id)) { touched.set(c.id, c); if (replace) c.matches = []; }
    const fit = Math.max(0, Math.min(100, Math.round(Number(m.fit ?? m.score ?? 0) * (Number(m.fit ?? m.score) <= 1 ? 100 : 1))));
    const entry = { buyer_id: b.id, buyer_name: b.name, buyer_type: b.buyer_type, fit, reason: m.reason || m.explanation || "Matched by external matcher", source: m.source || "teammate-matcher" };
    const i = c.matches.findIndex((x) => x.buyer_id === b.id);
    if (i >= 0) c.matches[i] = { ...c.matches[i], ...entry }; else c.matches.push(entry);
    c.matches.sort((a, z) => z.fit - a.fit);
  }
  for (const c of touched.values()) db.touch(c);
  return { companies_updated: touched.size };
}

// 3. Outbox for an external mass mailer: every approved message on both sides, mailer-ready.
export function outbox({ status = "approved" } = {}) {
  const { companies, buyers, settings } = db.load();
  const items = [];
  for (const c of companies) for (const m of c.messages) if (m.status === status && m.channel === "email") {
    items.push({ side: "seller", message_id: m.id, company_id: c.id, to: c.owner?.email || null, to_name: c.owner?.name || null, subject: m.subject, body: m.body, step: m.step, send_after_days: m.send_after_days, language: m.language, framing: m.framing || null });
  }
  for (const b of buyers) for (const m of b.messages || []) if (m.status === status) {
    items.push({ side: "buyer", message_id: m.id, buyer_id: b.id, company_id: m.company_id, to: m.to, to_name: m.to_name, subject: m.subject, body: m.body });
  }
  return { from: settings.sender, count: items.length, items };
}

// 4. Delivery acknowledgements from the mailer, and inbound replies (both sides) routed into the existing flows.
export function ackSent(acks) {
  if (!Array.isArray(acks)) throw bad("acks must be an array");
  const s = db.load();
  let n = 0;
  for (const a of acks) {
    const found = db.findMessage(a.message_id);
    if (found) { found.message.status = "sent"; found.message.sent_at = a.sent_at || db.now(); found.message.provider_id = a.provider_id || null; db.advance(found.company, "contacted"); db.touch(found.company); n++; continue; }
    for (const b of s.buyers) { const m = (b.messages || []).find((x) => x.id === a.message_id); if (m) { m.status = "sent"; m.sent_at = a.sent_at || db.now(); m.provider_id = a.provider_id || null; n++; } }
  }
  db.save();
  return { acknowledged: n };
}

function readMock(name) {
  const p = path.join(MOCK_DIR, name);
  if (!fs.existsSync(p)) throw Object.assign(new Error(`Mock file ${name} not found`), { status: 404 });
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function register(app, { baseUrl }) {
  app.post("/api/integrations/profiles", wrap(async (req, res) => res.json({ imported: importProfiles(req.body?.profiles ?? req.body, { source: req.body?.source }) })));
  app.post("/api/integrations/matches", wrap(async (req, res) => res.json(importMatches(req.body?.matches ?? req.body, { replace: Boolean(req.body?.replace) }))));
  app.get("/api/integrations/outbox", (req, res) => res.json(outbox({ status: req.query.status || "approved" })));
  app.post("/api/integrations/outbox/ack", wrap(async (req, res) => res.json(ackSent(req.body?.acks ?? req.body))));
  // Inbound from the mailer: sellers go through the existing reply → triage flow (loopback call keeps one code path).
  app.post("/api/integrations/inbound", wrap(async (req, res) => {
    const { side = "seller", text, channel = "email" } = req.body || {};
    if (!text) throw bad("text is required");
    if (side === "buyer") {
      const b = db.load().buyers.find((x) => x.id === req.body.buyer_id) || (() => { throw bad("buyer_id not found"); })();
      b.replies = b.replies || []; b.replies.unshift({ id: db.uid("br"), company_id: req.body.company_id || null, from: req.body.from || null, text, at: db.now() });
      db.save(); return res.json({ ok: true, buyer_id: b.id, replies: b.replies.length });
    }
    const c = findCompanyLoose(req.body) || (() => { throw bad("company not found (company_id, registry_id, website or name)"); })();
    const r = await fetch(`${baseUrl}/api/companies/${c.id}/replies`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, channel }) });
    res.status(r.status).json(await r.json());
  }));
  // Mock adapters: demo the merge before the teammate's code lands.
  app.post("/api/integrations/mock/:what", wrap(async (req, res) => {
    const what = req.params.what;
    if (what === "profiles") return res.json({ imported: importProfiles(readMock("teammate_profiles.json"), { source: "mock-scraper" }) });
    if (what === "matches") return res.json(importMatches(readMock("teammate_matches.json")));
    throw bad("unknown mock: use profiles or matches");
  }));
}
