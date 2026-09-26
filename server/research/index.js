// Research step: map the company's own site, pull filed accounts from open registries, sweep the wider web,
// read one annual-report PDF, and keep only facts that carry a source. Also: watch mode (re-crawl + diff → alerts).
import crypto from "node:crypto";
import { crawlSite, readPages, categorize, USER_AGENT } from "./crawl.js";
import { fetchFinancials, fxToEur } from "../financials.js";
import * as agents from "../agents.js";

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_PDF_PAGES = 80;
const SNAPSHOT_URLS = 800;
const now = () => new Date().toISOString();
const uid = () => `a_${crypto.randomBytes(4).toString("hex")}`;
const yearIn = (s) => Number((String(s || "").match(/20\d{2}/g) || []).pop()) || null;

async function downloadPdf(url, timeoutMs = 30000) {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/pdf" }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") || 0) > MAX_PDF_BYTES) throw new Error("larger than 15 MB");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) throw new Error("larger than 15 MB");
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("not a PDF");
  const pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (pages > MAX_PDF_PAGES) throw new Error(`${pages} pages, limit ${MAX_PDF_PAGES}`);
  return buf;
}

// ---- financial rows from the PDF reader and from published mentions, in the registry row shape ----
async function toRow(year, currency, v, source, url, confidence) {
  const cur = (currency || "EUR").toUpperCase();
  const fx = await fxToEur(cur); // null for a currency with no ECB rate → leave EUR fields empty
  const e = (n) => (n == null || fx == null ? null : Math.round(n * fx));
  const ebitda = v.ebitda ?? (v.ebit != null && v.depreciation != null ? v.ebit + Math.abs(v.depreciation) : null);
  return {
    year, period_start: null, period_end: null, currency: cur,
    revenue: v.revenue ?? null, gross_profit: null, ebit: v.ebit ?? null, depreciation: v.depreciation ?? null, ebitda, net_income: v.net_income ?? null,
    total_assets: null, equity: null, employees: v.employees ?? null,
    revenue_eur: e(v.revenue), gross_profit_eur: null, ebit_eur: e(v.ebit), ebitda_eur: e(ebitda), net_income_eur: e(v.net_income), fx_to_eur: fx,
    ebitda_basis: v.ebitda != null ? "reported" : ebitda != null ? "derived" : null,
    source, url, confidence,
  };
}
const reportRows = (rep, url) => Promise.all(rep.years.map((y) => toRow(y.year, rep.currency, y, "Annual report PDF", url, "high")));
async function mentionRows(mentions) {
  const byYear = new Map();
  for (const m of mentions) {
    const k = `${m.year}|${m.url}`;
    const r = byYear.get(k) || { year: m.year, url: m.url, currency: m.currency || "EUR", v: {} };
    if (m.metric === "employees") r.v.employees = m.value; else { r.v[m.metric] = m.value; if (m.currency) r.currency = m.currency; }
    byYear.set(k, r);
  }
  return Promise.all([...byYear.values()].map((r) => toRow(r.year, r.currency, r.v, "Published figure (press/directory)", r.url, "medium")));
}
// One row per year: registry beats report PDF beats published mentions; later sources only fill gaps.
function mergeRows(...lists) {
  const byYear = new Map();
  for (const list of lists) for (const r of list) {
    const cur = byYear.get(r.year);
    if (!cur) { byYear.set(r.year, { ...r }); continue; }
    for (const k of ["revenue", "ebit", "ebitda", "net_income", "employees", "revenue_eur", "ebit_eur", "ebitda_eur", "net_income_eur"]) {
      if (cur[k] == null && r[k] != null) { cur[k] = r[k]; cur.also_from = [...new Set([...(cur.also_from || []), r.source])]; }
    }
    if (!cur.ebitda_basis && r.ebitda_basis) cur.ebitda_basis = r.ebitda_basis;
  }
  return [...byYear.values()].sort((a, b) => b.year - a.year);
}
const fmtM = (n) => `€${(n / 1e6).toFixed(1)}M`;
function dbConflicts(company, rows) {
  const out = [];
  const pick = (k) => rows.find((r) => r[k] != null && r.confidence === "high") || rows.find((r) => r[k] != null);
  const cmp = (label, db, row, k, fmt = fmtM) => {
    if (db == null || !row) return;
    const diff = Math.abs(row[k] - db) / Math.max(Math.abs(db), 1);
    if (diff > 0.25) out.push(`${label}: database ${fmt(db)} vs ${fmt(row[k])} in ${row.year} (${row.source}), ${Math.round(diff * 100)}% apart`);
  };
  cmp("Revenue", company.revenue_eur, pick("revenue_eur"), "revenue_eur");
  cmp("EBITDA", company.ebitda_eur, pick("ebitda_eur"), "ebitda_eur");
  cmp("Employees", company.employees, pick("employees"), "employees", (n) => String(n));
  return out;
}
const slimOrg = (o) => (o ? Object.fromEntries(["name", "legalName", "url", "description", "foundingDate", "founders", "numberOfEmployees", "address", "areaServed", "sameAs", "vatID", "taxID"]
  .filter((k) => o[k] != null && o[k] !== "" && !(Array.isArray(o[k]) && !o[k].length)).map((k) => [k, o[k]])) : null);

// ---- the research step ----
export async function research(company, settings, { log = () => {} } = {}) {
  const t0 = Date.now();
  const warnings = [];
  const crawl = company.website ? await crawlSite(company.website, { log }) : null;
  if (!crawl) warnings.push("No website on record, so the site crawl was skipped.");
  else if (!crawl.ok) warnings.push(`Site crawl failed: ${crawl.error}`);
  const pages = crawl?.ok ? crawl.pages : [];

  const [fin, site, web] = await Promise.all([
    fetchFinancials(company, { businessIds: crawl?.business_ids || [], log })
      .catch((e) => ({ identifier: null, rows: [], documents: [], notes: [`Registry lookup failed: ${e.message}`], checked: [] })),
    agents.extractPageFacts(company, pages, settings)
      .catch((e) => { warnings.push(`Fact extraction from site pages failed: ${e.message}`); return { facts: [], dropped: 0 }; }),
    agents.researchOffsite(company, crawl, settings)
      .catch((e) => { warnings.push(`Web search step failed: ${e.message}`); return { facts: [], financial_mentions: [], report_pdfs: [], dropped: 0, sources: 0 }; }),
  ]);

  // At most one annual-report PDF per run, and only if it can add a year the registries don't cover.
  let fromReport = [], reportDoc = null;
  const have = new Set(fin.rows.map((r) => r.year));
  const candidates = [
    ...(crawl?.documents || []).filter((d) => d.category === "reports").sort((a, b) => (b.year || 0) - (a.year || 0)),
    ...web.report_pdfs.map((url) => ({ url, year: yearIn(url) })),
  ].filter((d) => !d.year || d.year >= new Date().getFullYear() - 4);
  const pick = candidates.find((d) => !d.year || !have.has(d.year));
  if (pick) {
    try {
      const rep = await agents.readAnnualReport(company, await downloadPdf(pick.url), pick.url, settings);
      if (rep.is_this_company) {
        fromReport = await reportRows(rep, pick.url);
        reportDoc = { type: "annual_report", year: pick.year || fromReport[0]?.year || null, format: "pdf", url: pick.url, source: "Read from PDF" };
      } else warnings.push(`Report PDF ${pick.url} is for ${rep.entity_name}, so it was ignored.`);
    } catch (e) { warnings.push(`Annual report PDF skipped (${e.message}): ${pick.url}`); }
  }
  const rows = mergeRows(fin.rows, fromReport, await mentionRows(web.financial_mentions));
  const facts = [...site.facts, ...web.facts].map((f, i) => ({ id: `f${i + 1}`, ...f }));

  return {
    status: "done",
    ran_at: now(),
    duration_ms: Date.now() - t0,
    site: crawl ? {
      ok: crawl.ok, error: crawl.error, root: crawl.root, languages: crawl.languages || [],
      pages_found: crawl.inventory?.total || 0, pages_read: pages.length, by_category: crawl.inventory?.by_category || {},
      js_only: crawl.js_only, rendered_with: crawl.rendered_with, robots_blocked: Boolean(crawl.robots?.blocked),
      jsonld_org: slimOrg(crawl.jsonld?.organization), social: crawl.social || {}, business_ids: crawl.business_ids || [],
    } : null,
    pages: pages.map(({ url, category, title, lang, words, hash, rendered }) => ({ url, category, title, lang, words, hash, rendered })),
    facts,
    financials: {
      identifier: fin.identifier, rows, notes: fin.notes, checked: fin.checked,
      documents: [...fin.documents, ...(reportDoc ? [reportDoc] : [])],
      conflicts: dbConflicts(company, rows),
    },
    stats: { facts: facts.length, site_facts: site.facts.length, web_facts: web.facts.length, dropped_unverified: (site.dropped || 0) + (web.dropped || 0), web_sources: web.sources || 0 },
    warnings: [...(crawl?.warnings || []), ...warnings],
    snapshot: { at: now(), urls: (crawl?.inventory?.urls || []).slice(0, SNAPSHOT_URLS), hashes: Object.fromEntries(pages.map((p) => [p.url, p.hash])) },
  };
}

// ---- watch mode: what changed on the site since the last snapshot? ----
const SIGNALS = [
  ["leadership_change", /\b(ceo|managing director|toimitusjohtaja|verkställande direktör|vd\b|administrerende direktør|daglig leder|geschäftsführer|new (chief|head))/i],
  ["acquisition", /(acqui|merger|yrityskaup|förvärv|oppkjøp|opkøb|übernahme|fusion)/i],
  ["ownership", /(ownership|private equity|investor|pääomasijoit|omistaj|ägar|eier|ejer|eigentümer|beteiligung)/i],
  ["expansion", /(new (office|site|plant|factory|location)|expan|laajen|utvid|udvid|erweiter|eröffn|opens? )/i],
  ["financial_report", /(annual report|results|tilinpäätös|vuosikertomus|liikevaihto|årsredovisning|årsrapport|geschäftsbericht|umsatz)/i],
  ["hiring", /(recruit|hiring|vacanc|rekry|työpaik|lediga jobb|stilling|stellenangebot|careers?\/)/i],
];
const signalOf = (text) => (SIGNALS.find(([, re]) => re.test(text)) || [null])[0];
const WATCHED = new Set(["news", "careers", "reports", "direction", "offering", "footprint", "people", "customers"]);
const ALERT_CATEGORIES = new Set(["events", "direction", "people", "ownership", "footprint", "financials", "customers"]);

export async function watch(company, settings, { log = () => {} } = {}) {
  const r = company.research;
  if (!r?.snapshot || !company.website) throw Object.assign(new Error("Run research on this company first."), { status: 400 });
  const crawl = await crawlSite(company.website, { log });
  const at = now();
  if (!crawl.ok) return { checked_at: at, error: crawl.error, alerts: [] };
  const prevUrls = new Set(r.snapshot.urls || []);
  const prevHashes = r.snapshot.hashes || {};
  const newUrls = crawl.inventory.urls.filter((u) => !prevUrls.has(u)).map((u) => ({ url: u, category: categorize(u) })).filter((x) => WATCHED.has(x.category));
  const changed = crawl.pages.filter((p) => prevHashes[p.url] && prevHashes[p.url] !== p.hash && p.category !== "home");
  // The crawl's quotas may not pick the new URLs, so read up to 6 of them directly.
  const unread = newUrls.map((x) => x.url).filter((u) => !crawl.pages.some((p) => p.url === u)).slice(0, 6);
  const extra = unread.length ? await readPages(crawl.root, unread, { log }) : [];
  const fresh = [...crawl.pages.filter((p) => newUrls.some((x) => x.url === p.url)), ...extra];
  const toRead = [...fresh, ...changed].slice(0, 8);
  const { facts } = toRead.length ? await agents.extractPageFacts(company, toRead, settings) : { facts: [] };
  const known = new Set((r.facts || []).map((f) => agents.norm(f.quote)));
  const newFacts = facts.filter((f) => !known.has(agents.norm(f.quote)));

  const alerts = [
    ...newFacts.filter((f) => ALERT_CATEGORIES.has(f.category)).map((f) => ({ id: uid(), at, kind: "new_fact", category: f.category, signal: signalOf(`${f.claim} ${f.quote}`), title: f.claim, url: f.url })),
    ...newUrls.filter((x) => !newFacts.some((f) => f.url === x.url)).slice(0, 10).map((x) => ({ id: uid(), at, kind: "new_page", category: x.category, signal: signalOf(x.url), title: `New ${x.category} page`, url: x.url })),
    ...changed.filter((p) => !newFacts.some((f) => f.url === p.url)).slice(0, 5).map((p) => ({ id: uid(), at, kind: "changed_page", category: p.category, signal: signalOf(`${p.title} ${p.url}`), title: `${p.title || "Page"} changed`, url: p.url })),
  ];
  const newJobs = newUrls.filter((x) => x.category === "careers").length;
  if (newJobs >= 3) alerts.unshift({ id: uid(), at, kind: "hiring_spike", category: "careers", signal: "hiring", title: `${newJobs} new job pages since ${String(r.snapshot.at).slice(0, 10)}`, url: crawl.root });

  // Fold new facts into the dossier and move the baseline forward.
  const base = (r.facts || []).length;
  r.facts = [...(r.facts || []), ...newFacts.map((f, i) => ({ id: `f${base + i + 1}`, ...f, detected_at: at }))];
  r.snapshot = { at, urls: crawl.inventory.urls.slice(0, SNAPSHOT_URLS), hashes: { ...prevHashes, ...Object.fromEntries([...crawl.pages, ...extra].map((p) => [p.url, p.hash])) } };
  return { checked_at: at, new_urls: newUrls.length, changed_pages: changed.length, new_facts: newFacts.length, alerts };
}
