// Filed financial statements from official open registries, normalised to yearly rows (+ EUR conversions).
// NO: Brønnøysund Regnskapsregisteret · FI: PRH digital (iXBRL) statements · DK: Virk annual-report XBRL.
const UA = "MergeroOriginationEngine/0.1 (hackathon demo; registry financials)";
const SRC = { NO: "Brønnøysund Regnskapsregisteret (NO)", FI: "PRH digital financial statements (FI)", DK: "Virk annual report XBRL (DK)" };
const HOME_CCY = { NO: "NOK", FI: "EUR", DK: "DKK" };

async function get(url, { signal, ms = 10000, accept = "application/json" } = {}) {
  const timeout = AbortSignal.timeout(ms);
  const res = await fetch(url, { headers: { accept, "user-agent": UA }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} responded ${res.status}`), { status: res.status });
  return res;
}
const getJson = async (url, o) => (await get(url, o)).json();
const getText = async (url, o) => (await get(url, { ...o, accept: "application/xml, text/xml, */*" })).text();

// PRH answers bursts with HTTP 429, so all avoindata.prh.fi calls are queued with a short gap.
let prhQueue = Promise.resolve();
function prh(url, o, as = "json") {
  const call = prhQueue.then(() => (as === "json" ? getJson(url, o) : getText(url, o)));
  prhQueue = call.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 300)));
  return call;
}

// ---- FX: ECB reference rates (CUR per 1 EUR), cached 12h; rough constants when ECB is unreachable.
const FX_FALLBACK = { NOK: 11.7, SEK: 11.3, DKK: 7.46, USD: 1.08, GBP: 0.85, CHF: 0.94 };
const fxCache = new Map();

function fxQuote(currency) {
  const cur = String(currency || "EUR").trim().toUpperCase();
  if (cur === "EUR") return Promise.resolve({ cur, perEur: 1, m: 1, fallback: false });
  const hit = fxCache.get(cur);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const entry = { at: Date.now(), ttl: 12 * 3600e3 };
  entry.promise = (/^[A-Z]{3}$/.test(cur) ? getJson(`https://data-api.ecb.europa.eu/service/data/EXR/D.${cur}.EUR.SP00.A?lastNObservations=1&format=jsondata`, { ms: 6000 }) : Promise.reject(new Error("bad code")))
    .then((d) => {
      const obs = Object.values(Object.values(d.dataSets?.[0]?.series || {})[0]?.observations || {});
      const perEur = Number(obs.at(-1)?.[0]), date = d.structure?.dimensions?.observation?.[0]?.values?.at(-1)?.id || null;
      if (!(perEur > 0) || (date && Date.now() - Date.parse(date) > 30 * 86400e3)) throw new Error("no current ECB rate");
      return { cur, perEur, m: 1 / perEur, date, fallback: false };
    })
    .catch(() => {
      entry.ttl = 10 * 60e3; // retry ECB soon
      const perEur = FX_FALLBACK[cur] ?? null;
      return { cur, perEur, m: perEur ? 1 / perEur : null, fallback: true };
    });
  fxCache.set(cur, entry);
  return entry.promise;
}

// Multiplier m: amount_in_currency * m = EUR (null only for a currency with neither ECB rate nor fallback).
export async function fxToEur(currency) {
  return (await fxQuote(currency)).m;
}

// ---- IDs: NO organisasjonsnummer + FI Y-tunnus (both mod-11 checked), DK CVR (8 digits).
const ID_TYPE = { NO: "NO_ORGNR", FI: "FI_YTUNNUS", DK: "DK_CVR" };
const ID_NAME = { NO: "organisasjonsnummer", FI: "Y-tunnus", DK: "CVR number" };
const mod11 = (d, w) => w.reduce((s, x, i) => s + x * d[i], 0) % 11;
const ID_FORMAT = {
  NO: (v) => {
    const d = String(v ?? "").replace(/^\s*NO/i, "").replace(/\D/g, "");
    const r = mod11(d, [3, 2, 7, 6, 5, 4, 3, 2]);
    return d.length === 9 && (r ? 11 - r : 0) === +d[8] ? d : null;
  },
  FI: (v) => {
    let d = String(v ?? "").replace(/^\s*FI/i, "").replace(/\D/g, "");
    if (d.length === 7) d = `0${d}`; // old 6+1 digit form
    const r = mod11(d, [7, 9, 10, 5, 8, 4, 2]);
    return d.length === 8 && (r ? 11 - r : 0) === +d[7] ? `${d.slice(0, 7)}-${d[7]}` : null;
  },
  DK: (v) => {
    const d = String(v ?? "").replace(/^\s*DK/i, "").replace(/\D/g, "");
    return /^[1-9]\d{7}$/.test(d) ? d : null;
  },
};

// ---- Name / website matching: registry name searches are fuzzy, so only accept a website-domain match or a unique exact name.
const LEGAL = new Set(["oy", "oyj", "ab", "abp", "ky", "ay", "tmi", "osk", "as", "asa", "ans", "da", "nuf", "sa", "ba", "aps", "ivs", "ps", "ks", "is", "amba", "smba", "ltd", "limited", "inc", "gmbh", "ag", "plc", "llc"]);
const normName = (s) => String(s || "").toLowerCase().replace(/\b([aipk])\/s\b/g, "$1s").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter((w) => w && !LEGAL.has(w)).join(" ");
const hostOf = (u) => {
  try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
};
const sameSite = (a, b) => {
  const x = hostOf(a || ""), y = hostOf(b || "");
  return !!x && !!y && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`));
};

function pickMatch(cands, company) {
  const want = normName(company.name);
  const exact = (list) => list.filter((c) => want && c.names.some((n) => normName(n) === want));
  const site = cands.filter((c) => c.site && company.website && sameSite(c.site, company.website));
  if (site.length) return exact(site)[0] || site[0];
  const ex = exact(cands);
  return new Set(ex.map((c) => c.id)).size === 1 ? ex[0] : null;
}

const SEARCH = {
  NO: {
    label: "Brønnøysund Enhetsregisteret (name search)",
    run: async (q, o) => ((await getJson(`https://data.brreg.no/enhetsregisteret/api/enheter?${new URLSearchParams({ navn: q, size: "20" })}`, o))._embedded?.enheter || [])
      .map((e) => ({ id: e.organisasjonsnummer, names: [e.navn], site: e.hjemmeside })),
  },
  FI: {
    label: "PRH/YTJ company search (name)",
    run: async (q, o) => ((await prh(`https://avoindata.prh.fi/opendata-ytj-api/v3/companies?${new URLSearchParams({ name: q })}`, o)).companies || [])
      .map((c) => ({ id: c.businessId?.value, names: (c.names || []).filter((n) => !n.endDate).map((n) => n.name), site: c.website?.url })),
  },
  DK: {
    label: "cvrapi.dk (name search)",
    run: async (q, o) => {
      const d = await getJson(`https://cvrapi.dk/api?${new URLSearchParams({ search: q, country: "dk" })}`, o);
      return d?.vat ? [{ id: String(d.vat), names: [d.name], site: d.email?.split("@")[1] }] : []; // CVR has no website field: match the email domain
    },
  },
};

async function resolveId(company, businessIds, country, o, out) {
  const fmt = ID_FORMAT[country];
  let id = fmt(company.registry_id);
  if (id) return { country, id, source: "registry_id" };
  if (company.registry_id) out.notes.push(`registry_id "${company.registry_id}" is not a valid ${ID_NAME[country]} — ignored`);
  for (const b of businessIds || []) if (b?.type === ID_TYPE[country] && (id = fmt(b.value))) return { country, id, source: "website" };
  const q = normName(company.name);
  if (!q) return null;
  out.checked.push(SEARCH[country].label);
  const cands = await SEARCH[country].run(q, o).catch((e) => {
    if (e.status !== 404) out.notes.push(`${SEARCH[country].label} failed: ${e.message}`);
    return [];
  });
  const hit = pickMatch(cands, company);
  return hit && (id = fmt(hit.id)) ? { country, id, source: "name_search" } : null;
}

// ---- Rows
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const hasFigures = (r) => ["revenue", "gross_profit", "ebit", "net_income", "total_assets", "equity"].some((k) => r[k] != null);

function row(f, source, url) {
  const dep = num(f.depreciation);
  const r = {
    year: Number(String(f.period_end || "").slice(0, 4)) || null, period_start: f.period_start || null, period_end: f.period_end || null,
    currency: String(f.currency || "EUR").toUpperCase(),
    revenue: num(f.revenue), gross_profit: num(f.gross_profit), ebit: num(f.ebit), depreciation: dep == null ? null : Math.abs(dep), ebitda: null,
    net_income: num(f.net_income), total_assets: num(f.total_assets), equity: num(f.equity), employees: num(f.employees),
    revenue_eur: null, gross_profit_eur: null, ebit_eur: null, ebitda_eur: null, net_income_eur: null, fx_to_eur: null,
    ebitda_basis: null, source, url, confidence: "high",
  };
  if (r.ebit != null && r.depreciation != null) Object.assign(r, { ebitda: Math.round((r.ebit + r.depreciation) * 100) / 100, ebitda_basis: "derived" });
  return r;
}

async function addEur(out) {
  for (const cur of new Set(out.rows.map((r) => r.currency))) {
    const q = await fxQuote(cur);
    for (const r of out.rows.filter((x) => x.currency === cur)) {
      r.fx_to_eur = q.m;
      for (const k of ["revenue", "gross_profit", "ebit", "ebitda", "net_income"]) r[`${k}_eur`] = r[k] == null || q.m == null ? null : Math.round(r[k] * q.m);
    }
    if (cur === "EUR") continue;
    out.notes.push(q.m == null ? `No EUR rate available for ${cur}`
      : q.fallback ? `ECB rates unreachable — approximate FX used (1 EUR ≈ ${q.perEur} ${cur})`
      : `EUR figures use the latest ECB reference rate (1 EUR = ${q.perEur} ${cur}, ${q.date}), not period averages`);
  }
}

// ---- Minimal, prefix-agnostic XBRL instance reader → numeric facts with period, dimensions and unit.
function readXbrl(xml) {
  const tag = (body, t) => body.match(new RegExp(`<(?:[\\w-]+:)?${t}>\\s*([^<\\s]+)`))?.[1] ?? null;
  const ctx = {}, unit = {}, facts = [];
  for (const [, id, body] of xml.matchAll(/<(?:[\w-]+:)?context\b[^>]*?\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?context>/g)) {
    const dims = [...body.matchAll(/dimension="(?:[\w-]+:)?([^"]+)"[^>]*>\s*(?:[\w-]+:)?([^<\s]*)/g)].map((m) => [m[1], m[2]]);
    ctx[id] = { start: tag(body, "startDate"), end: tag(body, "endDate") ?? tag(body, "instant"), dims };
  }
  for (const [, id, body] of xml.matchAll(/<(?:[\w-]+:)?unit\b[^>]*?\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?unit>/g)) unit[id] = tag(body, "measure")?.replace(/^[\w-]+:/, "") ?? null;
  for (const [, , name, attrs, text] of xml.matchAll(/<([\w-]+):([\w-]+)(\s[^>]*?)>([^<]*)<\/\1:\2>/g)) {
    const c = ctx[attrs.match(/\bcontextRef="([^"]+)"/)?.[1]], u = attrs.match(/\bunitRef="([^"]+)"/)?.[1], v = Number(text.trim());
    if (c && u && text.trim() && Number.isFinite(v)) facts.push({ name, v, unit: unit[u] ?? null, ...c });
  }
  return facts;
}

// ---- NO: Regnskapsregisteret (latest year only) + Enhetsregisteret headcount + PDF copies.
async function fetchNO(orgnr, o, out) {
  const base = "https://data.brreg.no/regnskapsregisteret/regnskap";
  out.checked.push("Brønnøysund Regnskapsregisteret", "Brønnøysund Enhetsregisteret");
  const [accounts, unit, years] = await Promise.all([
    getJson(`${base}/${orgnr}`, o).catch((e) => (e.status === 404 ? [] : Promise.reject(e))),
    getJson(`https://data.brreg.no/enhetsregisteret/api/enheter/${orgnr}`, o).catch(() => null),
    getJson(`${base}/aarsregnskap/kopi/${orgnr}/aar`, o).catch(() => []),
  ]);
  for (const y of (Array.isArray(years) ? years : []).map(Number).filter(Boolean).sort((a, b) => b - a).slice(0, 3))
    out.documents.push({ type: "annual_report", year: y, format: "pdf", url: `${base}/aarsregnskap/kopi/${orgnr}/${y}`, source: SRC.NO });
  const r = accounts.find((a) => a.regnskapstype === "SELSKAP") || accounts[0];
  if (!r) return void out.notes.push("No filed accounts in Regnskapsregisteret (e.g. sole proprietorship, new or exempt entity)");
  const res = r.resultatregnskapResultat || {}, op = res.driftsresultat || {};
  out.rows.push(row({
    period_start: r.regnskapsperiode?.fraDato, period_end: r.regnskapsperiode?.tilDato, currency: r.valuta || "NOK",
    revenue: op.driftsinntekter?.sumDriftsinntekter, ebit: op.driftsresultat, net_income: res.aarsresultat ?? res.totalresultat,
    total_assets: r.eiendeler?.sumEiendeler, equity: r.egenkapitalGjeld?.egenkapital?.sumEgenkapital, employees: unit?.antallAnsatte,
  }, SRC.NO, `${base}/${orgnr}`));
  out.notes.push("Open API only exposes the latest financial year — earlier years as PDF copies (see documents)");
  out.notes.push("Open API has no depreciation line — EBITDA not derivable (see PDF)");
  if (r.regnskapstype === "KONSERN") out.notes.push("Only group (konsern) accounts available");
  else if (r.virksomhet?.morselskap) out.notes.push("Parent-company (selskap) accounts — group figures only in the PDF annual report");
  if (unit?.antallAnsatte != null) out.notes.push("Employees = current headcount in Enhetsregisteret (not year-specific)");
  if (r.avviklingsregnskap) out.notes.push("Filed as liquidation accounts (avviklingsregnskap)");
}

// ---- FI: PRH digital financial statements (only companies that filed in iXBRL).
// Line items are fi_dim:MCY members of the SBR taxonomy; codes verified against the P&L/balance-sheet arithmetic of filed statements.
const PRH_XBRL = "https://avoindata.prh.fi/opendata-xbrl-api/v3";
const FI_CODES = { revenue: ["x673"], gross_profit: ["x520"], ebit: ["x689"], depreciation: ["x448", "x449"], net_income: ["x740"], total_assets: ["x360", "x481"], equity: ["x376"] };

function parseFI(xml) {
  const byDate = {}; // period end → { memberCode: value }; comparatives carry an extra REF dimension
  let currency = "EUR";
  for (const f of readXbrl(xml)) {
    const mcy = f.dims.find(([d]) => d === "MCY");
    if (!mcy || f.dims.some(([d]) => d !== "MCY" && d !== "REF")) continue;
    (byDate[f.end] ||= {})[mcy[1]] ??= f.v;
    if (/^[A-Z]{3}$/.test(f.unit || "")) currency = f.unit;
  }
  return { byDate, currency, start: xml.match(/<[\w-]+:di120\b[^>]*>\s*([\d-]+)\s*</)?.[1] || null };
}

async function fetchFI(ytunnus, o, out) {
  out.checked.push("PRH digital financial statements API");
  const dates = ((await prh(`${PRH_XBRL}/financials?businessId=${ytunnus}`, o)).financials || []).map((f) => f.financialDate).filter(Boolean).sort().reverse();
  if (!dates.length) return void out.notes.push("No digitally filed (iXBRL) statements — full statements can be purchased from PRH");
  const url = (d) => `${PRH_XBRL}/financial?${new URLSearchParams({ businessId: ytunnus, financialDate: d })}`;
  for (const d of dates.slice(0, 3)) out.documents.push({ type: "annual_report", year: +d.slice(0, 4), format: "xbrl", url: url(d), source: SRC.FI });
  const filings = []; // newest two filings → up to three years incl. the comparative year
  for (const d of dates.slice(0, 2)) {
    try { filings.push({ end: d, url: url(d), ...parseFI(await prh(url(d), o, "text")) }); } catch (e) {
      if (!filings.length) throw e;
      out.notes.push(`FY${d.slice(0, 4)} statement not fetched (${e.message})`);
    }
  }
  const years = new Map();
  const add = (end, start, vals, f) => {
    if (years.has(end) || !vals) return;
    const pick = Object.fromEntries(Object.entries(FI_CODES).map(([k, codes]) => [k, codes.map((c) => vals[c]).find((v) => v != null) ?? null]));
    years.set(end, row({ ...pick, period_start: start, period_end: end, currency: f.currency }, SRC.FI, f.url));
  };
  for (const f of filings) add(f.end, f.start, f.byDate[f.end], f); // a year's own filing wins over later comparatives
  for (const f of filings) for (const [end, vals] of Object.entries(f.byDate)) add(end, null, vals, f);
  out.rows.push(...[...years.values()].filter(hasFigures));
  if (out.rows.some((r) => r.revenue == null && r.gross_profit != null)) out.notes.push("Reports gross result only (small company exemption) — revenue not public");
  out.notes.push("PRH open data covers the iXBRL income statement + balance sheet only (no headcount)");
}

// ---- DK: Virk offentliggørelser (Elasticsearch) → annual-report XBRL (Danish GAAP fsa:, IFRS via the ESEF file).
const DK_FACTS = {
  revenue: ["Revenue"],
  gross_profit: ["GrossProfitLoss", "GrossResult", "GrossProfit"],
  ebit: ["ProfitLossFromOrdinaryOperatingActivities", "ProfitLossFromOperatingActivities", "ProfitLossFromOrdinaryOperatingActivitiesBeforeGainsLossesFromFairValueAdjustments"],
  depreciation: [
    "DepreciationAmortisationExpenseAndImpairmentLossesOfPropertyPlantAndEquipmentAndIntangibleAssetsRecognisedInProfitOrLoss",
    "DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss", "DepreciationAndAmortisationExpense", // IFRS P&L / notes
    "AdjustmentsForDepreciationAndAmortisationExpenseAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss", "AdjustmentsForDepreciationAndAmortisationExpense", // IFRS cash-flow add-backs
  ],
  net_income: ["ProfitLoss"],
  total_assets: ["Assets", "LiabilitiesAndEquity", "EquityAndLiabilities"],
  equity: ["Equity"],
  employees: ["AverageNumberOfEmployees"],
};

// Current period only (contexts ending on the report's balance-sheet date, exact fiscal-year contexts first). Danish group reports tag
// consolidated figures with ConsolidatedSoloDimension=ConsolidatedMember; undimensioned (or SoloMember) facts are the parent company.
function parseDK(xml, { start, end }) {
  const facts = readXbrl(xml).filter((f) => f.end === end).sort((a, b) => (b.start === start) - (a.start === start));
  const basis = (member) => facts.filter((f) => (member === "SoloMember" && !f.dims.length) || (f.dims.length === 1 && f.dims[0][0] === "ConsolidatedSoloDimension" && f.dims[0][1] === member));
  const fields = (list) => {
    const find = (names) => names.map((n) => list.find((f) => f.name === n)).find(Boolean);
    const out = Object.fromEntries(Object.entries(DK_FACTS).map(([k, names]) => [k, find(names)?.v ?? null]));
    out.currency = ["net_income", "ebit", "gross_profit", "revenue", "total_assets"].map((k) => find(DK_FACTS[k])?.unit).find((u) => /^[A-Z]{3}$/.test(u || "")) || "DKK";
    return out;
  };
  return { group: fields(basis("ConsolidatedMember")), solo: fields(basis("SoloMember")) };
}
const hasPL = (f) => !!f && ["revenue", "gross_profit", "ebit", "net_income"].some((k) => f[k] != null);

async function fetchDK(cvr, o, out) {
  out.checked.push("Virk offentliggørelser (annual reports)");
  const q = new URLSearchParams({ q: `cvrNummer:${cvr} AND dokumenter.dokumentType:AARSRAPPORT`, size: "12", sort: "offentliggoerelsesTidspunkt:desc" });
  const hits = ((await getJson(`http://distribution.virk.dk/offentliggoerelser/_search?${q}`, o)).hits?.hits || []).map((h) => h._source || {})
    .sort((a, b) => String(b.offentliggoerelsesTidspunkt).localeCompare(String(a.offentliggoerelsesTidspunkt)));
  const reports = new Map(); // period end → newest publication (re-filings replace originals)
  for (const s of hits) {
    const p = s.regnskab?.regnskabsperiode, docs = (s.dokumenter || []).filter((d) => d.dokumentType?.startsWith("AARSRAPPORT"));
    if (s.offentliggoerelsestype === "regnskab" && p?.slutDato && docs.length && !reports.has(p.slutDato)) reports.set(p.slutDato, { start: p.startDato, end: p.slutDato, docs });
  }
  const latest = [...reports.values()].sort((a, b) => b.end.localeCompare(a.end)).slice(0, 3);
  if (!latest.length) return void out.notes.push(`No annual reports published on Virk for CVR ${cvr}`);
  const groupYears = [];
  await Promise.all(latest.map(async (r) => {
    const year = +r.end.slice(0, 4), doc = (type, mime) => r.docs.find((d) => d.dokumentType === type && d.dokumentMimeType === mime)?.dokumentUrl;
    const pdf = doc("AARSRAPPORT", "application/pdf"), xhtml = doc("AARSRAPPORT", "application/xhtml+xml"), xml = doc("AARSRAPPORT", "application/xml"), esef = doc("AARSRAPPORT_ESEF", "application/xml");
    if (pdf || xhtml) out.documents.push({ type: "annual_report", year, format: pdf ? "pdf" : "xhtml", url: pdf || xhtml, source: SRC.DK });
    if (xml) out.documents.push({ type: "annual_report", year, format: "xbrl", url: xml, source: SRC.DK });
    try {
      const x = xml ? parseDK(await getText(xml, o), r) : null;
      let used = xml, group = hasPL(x?.group), fields = group ? x.group : x?.solo;
      if (!hasPL(fields) && esef) { // listed companies: consolidated IFRS figures live in the ESEF file, headcount in the Danish supplement
        const e = parseDK(await getText(esef, o), r), ifrs = hasPL(e.group) ? e.group : e.solo;
        ifrs.employees ??= x?.group.employees ?? x?.solo.employees ?? null;
        [used, fields, group] = [esef, ifrs, true];
      }
      if (fields && hasFigures(fields)) {
        out.rows.push(row({ ...fields, period_start: r.start, period_end: r.end }, SRC.DK, used));
        if (group) groupYears.push(year);
      } else out.notes.push(`FY${year}: no XBRL figures — see the ${pdf ? "PDF" : "annual report"}`);
    } catch (e) {
      out.notes.push(`FY${year} XBRL not fetched (${e.name === "TimeoutError" ? "timeout" : e.message})`);
    }
  }));
  if (groupYears.length) out.notes.push(groupYears.length === out.rows.length ? "Consolidated (group) figures" : `Consolidated (group) figures for FY${groupYears.sort().join(", FY")}; other years company-only`);
  if (out.rows.some((r) => r.revenue == null && r.gross_profit != null)) out.notes.push("Reports gross profit only (small company exemption) — revenue not public");
  if (out.rows.some((r) => r.ebit == null && r.net_income != null)) out.notes.push("Operating profit (EBIT) not tagged for some years — see the annual report");
  if (out.rows.some((r) => r.ebit != null && r.ebitda == null)) out.notes.push("Depreciation not tagged separately for some years — EBITDA left empty there");
}

const FETCH = { NO: fetchNO, FI: fetchFI, DK: fetchDK };

export async function fetchFinancials(company, opts = {}) {
  const { businessIds = [], timeoutMs = 20000, log = () => {} } = opts;
  company ||= {};
  const country = String(company.country || "").trim().toUpperCase();
  const out = { identifier: null, rows: [], documents: [], notes: [], checked: [] };
  if (!FETCH[country]) {
    out.notes.push(`No open filed-accounts API wired for ${country || "unknown country"}; published figures are picked up by the web research step`);
    return out;
  }
  const o = { signal: AbortSignal.timeout(timeoutMs) };
  fxQuote(HOME_CCY[country]); // warm the FX cache in parallel (never rejects)
  try {
    out.identifier = await resolveId(company, businessIds, country, o, out);
    if (!out.identifier) out.notes.push(`No ${ID_NAME[country]} resolved — name search needs a website-domain or exact-name match (not guessing)`);
    else {
      log(`financials: ${company.name} → ${country} ${out.identifier.id} (${out.identifier.source})`);
      await FETCH[country](out.identifier.id, o, out);
    }
  } catch (e) {
    out.notes.push(e.name === "TimeoutError" || e.name === "AbortError" ? `Registry lookup timed out (${timeoutMs} ms budget)`
      : `Registry lookup failed: ${e.message}${e.status === 429 ? " (rate-limited — retry in a minute)" : ""}`);
  }
  out.rows.sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)));
  out.documents.sort((a, b) => b.year - a.year);
  await addEur(out);
  log(`financials: ${company.name} → ${out.rows.length} filed year(s)`);
  return out;
}
