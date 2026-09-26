// Bridge to Son's Python company profiler (python/company-scraper/company_scraper.py): an optional data source for
// Finnish companies with per-fact evidence — PRH trade register, PRH digital (XBRL) financial statements with the
// filed line item behind every figure, and the company website with the page and quote behind every finding.
//
//   available()            → { ok, python: "python"|"python3"|null, version?, reason }        (cached 5 minutes)
//   profile(query, opts)   → the raw profile object, or { found: false, note } when PRH has no match
//   toFacts(profile)       → { facts, financials, people, website, business_id, name, founded, industry, city, summary, notes }
//   enrichCompany(company) → toFacts(...) + { query, warnings, raw }, or { skipped: true, reason } when it cannot run
//
// Facts follow the research-fact contract: { id, category, claim, quote, url, as_of, confidence, source: "son-scraper" }.
// Every field name read from the profile comes from company_scraper.py (parse_registry, fetch_financials +
// derive_metrics, scrape_website, build_profile). The Node app works without Python: available() says why not and
// enrichCompany() returns { skipped: true, reason } instead of throwing.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE = "son-scraper";
export const SCRAPER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "python", "company-scraper");
export const SCRIPT = path.join(SCRAPER_DIR, "company_scraper.py");
const SCRIPT_REL = "python/company-scraper/company_scraper.py";
const CACHE_MS = 5 * 60 * 1000;
const CHECK_TIMEOUT_MS = 15000;
const BUSINESS_ID_RE = /^\d{7}-\d$/;

// On Windows a piped Python stdout follows the console code page (cp1252), which cannot hold all of the JSON
// (ä, ö, …), so the child is told to write UTF-8 and we decode it as such.
const pyEnv = () => ({ ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" });
const dateOnly = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "");
const yearOf = (s) => Number(String(s || "").slice(0, 4)) || null;
const lastLine = (s) => String(s || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
const trunc = (s, n) => { const t = String(s || "").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------------------------------------------
// available(): a Python 3.9+ on PATH, the script in place, and its two runtime packages importable.
// ---------------------------------------------------------------------------------------------------------------
let cache = null; // { at, value }

function runSync(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: CHECK_TIMEOUT_MS, windowsHide: true, env: pyEnv() });
    return { status: r.status, out: `${r.stdout || ""}\n${r.stderr || ""}`.trim(), error: r.error || null };
  } catch (e) { return { status: null, out: "", error: e }; }
}

function detectPython() {
  for (const cmd of ["python", "python3"]) {
    const r = runSync(cmd, ["--version"]); // Python 2 prints to stderr; the Windows Store stub exits 9009
    const m = r.status === 0 ? /Python (\d+)\.(\d+)(?:\.\d+)?/.exec(r.out) : null;
    if (m && Number(m[1]) === 3 && Number(m[2]) >= 9) return { python: cmd, version: m[0].slice("Python ".length) };
  }
  return null;
}

export function available({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value;
  if (!existsSync(SCRIPT)) value = { ok: false, python: null, reason: `${SCRIPT_REL} not found` };
  else {
    const py = detectPython();
    if (!py) value = { ok: false, python: null, reason: "No Python 3.9+ interpreter on PATH (tried `python --version` and `python3 --version`)" };
    else {
      const r = runSync(py.python, ["-c", "import requests, bs4"]);
      value = r.status === 0
        ? { ok: true, python: py.python, version: py.version, reason: null }
        : { ok: false, python: py.python, version: py.version, reason: `Python packages missing (${lastLine(r.out) || "import requests, bs4 failed"}); run: pip install -r python/company-scraper/requirements.txt` };
    }
  }
  cache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// profile(): run `company_scraper.py "<query>" --json [...]` and return what it prints.
// ---------------------------------------------------------------------------------------------------------------
function runPython(python, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { cwd, env: pyEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    let timedOut = false, done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill(); // TerminateProcess on Windows, SIGTERM elsewhere; SIGKILL follows if it lingers
      setTimeout(() => { if (!done) { try { child.kill("SIGKILL"); } catch { /* already gone */ } } }, 3000).unref();
    }, timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.once("error", (e) => { if (done) return; done = true; clearTimeout(timer); reject(new Error(`Could not start ${python}: ${e.message}`)); });
    child.once("close", (code, signal) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

function parseJsonOutput(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* something else got printed around the JSON: cut it out */ }
  const starts = ["{", "["].map((c) => s.indexOf(c)).filter((i) => i >= 0);
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (!starts.length || end < 0) return null;
  try { return JSON.parse(s.slice(Math.min(...starts), end + 1)); } catch { return null; }
}
const first = (v) => (Array.isArray(v) ? v[0] ?? null : v); // --batch prints an array; one query prints an object

export async function profile(query, { website, withWebsite = true, withFinancials = true, timeoutMs = 120000 } = {}) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("son_scraper.profile: empty query (pass a company name or a Finnish Business ID)");
  const a = available();
  if (!a.ok) throw new Error(`Son's profiler is not available: ${a.reason}`);
  const outDir = mkdtempSync(path.join(tmpdir(), "son-scraper-")); // the CLI always saves <BusinessID>.json under --out
  const args = [SCRIPT, "--json", "--out", outDir];
  if (website) args.push("--website", String(website));
  if (!withWebsite) args.push("--no-website");
  if (!withFinancials) args.push("--no-financials");
  args.push("--", q); // after "--" the query can never be read as a flag
  try {
    const r = await runPython(a.python, args, { cwd: SCRAPER_DIR, timeoutMs });
    if (r.timedOut) throw new Error(`Son's profiler timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`} for "${q}"`);
    const parsed = first(parseJsonOutput(r.stdout));
    if (r.code === 2) { // nothing matched in PRH (or PRH did not answer): the CLI still prints { query, found: false, note }
      const note = parsed?.note || "No company found in the PRH register.";
      return { found: false, query: q, note, registry_error: /lookup failed|did not respond/i.test(note) };
    }
    if (r.code !== 0) throw new Error(`Son's profiler exited with code ${r.code ?? r.signal}${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ""}`);
    if (!parsed || typeof parsed !== "object") throw new Error(`Son's profiler printed no JSON for "${q}"${lastLine(r.stderr) ? ` (${lastLine(r.stderr)})` : ""}`);
    return parsed;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// toFacts(): profile → research facts + normalised financials/people/identity fields.
// ---------------------------------------------------------------------------------------------------------------
// Where each kind of finding lands (edit here to re-home a fact type).
const CATEGORY = {
  company_form: "ownership", previous_names: "ownership", address: "footprint", contact: "footprint", website: "footprint",
  industry: "other", founded: "other", status: "other", registers: "other", auxiliary_names: "other", founding_year_on_site: "other",
  financials: "financials", people: "people", description: "offering",
  signals: { family_business: "ownership", multi_generation: "ownership", succession_or_sale: "ownership", hiring: "careers", growth_or_expansion: "direction", certifications: "other" },
};
const SIGNAL_CLAIMS = {
  family_business: "The website describes the company as a family business",
  multi_generation: "The website says the business is run by a second or later generation",
  succession_or_sale: "The website mentions succession, an ownership change or a company sale",
  hiring: "The company is hiring: open positions or recruitment are mentioned on the website",
  growth_or_expansion: "The website mentions growth or expansion (loose keyword match)",
  certifications: "The website mentions quality, environmental or safety certifications (ISO or similar)",
};
const SIGNAL_CONFIDENCE = { growth_or_expansion: "low" }; // the rest default to medium (keyword heuristics)

// Financial line items to turn into facts, for the latest year and the year before. Keys are derive_metrics() output.
const FIN_ITEMS = [
  ["revenue", "Revenue", "eur"],
  ["revenue_growth_pct", "Revenue growth", "growth"],
  ["ebitda", "EBITDA", "eur"],
  ["operating_profit", "Operating profit (EBIT)", "eur"],
  ["net_profit", "Net profit", "eur"],
  ["personnel_costs", "Personnel costs", "eur"],
  ["equity_ratio_pct", "Equity ratio", "pct"],
];
// Inputs of the calculated figures (their evidence is the formula in financials.calculated plus the filed inputs).
const CALC_INPUTS = { ebitda: ["operating_profit", "depreciation"], revenue_growth_pct: ["revenue"], equity_ratio_pct: ["equity", "total_assets"] };

const fmtEur = (v) => {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  return a >= 1e6 ? `${s}€${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}€${Math.round(a / 1e3)}k` : `${s}€${Math.round(a)}`;
};
const fmtPct = (v) => `${Math.abs(v).toFixed(1)}%`;
const fyLabel = (end) => (end.endsWith("-12-31") ? `FY${end.slice(0, 4)}` : `the financial year ending ${end}`);
const xbrlQuote = (item, e) => `XBRL line item ${e.code} (${e.element}), context ${e.context}: ${item} = ${e.filed_value}`;

function registryFacts(r, p, add) {
  const url = r.register_page || r.source || "";
  const as_of = dateOnly(r.registry_last_modified) || dateOnly(p.scraped_at);
  const reg = (category, claim, quote) => add(category, claim, { quote, url, as_of, confidence: "high" });
  const who = `${r.name || "The company"} (${r.business_id})`;
  if (r.company_form) {
    const fi = r.company_form_fi && r.company_form_fi !== r.company_form ? ` (${r.company_form_fi})` : "";
    reg(CATEGORY.company_form, `${who} is registered as: ${r.company_form}${fi}`, `YTJ company form: ${r.company_form}${fi}`);
  }
  if (r.industry || r.industry_fi) {
    reg(CATEGORY.industry, `Main line of business (TOL ${r.industry_code || "n/a"}): ${r.industry || r.industry_fi}`, `YTJ mainBusinessLine ${r.industry_code || ""}: ${r.industry_fi || r.industry}`.trim());
  }
  const regDate = r.registered_on || r.business_id_granted_on;
  if (regDate) {
    const age = r.company_age_years != null ? ` (${r.company_age_years} years ago)` : "";
    reg(CATEGORY.founded, `Registered in the trade register on ${regDate}${age}`, `YTJ registrationDate: ${r.registered_on || "–"}; Business ID granted: ${r.business_id_granted_on || "–"}`);
  }
  if (r.trade_register_status || r.active != null) {
    const claim = r.active
      ? `Active company (trade register status: ${r.trade_register_status || "Registered"})`
      : `NOT an active company: trade register status "${r.trade_register_status || "unknown"}"${r.ended_on ? `, ended on ${r.ended_on}` : ""}`;
    reg(CATEGORY.status, claim, `YTJ tradeRegisterStatus: ${r.trade_register_status || "–"}; endDate: ${r.ended_on || "–"}`);
  }
  for (const s of r.situations || []) {
    reg(CATEGORY.status, `${s.type} registered on ${s.since || "an unknown date"}${s.until ? `, ended ${s.until}` : " (ongoing)"}`, `YTJ companySituations: ${s.type} ${s.since || ""}${s.until ? ` – ${s.until}` : ""}`.trim());
  }
  const entry = (name) => (r.registers || []).find((e) => e.register === name && !e.until);
  const emp = entry("Employer register"), vat = entry("VAT register");
  reg(CATEGORY.registers,
    r.in_employer_register ? `Registered as an employer (employer register${emp?.since ? ` since ${emp.since}` : ""})`
      : `Not in the employer register${r.left_employer_register_on ? ` (left it on ${r.left_employer_register_on})` : ""}, so it may have no salaried staff`,
    `YTJ registeredEntries, Employer register: ${r.in_employer_register ? `active${emp?.since ? ` since ${emp.since}` : ""}` : `none active${r.left_employer_register_on ? `, ended ${r.left_employer_register_on}` : ""}`}`);
  reg(CATEGORY.registers,
    r.vat_registered ? `VAT-registered${vat?.since ? ` since ${vat.since}` : ""}` : "Not in the VAT register",
    `YTJ registeredEntries, VAT register: ${r.vat_registered ? `active${vat?.since ? ` since ${vat.since}` : ""}` : "none active"}`);
  const addr = r.street_address || r.postal_address;
  if (addr || r.municipality) {
    const city = addr && r.municipality && !addr.includes(r.municipality) ? ` (${r.municipality})` : "";
    reg(CATEGORY.address, `Registered address: ${addr || r.municipality}${city}`, `YTJ addresses: ${[r.street_address, r.postal_address].filter(Boolean).join(" | ") || r.municipality}`);
  }
  if (r.previous_names?.length) reg(CATEGORY.previous_names, `Registered earlier under other names: ${r.previous_names.join(", ")}`, `YTJ names (previous): ${r.previous_names.join("; ")}`);
  if (r.auxiliary_names?.length) reg(CATEGORY.auxiliary_names, `Also trades under auxiliary names: ${r.auxiliary_names.join(", ")}`, `YTJ names (auxiliary): ${r.auxiliary_names.join("; ")}`);
}

function financialFacts(fin, add) {
  const allYears = Object.keys(fin.years || {}).sort().reverse(); // period-end dates, latest first
  const url = fin.source || "";
  for (const end of allYears.slice(0, 2)) {
    const y = fin.years[end] || {}, ev = fin.evidence?.[end] || {}, fy = fyLabel(end);
    const prevEnd = allYears[allYears.indexOf(end) + 1];
    for (const [item, label, kind] of FIN_ITEMS) {
      const v = num(y[item]);
      if (v == null) continue;
      const filed = ev[item];
      let quote;
      if (filed) quote = xbrlQuote(item, filed);
      else {
        const inputs = (CALC_INPUTS[item] || []).map((k) => (ev[k] ? `${k} = ${ev[k].filed_value} (${ev[k].code}, context ${ev[k].context})` : num(y[k]) != null ? `${k} = ${y[k]}` : null)).filter(Boolean);
        if (item === "revenue_growth_pct" && prevEnd) {
          const pe = fin.evidence?.[prevEnd]?.revenue;
          inputs.push(pe ? `revenue ${prevEnd} = ${pe.filed_value} (${pe.code}, context ${pe.context})` : `revenue ${prevEnd} = ${fin.years[prevEnd]?.revenue}`);
        }
        quote = `Calculated: ${fin.calculated?.[item] || label}${inputs.length ? ` — from ${inputs.join("; ")}` : ""}`;
      }
      const claim = kind === "eur" ? `${label} was ${fmtEur(v)} in ${fy} (digital financial statement filed with PRH)`
        : kind === "growth" ? `Revenue ${v >= 0 ? "grew" : "fell"} ${fmtPct(v)} in ${fy} compared with the year before`
        : `${label} was ${fmtPct(v)} at the end of ${fy}`;
      add(CATEGORY.financials, claim, { quote, url, as_of: end, confidence: filed ? "high" : "medium" });
    }
  }
}

function normaliseFinancials(fin) {
  if (!fin?.available) return null;
  const all = Object.keys(fin.years || {}).sort().reverse();
  if (!all.length) return null;
  const pick = (end) => {
    const y = fin.years[end] || {};
    return {
      year: yearOf(end), period_end: end,
      revenue_eur: num(y.revenue), ebitda_eur: num(y.ebitda), ebit_eur: num(y.operating_profit), net_income_eur: num(y.net_profit),
      personnel_costs_eur: num(y.personnel_costs), total_assets_eur: num(y.total_assets), equity_eur: num(y.equity),
      equity_ratio: num(y.equity_ratio_pct), growth: num(y.revenue_growth_pct), ebitda_margin: num(y.ebitda_margin_pct),
    };
  };
  // No headcount: the small-company XBRL taxonomy mapped by the profiler has no employee figure.
  return { ...pick(all[0]), currency: "EUR", prior: all[1] ? pick(all[1]) : null, url: fin.source || "", source: "PRH XBRL via Son's profiler" };
}

// ---- people: company_scraper.py lists short text blocks that contain a role word; split them into name + role ----
const ROLE_WORDS = [ // more specific first; each maps to an English role
  ["hallituksen puheenjohtaja", "Chairman of the board"], ["toimitusjohtaja", "CEO"], ["talousjohtaja", "CFO"], ["myyntijohtaja", "Sales director"],
  ["perustaja", "Founder"], ["omistaja", "Owner"], ["yrittäjä", "Owner-entrepreneur"], ["osakas", "Partner"],
  ["co-founder", "Co-founder"], ["founder", "Founder"], ["managing director", "Managing director"], ["ceo", "CEO"], ["chairman", "Chairman"],
  ["cfo", "CFO"], ["owner", "Owner"], ["partner", "Partner"], ["vd", "CEO (VD)"], ["ägare", "Owner"],
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// \b is ASCII-only in JS regexes, so word edges are checked with Unicode letter lookarounds (ä, ö, å are letters).
const ROLE_RES = ROLE_WORDS.map(([w, role]) => [new RegExp(`(?<!\\p{L})${esc(w)}(?!\\p{L})`, "giu"), role]);
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+358|(?<!\d)0)[\s-]?\d{1,3}(?:[\s-]?\d{2,4}){2,3}/g;
const TOKEN = "\\p{Lu}[\\p{Ll}'’]+(?:-\\p{Lu}?[\\p{Ll}'’]+)*"; // Matti, Anna-Liisa, O'Neill
const NAME_RE = new RegExp(`(?<![\\p{L}-])${TOKEN}(?:\\s+(?:${TOKEN}|von|van|af|de|der|la|le)){1,3}(?!\\p{L})`, "gu");
const TOKEN_RE = new RegExp(`^${TOKEN}$`, "u");
const NOT_NAME = new Set(["oy", "ab", "ky", "ltd", "oyj", "tmi", "puh", "tel", "gsm", "email", "sähköposti", "ota", "yhteyttä", "yhteystiedot", "contact"]);

export function parsePerson(text) {
  let t = String(text || "").replace(EMAIL_RE, " ").replace(PHONE_RE, " ");
  const roles = [];
  for (const [re, role] of ROLE_RES) {
    re.lastIndex = 0;
    if (!re.test(t)) continue;
    if (!roles.includes(role)) roles.push(role);
    t = t.replace(re, " ");
  }
  let name = null;
  for (const m of t.matchAll(NAME_RE)) {
    const tokens = m[0].trim().split(/\s+/);
    while (tokens.length && NOT_NAME.has(tokens[0].toLowerCase())) tokens.shift();
    while (tokens.length && NOT_NAME.has(tokens[tokens.length - 1].toLowerCase())) tokens.pop();
    if (tokens.filter((x) => TOKEN_RE.test(x)).length < 2) continue;
    name = tokens.join(" ");
    break;
  }
  return { roles, name };
}

// website.url_source values from build_profile(): "registry", "given", "guessed (verified by name/Business ID on page)"
const URL_SOURCE = { registry: "listed in the PRH register", given: "the website on our record" };
const urlSourceText = (s) => URL_SOURCE[s] || (String(s || "").startsWith("guessed") ? "domain guessed and verified by the company name or Business ID on the page" : String(s || ""));

function websiteFacts(w, p, add) {
  const ev = w.evidence || {};
  const as_of = dateOnly(w.retrieved_at) || dateOnly(p.scraped_at);
  const pageOf = (kind, key) => ev[kind]?.[key]?.page || w.url;
  const snippetOf = (kind, key) => ev[kind]?.[key]?.snippet || "";
  const verified = w.url_source === "registry" || w.url_source === "given" || w.url_evidence?.verified_by === "Business ID";
  add(CATEGORY.website, `Company website: ${w.url}${w.url_source ? ` — ${urlSourceText(w.url_source)}` : ""}`, { quote: w.url_evidence?.snippet || w.title || "", url: w.url, as_of, confidence: verified ? "high" : "medium" });
  if (w.meta_description) {
    add(CATEGORY.description, `Website self-description: ${trunc(w.meta_description, 240)}`, { quote: trunc(w.meta_description, 400), url: ev.meta_description?.page || w.url, as_of, confidence: "medium" });
  }
  const people = [], seen = new Set();
  for (const text of w.people_mentions || []) {
    const person = parsePerson(text);
    if (!person.roles.length) continue;
    const role = person.roles.join(" / ");
    add(CATEGORY.people,
      person.name ? `${person.name} is named as ${role} on the company website` : `The website mentions a ${role} (name not parsed): "${trunc(text, 120)}"`,
      { quote: trunc(text, 300), url: pageOf("people_mentions", text), as_of, confidence: person.name ? "medium" : "low" });
    if (person.name && !seen.has(person.name.toLowerCase())) { seen.add(person.name.toLowerCase()); people.push({ name: person.name, role }); }
  }
  for (const [key, snippet] of Object.entries(w.signals || {})) {
    const e = ev.signals?.[key] || {};
    add(CATEGORY.signals[key] || "other", `${SIGNAL_CLAIMS[key] || `Website signal: ${key}`}${e.matched ? ` (matched "${e.matched}")` : ""}`,
      { quote: e.snippet || snippet, url: e.page || w.url, as_of, confidence: SIGNAL_CONFIDENCE[key] || "medium" });
  }
  for (const y of (w.founding_years_mentioned || []).slice(0, 3)) {
    add(CATEGORY.founding_year_on_site, `The website dates the business to ${y}`, { quote: snippetOf("founding_years_mentioned", y), url: pageOf("founding_years_mentioned", y), as_of, confidence: "medium" });
  }
  const PLACEHOLDER_EMAIL = /firstname|lastname|etunimi|sukunimi|example\.|domain\./i; // "firstname.lastname@…" is a pattern, not an address
  for (const e of (w.emails || []).filter((x) => !PLACEHOLDER_EMAIL.test(x)).slice(0, 5)) add(CATEGORY.contact, `Contact email published on the website: ${e}`, { quote: snippetOf("emails", e) || e, url: pageOf("emails", e), as_of, confidence: "high" });
  for (const ph of (w.phones || []).slice(0, 3)) add(CATEGORY.contact, `Phone number published on the website: ${ph}`, { quote: snippetOf("phones", ph) || ph, url: pageOf("phones", ph), as_of, confidence: "high" });
  for (const s of (w.social_links || []).slice(0, 5)) add(CATEGORY.contact, `Social media profile linked from the website: ${s}`, { quote: snippetOf("social_links", s) || s, url: pageOf("social_links", s), as_of, confidence: "high" });
  return { people, siteYears: w.founding_years_mentioned || [] };
}

export function toFacts(p) {
  const facts = [];
  let n = 0;
  const add = (category, claim, { quote = "", url = "", as_of = "", confidence = "medium" } = {}) => {
    if (!claim) return;
    facts.push({ id: `s${++n}`, category, claim: String(claim), quote: trunc(quote, 600), url: url || "", as_of: as_of || "", confidence, source: SOURCE });
  };
  const notes = [];
  if (!p?.found || !p.registry) {
    if (p?.note) notes.push(p.note);
    return { facts, financials: null, people: [], website: null, business_id: p?.business_id || null, name: p?.name || null, founded: null, founded_note: null, registered_on: null, industry: null, industry_code: null, city: null, summary: null, notes };
  }
  const r = p.registry, fin = p.financials, w = p.website;
  registryFacts(r, p, add);
  if (fin) { if (fin.available) financialFacts(fin, add); else if (fin.note) notes.push(`Financials: ${fin.note}`); }
  let people = [], siteYears = [];
  if (w) { if (w.available) ({ people, siteYears } = websiteFacts(w, p, add)); else if (w.note) notes.push(`Website: ${w.note}`); }

  // founded: the register date, unless it predates PRH's electronic register (1979, see server/registry.js); then what the site says.
  const regYear = yearOf(r.registered_on || r.business_id_granted_on);
  const siteYear = siteYears.map(Number).filter((y) => y > 1800).sort()[0] || null;
  const founded = regYear && regYear > 1978 ? regYear : siteYear;
  const founded_note = regYear && regYear <= 1978 ? `registered before 1979${siteYear ? `; website mentions ${siteYear}` : ""}`
    : siteYear && siteYear !== founded ? `website mentions ${siteYear}` : null;

  return {
    facts,
    financials: normaliseFinancials(fin),
    people,
    website: (w?.available && w.url) || r.website || null,
    business_id: r.business_id || null,
    name: r.name || null,
    founded, founded_note,
    registered_on: r.registered_on || r.business_id_granted_on || null, // the raw register date, whatever the founded rule decided
    industry: r.industry || r.industry_fi || null,
    industry_code: r.industry_code || null,
    city: r.municipality || null,
    summary: (w?.available && (trunc(w.meta_description, 600) || trunc(w.about_text, 300))) || null,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// enrichCompany(): one call for a Company row → facts + normalised fields, or { skipped, reason }.
// ---------------------------------------------------------------------------------------------------------------
const normName = (s) => String(s || "").toLowerCase().normalize("NFKC").replace(/\b(oy|oyj|ab|ky|ay|ltd|abp|tmi)\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const sameCompany = (a, b) => { const x = normName(a), y = normName(b); return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x)); };

export async function enrichCompany(company = {}, opts = {}) {
  const a = available();
  if (!a.ok) return { skipped: true, reason: a.reason };
  if (company.country && String(company.country).toUpperCase() !== "FI") return { skipped: true, reason: `Son's profiler covers Finnish companies only (company country is ${company.country})` };
  const rid = String(company.registry_id || "").trim();
  const byId = BUSINESS_ID_RE.test(rid);
  const query = byId ? rid : String(company.name || "").trim();
  if (!query) return { skipped: true, reason: "Company has neither a Finnish Business ID (registry_id) nor a name to look up" };

  const raw = await profile(query, { website: company.website || undefined, ...opts });
  if (!raw.found) return { skipped: true, reason: raw.note || "No company found in the PRH register.", found: false, raw };

  const warnings = [];
  if (!byId && company.name && !sameCompany(company.name, raw.registry?.name)) {
    const others = raw.other_matches?.length ? ` (${raw.other_matches.length} other matches)` : "";
    warnings.push(`PRH matched "${raw.registry.name}" (${raw.registry.business_id}) for "${company.name}"; check it is the same company${others}`);
  }
  return { ...toFacts(raw), query, warnings, raw };
}
