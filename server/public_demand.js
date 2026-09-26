// Public "value at first contact" surface: what buyers in the network are looking for, as an anonymised aggregate.
// New file: registers via register(app). Reads buyers/companies through db.js; the only write is an inbound lead.
// Nothing here ever returns a buyer name, id or email, or a company name.
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Async route wrapper → consistent JSON errors (same shape as index.js / suggest.js). Also catches synchronous throws.
export const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((err) => {
  console.error(`[${req.method} ${req.path}]`, err?.message || err);
  res.status(err.status || 500).json({ error: err?.message || String(err) });
});
const bad = (m) => Object.assign(new Error(m), { status: 400 });
const notFound = (what) => Object.assign(new Error(`${what} not found`), { status: 404 });

export const COUNTRIES = [
  { code: "FI", name: "Finland" },
  { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" },
  { code: "DK", name: "Denmark" },
  { code: "DE", name: "Germany" },
  { code: "AT", name: "Austria" },
  { code: "CH", name: "Switzerland" },
];
const BUYER_TYPES = ["PE", "family_office", "strategic"];
const DEAL_TYPES = ["majority", "minority", "growth"]; // always present in the output; other deal types are added as seen
const SOFT_ENTRY = new Set(["minority", "growth"]);
const IN_CONVERSATION = new Set(["replied", "warming", "meeting_booked", "mandate_signed"]);
const REVENUE_TOLERANCE = 0.3; // a buyer's revenue range counts if it overlaps revenue ±30%
const THESIS_MAX = 140;
const BANDS = [[2e6, "under €2M"], [5e6, "€2–5M"], [10e6, "€5–10M"], [25e6, "€10–25M"], [50e6, "€25–50M"]];

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const norm = (s) => String(s || "").trim().toLowerCase();
const qstr = (v) => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "");
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

export function sizeBand(revenue_eur) {
  const r = num(revenue_eur);
  if (r == null) return null;
  for (const [limit, label] of BANDS) if (r < limit) return `${label} revenue`;
  return "€50M+ revenue";
}

// Case-insensitive substring either way: "IT services" ↔ "Managed IT services".
const sectorOverlap = (a, b) => {
  const x = norm(a), y = norm(b);
  return Boolean(x && y) && (x.includes(y) || y.includes(x));
};
const coversSector = (buyer, sector) => (buyer.sectors || []).some((s) => sectorOverlap(s, sector));
const coversCountry = (buyer, country) => (buyer.geographies || []).some((g) => { const G = String(g).toUpperCase(); return G === country || G === "EU"; });
const coversRevenue = (buyer, r) => {
  const lo = num(buyer.revenue_min_eur), hi = num(buyer.revenue_max_eur);
  return (lo == null || r * (1 + REVENUE_TOLERANCE) >= lo) && (hi == null || r * (1 - REVENUE_TOLERANCE) <= hi);
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// One quiet line per buyer: the first sentence of the thesis, with the buyer's own name, emails and links scrubbed.
export function anonymiseThesis(buyer) {
  let text = String(buyer?.thesis || "").replace(/https?:\/\/\S+|\S+@\S+/g, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const name = String(buyer.name || "").trim();
  if (name) text = text.replace(new RegExp(escapeRe(name), "gi"), "this buyer");
  const m = text.match(/^.*?[.!?](?=\s|$)/); // terminator followed by a space or the end, so "2.4 M€" stays intact
  let sentence = (m ? m[0] : text).trim();
  if (sentence.length > THESIS_MAX) sentence = sentence.slice(0, THESIS_MAX - 1).replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "") + "…";
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// Up to `max` theses, alternating buyer types so the sample shows the range of the demand rather than three PE funds.
function sampleTheses(matched, max = 3) {
  const byType = new Map();
  for (const b of matched) {
    const t = b.buyer_type || "other";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(b);
  }
  const order = [...BUYER_TYPES, ...[...byType.keys()].filter((t) => !BUYER_TYPES.includes(t))];
  const queues = order.map((t) => byType.get(t) || []);
  const out = [];
  for (let i = 0; out.length < max && queues.some((q) => i < q.length); i++) {
    for (const q of queues) {
      if (out.length >= max) break;
      const s = q[i] ? anonymiseThesis(q[i]) : null;
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

// Anonymised aggregate of active buyer mandates for a profile. With companyId, blanks are filled from that company
// (country ← country, sector ← industry, revenue ← revenue_eur) and the company itself is left out of the owner counts.
export function demandSnapshot({ country, sector, revenue_eur, companyId } = {}) {
  const { companies, buyers } = db.load();
  if (companyId) {
    const self = db.findCompany(companyId);
    if (!self) throw notFound("Company");
    if (country == null || country === "") country = self.country;
    if (sector == null || sector === "") sector = self.industry;
    if (revenue_eur == null || revenue_eur === "") revenue_eur = self.revenue_eur;
  }
  country = String(country || "").trim().toUpperCase() || null;
  sector = String(sector || "").trim() || null;
  const revenue = num(revenue_eur);

  const matched = buyers.filter((b) => b.active !== false
    && (!country || coversCountry(b, country))
    && (!sector || coversSector(b, sector))
    && (revenue == null || coversRevenue(b, revenue)));

  const buyer_types = Object.fromEntries(BUYER_TYPES.map((t) => [t, 0]));
  const deal_types = Object.fromEntries(DEAL_TYPES.map((t) => [t, 0]));
  for (const b of matched) {
    const t = b.buyer_type || "other";
    buyer_types[t] = (buyer_types[t] || 0) + 1;
    for (const d of new Set((b.deal_types || []).map(norm))) if (d) deal_types[d] = (deal_types[d] || 0) + 1;
  }

  const talking = companies.filter((c) => IN_CONVERSATION.has(c.stage) && c.id !== companyId);
  return {
    country,
    sector,
    size_band: sizeBand(revenue),
    matched_mandates: matched.length,
    buyer_types,
    deal_types,
    soft_entry_available: matched.some((b) => (b.deal_types || []).some((d) => SOFT_ENTRY.has(norm(d)))),
    sample_theses: sampleTheses(matched),
    owners_in_conversation: talking.filter((c) => (!country || String(c.country || "").toUpperCase() === country) && (!sector || sectorOverlap(c.industry, sector))).length,
    total_owners_in_conversation: talking.length,
    generated_at: db.now(),
  };
}

export function options() {
  const seen = new Map(); // lowercase → first spelling seen
  for (const s of db.load().buyers.flatMap((b) => b.sectors || [])) {
    const label = String(s || "").trim();
    if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  }
  return { countries: COUNTRIES, sectors: [...seen.values()].sort((a, b) => a.localeCompare(b)) };
}

// ---- inbound leads ----
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LEAD_LIMIT = { max: 20, windowMs: 60 * 60 * 1000 }; // in memory, process-wide
const leadTimes = [];
function takeLeadSlot(now = Date.now()) {
  while (leadTimes.length && now - leadTimes[0] >= LEAD_LIMIT.windowMs) leadTimes.shift();
  if (leadTimes.length >= LEAD_LIMIT.max) throw Object.assign(new Error("Too many requests right now. Please try again in a little while."), { status: 429 });
  leadTimes.push(now);
}

export function createLead(body = {}) {
  const name = str(body.name, 120);
  const company = str(body.company, 160);
  const email = str(body.email, 200);
  const country = str(body.country, 10).toUpperCase();
  const sector = str(body.sector, 80);
  const message = str(body.message, 2000);
  if (!company) throw bad("Company name is required");
  if (!email) throw bad("Email is required");
  if (!EMAIL_RE.test(email)) throw bad("Please enter a valid email address");
  if (country && !COUNTRIES.some((c) => c.code === country)) throw bad("Unknown country");
  takeLeadSlot();
  const c = db.normalizeCompany({
    name: company,
    country: country || undefined,
    industry: sector,
    revenue_eur: num(body.revenue_eur),
    owner: { name, email },
    source: "Inbound: demand page",
    notes: message ? `Owner wrote: ${message}` : "",
  });
  db.load().companies.unshift(c);
  db.save();
  return { ok: true, id: c.id };
}

export function register(app) {
  app.get("/demand", (req, res) => res.sendFile(path.join(here, "..", "public", "demand.html")));
  app.get("/api/public/options", wrap(async (req, res) => res.json(options())));
  app.get("/api/public/demand", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const q = req.query || {};
    const token = qstr(q.token);
    if (token) {
      const c = db.load().companies.find((x) => x.intake?.token === token);
      if (!c) throw notFound("Intake link");
      return res.json(demandSnapshot({ companyId: c.id }));
    }
    const revenue_eur = qstr(q.revenue_eur);
    if (revenue_eur && num(revenue_eur) == null) throw bad("revenue_eur must be a number");
    res.json(demandSnapshot({ country: qstr(q.country), sector: qstr(q.sector), revenue_eur }));
  }));
  app.post("/api/public/leads", wrap(async (req, res) => res.json(createLead(req.body))));
}
