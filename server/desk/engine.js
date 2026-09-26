// Amir's rule engine, ported faithfully from the pure Python modules in amir/src:
//   matcher.py, engine/signal_engine.py, engine/scoring.py, engine/hypothesis.py, engine/outreach_agent.py,
//   engine/crm.py, outreach.py, and the pure parts of sources/signals.py, sources/registry.py,
//   sources/record.py (to_profile) and sources/__init__.py.
// Same numbers, thresholds, labels, template strings and output shapes. No LLM paths, no I/O, no dependencies.
// Python-isms that change output are reproduced on purpose:
//   - round() is round-half-even on the exact binary value (pyRound); f"{x:.1f}" formats the same way (pyFixed).
//     Ties really happen here: round(25 * 90 / 100) is 22 in Python, not 23; f"{0.5:.0f}" is "0".
//   - \b and \w in the regexes are Unicode-aware like Python's (so "Verkaufsgespräch" is one banned word, not two).
//   - Python None is null in every output object.
// Dates: functions accept `today` as a Date (its local calendar date, like date.today()) or an ISO "YYYY-MM-DD"
// string; when omitted, today is used. Signal dates are ISO strings; unparsable ones count as "no date" like the
// Python (date.fromisoformat raising → None).

// ---------------------------------------------------------------------------------------------------------------------
// Python semantics helpers
// ---------------------------------------------------------------------------------------------------------------------
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const freeze = Object.freeze;
// f-string rendering of a plain value (None → "None", True → "True").
const pyStr = (v) => (v === undefined || v === null ? "None" : v === true ? "True" : v === false ? "False" : String(v));
// dict.get(key) for values that flow into output objects: undefined becomes null (Python None).
const nn = (v) => (v === undefined ? null : v);

/** Python's round(x[, ndigits]): round-half-even on the exact binary value of the double. */
export function pyRound(x, ndigits = 0) {
  if (typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(100); // exact decimal expansion (toFixed is exact per spec)
  const dot = s.indexOf(".");
  const frac = s.slice(dot + 1);
  let scaled = BigInt(s.slice(0, dot) + frac.slice(0, ndigits)); // |x| * 10^ndigits, truncated
  const rest = frac.slice(ndigits);
  const next = rest.charCodeAt(0) - 48;
  let up = next > 5;
  if (next === 5) up = /[1-9]/.test(rest.slice(1)) || scaled % 2n === 1n; // above half → up; exact half → to even
  if (up) scaled += 1n;
  const result = Number(scaled) / 10 ** ndigits;
  return neg ? -result : result;
}

/** Python's f"{x:.{ndigits}f}". */
export function pyFixed(x, ndigits) {
  return pyRound(x, ndigits).toFixed(ndigits);
}

/** Python's float(value); NaN where Python would raise (None, "", "abc", ...). */
function pyFloat(v) {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v !== "string") return NaN;
  const s = v.trim().replace(/(?<=\d)_(?=\d)/g, "");
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (/^[+-]?inf(?:inity)?$/i.test(s)) return s[0] === "-" ? -Infinity : Infinity;
  return NaN;
}

/** Python's str.title() (enough of it: cased letters start words). */
function pyTitle(s) {
  let out = "";
  let prevCased = false;
  for (const ch of String(s)) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    out += prevCased ? lo : up;
    prevCased = lo !== up;
  }
  return out;
}

/** Python's str.split() with no arguments. */
const pySplit = (s) => String(s ?? "").split(/\s+/).filter(Boolean);

// Python's Unicode-aware \w and \b for use inside RegExp sources (always combined with the "u" flag).
const W = "\\p{L}\\p{N}_";
const WORD = `[${W}]`;
const WB = `(?:(?<![${W}])(?=[${W}])|(?<=[${W}])(?![${W}]))`;
const globalOf = (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");

// ---- dates: a "day" is {year, month, day, days} with days = whole days since the epoch (UTC arithmetic, no DST) ----
const MS_PER_DAY = 86_400_000;

function mkDay(year, month, day) {
  const dt = new Date(0);
  dt.setUTCFullYear(year, month - 1, day);
  dt.setUTCHours(0, 0, 0, 0);
  return { year, month, day, days: dt.getTime() / MS_PER_DAY };
}

/** date.fromisoformat((value or "")[:10]) → day, or null where Python raises ValueError. */
function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").slice(0, 10));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = mkDay(year, month, day);
  const check = new Date(d.days * MS_PER_DAY);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return d;
}

const pad = (n, w) => String(n).padStart(w, "0");
const isoDate = (d) => `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;

/** `today or date.today()`: Date → its local calendar date; ISO string → that date; anything else → today. */
function todayFrom(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("today: invalid Date");
    return mkDay(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === "string" && value) {
    const d = parseIsoDate(value);
    if (!d) throw new TypeError(`today: invalid ISO date "${value}"`);
    return d;
  }
  if (value && typeof value === "object" && typeof value.days === "number") return value;
  const now = new Date();
  return mkDay(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

// ---------------------------------------------------------------------------------------------------------------------
// sources/__init__.py
// ---------------------------------------------------------------------------------------------------------------------
export const COUNTRY_NAMES = freeze({
  FI: "Finland",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  DE: "Germany",
  AT: "Austria",
  CH: "Switzerland",
});

export const REGION_BY_COUNTRY = freeze({
  FI: "Nordics",
  SE: "Nordics",
  NO: "Nordics",
  DK: "Nordics",
  DE: "DACH",
  AT: "DACH",
  CH: "DACH",
});

// ---------------------------------------------------------------------------------------------------------------------
// sources/signals.py (pure parts)
// ---------------------------------------------------------------------------------------------------------------------
export const SIGNAL_TYPES = freeze(["succession", "growth", "acquisition", "management_change", "ownership_change", "capital_need"]);
export const SIGNAL_LABELS = freeze({
  succession: "Succession",
  growth: "Growth",
  acquisition: "Acquisition",
  management_change: "Management change",
  ownership_change: "Ownership change",
  capital_need: "Capital need",
});

export const FOUNDED_RE = new RegExp(
  `${WB}(?:founded|established|since|perustettu|grundad|gegründet)\\s+(?:in\\s+|im\\s+jahr\\s+)?((?:18|19|20)\\d{2})${WB}`,
  "iu",
);
export const WEB_RULES = freeze([
  freeze(["acquisition", "Website mentions an acquisition or merger",
    new RegExp(`${WB}(?:has acquired|acquired|acquires|acquisition of|joins forces with|merger with)${WB}`, "iu")]),
  freeze(["management_change", "Website mentions a CEO change",
    new RegExp(`${WB}(?:new ceo|named ceo|appointed[^.]{0,60}${WB}ceo${WB})`, "iu")]),
  freeze(["growth", "Website shows hiring or record growth",
    new RegExp(`${WB}(?:we'?re hiring|we are hiring|open positions|record year|record revenue|record growth)${WB}`, "iu")]),
]);
export const SUCCESSION_AGE_YEARS = 25;

function snippet(text, start, end, padding = 70) {
  const left = Math.max(0, start - padding);
  const right = Math.min(text.length, end + padding);
  return (left ? "…" : "") + pySplit(text.slice(left, right)).join(" ") + (right < text.length ? "…" : "");
}

export function detectFoundedYear(text, today) {
  const thisYear = todayFrom(today).year;
  for (const m of String(text ?? "").matchAll(globalOf(FOUNDED_RE))) {
    const year = Number(m[1]);
    if (1850 <= year && year <= thisYear) return year;
  }
  return null;
}

export function detectWebSignals(text, sourceUrl = "", today) {
  text = String(text ?? "");
  const day = todayFrom(today);
  const todayIso = isoDate(day);
  const signals = [];

  const founded = detectFoundedYear(text, day);
  if (founded && day.year - founded >= SUCCESSION_AGE_YEARS) {
    const match = FOUNDED_RE.exec(text); // the first match, as in the Python (FOUNDED_RE.search)
    signals.push({
      signal_type: "succession",
      date: todayIso,
      headline: `Founded in ${founded} (${day.year - founded} years ago): founder-generation ownership is likely`,
      source: "Company website",
      url: sourceUrl,
      evidence: snippet(text, match.index, match.index + match[0].length),
    });
  }

  for (const [signalType, headline, pattern] of WEB_RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    signals.push({
      signal_type: signalType,
      date: todayIso,
      headline: `${headline} ("${match[0].trim()}")`,
      source: "Company website",
      url: sourceUrl,
      evidence: snippet(text, match.index, match.index + match[0].length),
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------------------------------------------------
// sources/registry.py (registry_signals only)
// ---------------------------------------------------------------------------------------------------------------------
export const RECENT_RENAME_YEARS = 3;

/** Turn registry facts into signals: a recent legal rename usually follows an acquisition or merger. */
export function registrySignals(record, sourceUrl = "", today) {
  if (!record || record.status !== "ok") return [];
  const cutoff = todayFrom(today).year - RECENT_RENAME_YEARS;
  const signals = [];
  for (const previous of record.previous_names || []) {
    const until = String(previous.until || "");
    const head = until.slice(0, 4);
    if (/^\d+$/.test(head) && Number(head) >= cutoff) {
      signals.push({
        signal_type: "ownership_change",
        date: until,
        headline: `Registered name changed from ${pyStr(previous.name)} to ${pyStr(record.legal_name)}`,
        source: "Finnish Trade Register (PRH)",
        url: sourceUrl || `https://tietopalvelu.ytj.fi/yritys/${pyStr(record.business_id)}`,
      });
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------------------------------------------------
// sources/record.py (to_profile only)
// ---------------------------------------------------------------------------------------------------------------------
/** Shape a company record like a scraper profile so the buyer matcher can score it. */
export function toProfile(record) {
  const company = record.company;
  const ebitda = company.ebitda_eur;
  const geo = [
    String(company.country_name ?? "").toLowerCase(),
    String(company.region ?? "").toLowerCase(),
    company.geographic_hint,
  ].filter(Boolean).join(" ");
  const website = record.website || {};
  return {
    company_name: nn(company.legal_name || company.company_name),
    sector: company.sector || "Unverified Sector",
    products: company.products || company.sector || "Pending Analysis",
    customers: company.customers || "Pending Analysis",
    ebitda: ebitda ? `€${pyFixed(Number(ebitda) / 1e6, 1)}M` : "Pending Audit",
    verified: Boolean(website.verified),
    fetched: Boolean(website.fetched),
    evidence: company.evidence || [],
    source_url: company.website || "",
    geographic_hint: geo,
    company_id: nn(company.company_id),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// matcher.py
// ---------------------------------------------------------------------------------------------------------------------
export const SECTOR_ALIASES = freeze({
  saas: freeze(["saas", "cloud", "software", "digital", "subscription", "api", "b2b"]),
  software: freeze(["saas", "cloud", "software", "digital", "wholesale", "technical"]),
  circular: freeze(["circular", "waste", "recycle", "recycling", "logistics"]),
  construction: freeze(["construction", "industrial", "build", "steel"]),
  manufacturing: freeze(["manufacturing", "automation", "industrial", "engineering"]),
  telecom: freeze(["telecom", "5g", "network", "infrastructure"]),
  retail: freeze(["retail", "furniture", "consumer", "store"]),
  defense: freeze(["defense", "aerospace", "radar", "security"]),
  sustainable: freeze(["sustainable", "tech", "software", "green", "energy"]),
});

const tokens = (text) => new Set(String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) || []);

const RE_BILLION_SUFFIX = new RegExp(`\\db${WB}`, "u");
const RE_MILLION_SUFFIX = new RegExp(`\\dm${WB}`, "u");

/** EBITDA text like "€5.2M", "12 million", "1.2B" → euros; null when confidential/pending/unparsable. */
export function parseEbitdaEur(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  const text = raw.toLowerCase().replace(/,/g, "").replace(/ /g, "");
  if (text.includes("confidential") || text.includes("pending") || text.includes("nda")) return null;
  const match = /([\d.]+)/.exec(text);
  if (!match) return null;
  const number = pyFloat(match[1]);
  if (Number.isNaN(number)) throw new RangeError(`could not convert string to float: '${match[1]}'`); // Python ValueError
  if (text.includes("billion") || RE_BILLION_SUFFIX.test(text)) return number * 1_000_000_000;
  if (text.includes("million") || RE_MILLION_SUFFIX.test(text) || raw.includes("€") || text.includes("eur")) {
    if (number < 1000) return number * 1_000_000;
    return number;
  }
  return number;
}

function sectorScore(profileSector, buyerSector, products) {
  const profileTokens = tokens(`${profileSector} ${products}`);
  const buyerTokens = tokens(buyerSector);
  let overlap = 0;
  for (const t of profileTokens) if (buyerTokens.has(t)) overlap += 1;
  let aliasHits = 0;
  for (const aliases of Object.values(SECTOR_ALIASES)) {
    if (aliases.some((a) => profileTokens.has(a)) && aliases.some((a) => buyerTokens.has(a))) aliasHits += 1;
  }
  if (overlap || aliasHits) {
    const points = Math.min(50, 20 + 10 * overlap + 15 * aliasHits);
    return [points, `Sector matches what the buyer wants (${buyerSector})`, null];
  }
  return [8, null, `Sector mismatch: buyer wants ${buyerSector}, company looks like ${profileSector || "an unclear sector"}`];
}

function geoScore(geoHint, buyerGeo) {
  const hint = String(geoHint || "").toLowerCase();
  const focus = String(buyerGeo || "").toLowerCase();
  if (!hint) return [8, null, `Location not stated on the website (buyer focus: ${buyerGeo})`];
  const nordics = ["finland", "sweden", "nordic", "norway", "denmark", "helsinki"].some((k) => hint.includes(k));
  const dach = ["germany", "dach", "austria", "switzerland", "gmbh"].some((k) => hint.includes(k));
  const europe = hint.includes("europe") || nordics || dach;
  if (focus.includes("finland") && hint.includes("finland")) return [20, `Located in the buyer's region (${buyerGeo})`, null];
  if (focus.includes("nordic") && nordics) return [20, `Located in the buyer's region (${buyerGeo})`, null];
  if (focus.includes("dach") && dach) return [20, `Located in the buyer's region (${buyerGeo})`, null];
  if (focus.includes("europe") && europe) return [16, `European presence fits the buyer's focus (${buyerGeo})`, null];
  if (europe && (focus.includes("finland") || focus.includes("nordic") || focus.includes("europe"))) {
    return [12, null, `Only partly in the buyer's region (${buyerGeo})`];
  }
  return [4, null, `Outside the buyer's region (${buyerGeo})`];
}

function ebitdaScore(profileEbitda, minEur, maxEur) {
  const parsed = parseEbitdaEur(profileEbitda);
  const lo = pyFloat(minEur);
  const hi = pyFloat(maxEur);
  if (Number.isNaN(lo) || Number.isNaN(hi)) return [10, null, null];
  const buyerBand = `€${pyFixed(lo / 1e6, 0)}–${pyFixed(hi / 1e6, 0)}M`;
  if (parsed === null) return [10, null, `EBITDA not public; buyer needs ${buyerBand}`];
  if (lo <= parsed && parsed <= hi) return [20, `EBITDA inside the buyer's range (${buyerBand})`, null];
  if (parsed < lo * 0.5 || parsed > hi * 2) return [2, null, `EBITDA ${profileEbitda} is far outside the buyer's range (${buyerBand})`];
  return [8, null, `EBITDA ${profileEbitda} is just outside the buyer's range (${buyerBand})`];
}

function bandLabel(lo, hi) {
  const l = pyFloat(lo);
  const h = pyFloat(hi);
  if (Number.isNaN(l) || Number.isNaN(h)) return "size band";
  return `€${pyFixed(l / 1e6, 0)}–${pyFixed(h / 1e6, 0)}M EBITDA`;
}

const SUMMARY_SECTOR = { yes: "same kind of company", no: "different sector" };
const SUMMARY_REGION = { yes: "in their region", partial: "only partly in their region", unknown: "location not on the site", no: "outside their region" };
const SUMMARY_SIZE = { yes: "right size", partial: "size is close", unknown: "size not public", no: "outside their size range" };
const capFirst = (s) => s[0].toUpperCase() + s.slice(1);

function summary(checks) {
  const sector = hasOwn(SUMMARY_SECTOR, checks.sector.ok) ? SUMMARY_SECTOR[checks.sector.ok] : "sector unclear";
  const region = SUMMARY_REGION[checks.region.ok];
  const size = SUMMARY_SIZE[checks.size.ok];
  return `${capFirst(sector)}, ${region}. ${capFirst(size)}.`;
}

export function scoreBuyer(buyer, profile) {
  const [sectorPts, sectorReason, sectorGap] = sectorScore(profile.sector ?? "", buyer.target_sector ?? "", profile.products ?? "");
  const [geoPts, geoReason, geoGap] = geoScore(profile.geographic_hint ?? "", buyer.geographic_focus ?? "");
  const [ebitdaPts, ebitdaReason, ebitdaGap] = ebitdaScore(profile.ebitda, buyer.min_ebitda_eur, buyer.max_ebitda_eur);
  const verified = Boolean(profile.verified);
  const verifiedPts = verified ? 10 : 4;
  const verifiedReason = verified ? "Sector confirmed on the company's own website" : null;
  const verifiedGap = verified ? null : "Sector unclear from the website";
  const score = Math.min(100, sectorPts + geoPts + ebitdaPts + verifiedPts);
  const reasons = [sectorReason, geoReason, ebitdaReason, verifiedReason].filter(Boolean);
  const gaps = [sectorGap, geoGap, ebitdaGap, verifiedGap].filter(Boolean);
  const regionOk = geoPts >= 16 ? "yes" : geoPts === 12 ? "partial" : geoPts === 8 ? "unknown" : "no";
  const sizeOk = ebitdaPts >= 20 ? "yes" : ebitdaPts === 10 ? "unknown" : ebitdaPts === 8 ? "partial" : "no";
  const checks = {
    sector: { ok: sectorPts >= 20 ? "yes" : "no", label: buyer.target_sector || "sector", detail: sectorReason || sectorGap || "" },
    region: { ok: regionOk, label: buyer.geographic_focus || "region", detail: geoReason || geoGap || "" },
    size: { ok: sizeOk, label: bandLabel(buyer.min_ebitda_eur, buyer.max_ebitda_eur), detail: ebitdaReason || ebitdaGap || "" },
  };
  const verdict = score >= 75 ? "strong" : score >= 55 ? "possible" : "weak";
  const parsedEbitda = parseEbitdaEur(profile.ebitda);
  return {
    buyer_id: nn(buyer.id),
    buyer_name: nn(buyer.buyer_name),
    target_sector: nn(buyer.target_sector),
    geographic_focus: nn(buyer.geographic_focus),
    min_ebitda_eur: nn(buyer.min_ebitda_eur),
    max_ebitda_eur: nn(buyer.max_ebitda_eur),
    score,
    verdict,
    summary: summary(checks),
    checks,
    axes: {
      sector: Math.min(100, pyRound((100 * sectorPts) / 50)),
      region: Math.min(100, pyRound((100 * geoPts) / 20)),
      size: Math.min(100, pyRound((100 * ebitdaPts) / 20)),
    },
    parts: { sector: sectorPts, region: geoPts, size: ebitdaPts, verified: verifiedPts },
    company_ebitda_eur: parsedEbitda,
    reasons,
    gaps,
    in_mandate_band: ebitdaPts >= 8,
  };
}

export function rankBuyers(buyers, profile) {
  const ranked = (buyers || []).map((buyer) => scoreBuyer(buyer, profile));
  ranked.sort((a, b) => b.score - a.score); // stable, like Python's sort(reverse=True)
  return ranked;
}

/** Mean, median, spread and how much the top buyer stands out. */
export function summarizeMatches(ranked) {
  const scores = (ranked || []).filter((row) => row.score !== null && row.score !== undefined).map((row) => Math.trunc(Number(row.score)));
  const n = scores.length;
  if (!n) {
    return {
      n: 0, best: 0, mean: 0, median: 0, stdev: 0,
      min: 0, max: 0, lift: 0, strong: 0, possible: 0, weak: 0,
      read: "No buyer mandates to compare.", scores: [],
    };
  }
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const ordered = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = n % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
  const stdev = Math.sqrt(scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / n);
  const strong = scores.filter((s) => s >= 75).length;
  const possible = scores.filter((s) => 55 <= s && s < 75).length;
  const weak = n - strong - possible;
  const best = Math.max(...scores);
  const lift = best - median;
  let read;
  if (strong === 0 && possible === 0) read = "No buyer in the book is a fit.";
  else if (strong === 1 && lift >= 15) read = "One buyer stands out from the rest.";
  else if (strong >= 2) read = "Several buyers are a strong fit.";
  else if (possible && !strong) read = "Possible fits only — no strong mandate yet.";
  else read = "A few buyers are close; none dominate.";
  return {
    n,
    best,
    mean: pyRound(mean, 1),
    median: pyRound(median, 1),
    stdev: pyRound(stdev, 1),
    min: Math.min(...scores),
    max: best,
    lift: pyRound(lift, 1),
    strong,
    possible,
    weak,
    read,
    scores,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// engine/signal_engine.py
// ---------------------------------------------------------------------------------------------------------------------
export const BASE = freeze({
  succession: 1.0,
  ownership_change: 0.8,
  capital_need: 0.75,
  management_change: 0.6,
  acquisition: 0.6,
  growth: 0.45,
});
export const HALF_LIFE_DAYS = 365;
export const SIDE = freeze({
  succession: "sell",
  ownership_change: "sell",
  capital_need: "sell",
  management_change: "sell",
  acquisition: "buy",
  growth: "either",
  derived_succession: "sell",
  pe_exit: "sell",
  growth_capital: "sell",
});
export const THEME = freeze({
  succession: "succession",
  derived_succession: "succession",
  ownership_change: "ownership",
  pe_exit: "ownership",
  capital_need: "capital",
  growth_capital: "capital",
  growth: "capital",
  management_change: "management",
  acquisition: "acquisition",
});
export const SUCCESSION_MIN_AGE = 25;
export const PE_HOLD_YEARS = 4;

export function decay(ageDays) {
  return 0.5 ** (Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

function explicitTrigger(signal, today) {
  const kind = signal.signal_type;
  if (!hasOwn(BASE, kind)) return null;
  const when = parseIsoDate(signal.date);
  const ageDays = when ? today.days - when.days : null;
  const strength = BASE[kind] * (ageDays !== null ? decay(ageDays) : 0.5);
  return {
    type: kind,
    label: hasOwn(SIGNAL_LABELS, kind) ? SIGNAL_LABELS[kind] : kind,
    strength: pyRound(strength, 3),
    date: signal.date || null,
    age_days: ageDays,
    evidence: signal.headline || "",
    source: signal.source || "",
    side: SIDE[kind],
    derived: false,
  };
}

function derivedTriggers(company, signals, today) {
  const triggers = [];
  const founded = company.founded_year ? Number(company.founded_year) : null;
  const ownership = String(company.ownership_type || "").toLowerCase();

  if ((ownership === "founder" || ownership === "family") && founded && today.year - founded >= SUCCESSION_MIN_AGE) {
    const age = today.year - founded;
    triggers.push({
      type: "derived_succession",
      label: "Founder-generation succession likely",
      strength: pyRound(Math.min(0.65, 0.4 + 0.01 * (age - SUCCESSION_MIN_AGE)), 3),
      date: null,
      age_days: null,
      evidence: `${pyTitle(ownership)}-owned and founded in ${founded} (${age} years ago)`,
      source: "Derived from profile",
      side: SIDE.derived_succession,
      derived: true,
    });
  }

  if (ownership === "pe") {
    const entries = signals
      .filter((s) => s.signal_type === "ownership_change")
      .map((s) => parseIsoDate(s.date))
      .filter(Boolean);
    if (entries.length) {
      const entered = entries.reduce((a, b) => (b.days < a.days ? b : a));
      const years = (today.days - entered.days) / 365.25;
      if (years >= PE_HOLD_YEARS) {
        triggers.push({
          type: "pe_exit",
          label: "PE holding period ending, exit window",
          strength: pyRound(Math.min(1.0, 0.7 + 0.1 * (years - PE_HOLD_YEARS)), 3),
          date: isoDate(entered),
          age_days: null,
          evidence: `PE owner since ${entered.year} (${pyFixed(years, 1)} years; typical hold is 4-6)`,
          source: "Derived from ownership signal",
          side: SIDE.pe_exit,
          derived: true,
        });
      }
    }
  }

  const kinds = new Set(signals.map((s) => s.signal_type));
  if (kinds.has("growth") && kinds.has("capital_need")) {
    triggers.push({
      type: "growth_capital",
      label: "Growth capital or partner needed",
      strength: 0.7,
      date: null,
      age_days: null,
      evidence: "Growing fast and publicly looking for capital",
      source: "Derived from signals",
      side: SIDE.growth_capital,
      derived: true,
    });
  }
  return triggers;
}

export function detectTriggers(record, today) {
  const day = todayFrom(today);
  const signals = (record && record.signals) || [];
  const triggers = signals.map((s) => explicitTrigger(s, day)).filter(Boolean);
  triggers.push(...derivedTriggers((record && record.company) || {}, signals, day));
  triggers.sort((a, b) => b.strength - a.strength); // stable, like Python's sort(reverse=True)
  return triggers;
}

// ---------------------------------------------------------------------------------------------------------------------
// engine/scoring.py
// ---------------------------------------------------------------------------------------------------------------------
export const TIMING_MAX = 40;
export const FIT_BUYER_MAX = 25;
export const FIT_BAND_POINTS = 10;
export const URGENCY_PER_TYPE = 8;
export const URGENCY_TYPES_CAP = 16;
export const URGENCY_RECENT = 5;
export const URGENCY_FOUNDER_CEO = 4;
export const RECENT_DAYS = 183;
// Mergero's hard minimum valuation is €3-5M: below €3M is out, €3-5M is borderline.
export const BAND_EUR = freeze([3_000_000, 100_000_000]);
export const FLOOR_FULL_EUR = 5_000_000;
export const TIER_A = 80;
export const TIER_B = 60;

export const SECTOR_MULTIPLES = freeze({
  "B2B SaaS & Digital Services": 10,
  "Software & Technical wholesale": 8,
  "Sustainable Tech & Software": 9,
  "Manufacturing & Industrial Automation": 7,
  "Industrial construction": 6,
  "Circular economy / Waste logistics": 7,
  "Healthcare & Facility services": 8,
  "Food & Beverage": 7,
});
export const DEFAULT_MULTIPLE = 7;

/** → [ev | null, multiple], like the Python tuple. */
export function estimateEv(company) {
  const sector = (company && company.sector) || "";
  const multiple = hasOwn(SECTOR_MULTIPLES, sector) ? SECTOR_MULTIPLES[sector] : DEFAULT_MULTIPLE;
  const ebitda = company && company.ebitda_eur;
  return [ebitda ? Number(ebitda) * multiple : null, multiple];
}

export function floorStatus(ev) {
  if (ev === null || ev === undefined) return "unknown";
  if (ev < BAND_EUR[0]) return "below";
  if (ev < FLOOR_FULL_EUR) return "borderline";
  return ev <= BAND_EUR[1] ? "above" : "too_large";
}

export function tierFor(score) {
  if (score >= TIER_A) return "A";
  if (score >= TIER_B) return "B";
  return "C";
}

export function scoreProspect(record, triggers, buyers) {
  const company = (record && record.company) || {};
  const explanation = [];

  const top = triggers.length ? triggers[0] : null;
  const timing = top ? pyRound(TIMING_MAX * top.strength) : 0;
  explanation.push(
    top
      ? `Timing ${timing}/${TIMING_MAX}: strongest trigger is "${top.label}"`
      : `Timing 0/${TIMING_MAX}: no transaction trigger detected yet`,
  );

  const ranked = buyers && buyers.length ? rankBuyers(buyers, toProfile(record)) : [];
  const bestBuyers = ranked.map((b) => ({
    buyer_id: nn(b.buyer_id), buyer_name: nn(b.buyer_name), score: b.score,
    target_sector: nn(b.target_sector), geographic_focus: nn(b.geographic_focus),
    verdict: nn(b.verdict), summary: nn(b.summary), checks: nn(b.checks),
    axes: nn(b.axes), parts: nn(b.parts), company_ebitda_eur: nn(b.company_ebitda_eur),
    min_ebitda_eur: nn(b.min_ebitda_eur), max_ebitda_eur: nn(b.max_ebitda_eur),
    reasons: b.reasons || [], gaps: b.gaps || [],
  }));
  const bestScore = ranked.length ? ranked[0].score : 0;
  const buyerPoints = pyRound((FIT_BUYER_MAX * bestScore) / 100);
  const [ev, multiple] = estimateEv(company);
  const floorCheck = floorStatus(ev);
  const inBand = floorCheck === "above" || floorCheck === "borderline";
  const bandPoints = floorCheck === "above" ? FIT_BAND_POINTS : floorCheck === "borderline" ? Math.floor(FIT_BAND_POINTS / 2) : 0;
  const fit = buyerPoints + bandPoints;
  if (ranked.length) {
    explanation.push(`Fit ${fit}/${FIT_BUYER_MAX + FIT_BAND_POINTS}: best buyer ${pyStr(ranked[0].buyer_name)} scores ${bestScore}/100`);
  }
  const value = ev !== null ? `Estimated value €${pyFixed(ev / 1e6, 1)}M (${multiple}x EBITDA)` : "";
  explanation.push({
    unknown: "EBITDA unknown, so the value can't be checked against Mergero's €3-5M minimum",
    below: `${value} is below Mergero's €3-5M minimum valuation`,
    borderline: `${value} is at Mergero's €3-5M minimum, so borderline`,
    above: `${value} clears Mergero's €3-5M minimum`,
    too_large: `${value} is above the €100M range Mergero serves`,
  }[floorCheck]);

  const sellTypes = new Set(triggers.filter((t) => t.side === "sell").map((t) => THEME[t.type]));
  const typePoints = Math.min(URGENCY_TYPES_CAP, URGENCY_PER_TYPE * sellTypes.size);
  const recent = triggers.some((t) => t.age_days !== null && t.age_days !== undefined && t.age_days < RECENT_DAYS);
  const founderCeo = Boolean(
    triggers.some((t) => t.type === "succession" || t.type === "derived_succession")
      && company.owner_name
      && company.owner_name === company.ceo_name,
  );
  const urgency = typePoints + (recent ? URGENCY_RECENT : 0) + (founderCeo ? URGENCY_FOUNDER_CEO : 0);
  const parts = [];
  if (sellTypes.size) parts.push(`sell-side triggers on ${sellTypes.size} theme(s) (${[...sellTypes].sort().join(", ")})`);
  if (recent) parts.push("a trigger in the last 6 months");
  if (founderCeo) parts.push("the owner is still CEO");
  explanation.push(`Urgency ${urgency}/25: ` + (parts.length ? parts.join(", ") : "nothing pressing"));

  const score = Math.min(100, timing + fit + urgency);
  return {
    score,
    tier: tierFor(score),
    timing,
    fit,
    urgency,
    explanation,
    best_buyers: bestBuyers,
    match_stats: summarizeMatches(ranked),
    ev_estimate: ev,
    ev_multiple: multiple,
    in_band: inBand,
    floor_check: floorCheck,
  };
}

/** profiles: Map<companyId, record> or a plain object keyed by company id (integer-looking keys come back as numbers). */
export function rankProspects(profiles, buyers, today) {
  const entries = profiles instanceof Map
    ? [...profiles.entries()]
    : Object.entries(profiles || {}).map(([k, v]) => [/^-?\d+$/.test(k) ? Number(k) : k, v]);
  const rows = entries.map(([companyId, rec]) => {
    const triggers = detectTriggers(rec, today);
    const scored = scoreProspect(rec, triggers, buyers);
    return { company_id: companyId, record: rec, triggers, scored };
  });
  rows.sort((a, b) => b.scored.score - a.scored.score);
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// engine/hypothesis.py (template path only)
// ---------------------------------------------------------------------------------------------------------------------
export const MANDATES = freeze({
  succession: freeze(["Succession sale", "sell"]),
  derived_succession: freeze(["Succession sale", "sell"]),
  pe_exit: freeze(["Secondary buyout (PE exit)", "sell"]),
  ownership_change: freeze(["Secondary buyout (PE exit)", "sell"]),
  capital_need: freeze(["Growth partner / minority stake", "sell"]),
  growth_capital: freeze(["Growth partner / minority stake", "sell"]),
  growth: freeze(["Growth partner / minority stake", "sell"]),
  management_change: freeze(["Ownership transition review", "sell"]),
  acquisition: freeze(["Add-on acquisition programme", "buy"]),
});
export const NO_TRIGGER = freeze(["Relationship build (no trigger yet)", "sell"]);

export const WHY_MERGERO = freeze({
  sell: freeze([
    "Active buyer mandates already fit this profile.",
    "The owner can learn what those buyers value, confidentially and at their own pace.",
    "Softer options than a full sale: growth capital or a minority stake.",
  ]),
  buy: freeze([
    "The company is acquiring.",
    "Mergero can run a buy-side programme for off-market add-ons.",
    "Coverage across the Nordics and DACH, against its criteria.",
  ]),
});

export function toPoints(text, { max = 5, min = 8 } = {}) {
  if (Array.isArray(text)) return text.map((s) => String(s || "").trim()).filter(Boolean).slice(0, max);
  const raw = String(text || "").replace(/^Mergero scoring agent:\s*/i, "").trim();
  if (!raw) return [];
  const parts = raw.split(/\n+|;\s+|(?<=[.!?])\s+(?=[A-ZÅÄÖÉ])/).map((s) => s.trim().replace(/^[-•*]\s+/, "").replace(/\.$/, "")).filter((s) => s.length >= min);
  return (parts.length ? parts : [raw.replace(/\.$/, "")]).slice(0, max);
}

export const QUESTIONS = freeze({
  "Succession sale": freeze(["Is there a family or management successor?", "What timeline does the owner have in mind?",
    "Full sale, or staying on for a transition period?"]),
  "Secondary buyout (PE exit)": freeze(["When does the fund's exit window open?", "Is a trade buyer or another sponsor preferred?",
    "Which KPIs does management want to show buyers?"]),
  "Growth partner / minority stake": freeze(["How much capital, and for what?", "Is a minority stake acceptable, or only growth debt?",
    "Which markets are next?"]),
  "Ownership transition review": freeze(["Why the leadership change now?", "What does the board want the next 3 years to look like?",
    "Is an ownership change being discussed?"]),
  "Add-on acquisition programme": freeze(["Which capabilities or regions should add-ons bring?", "What deal size and valuation range?",
    "Who decides internally, and how fast?"]),
  "Relationship build (no trigger yet)": freeze(["What are the owner's plans for the next 3-5 years?",
    "Would it help to hear what buyers in the sector are looking for?"]),
});

// First-touch wording for owners: no "sell", "exit" or "valuation" (Mergero's messaging rule).
export const OWNER_ANGLE = freeze({
  "Succession sale": "Owners who have built a company over {age} often start thinking about the next chapter well before anything changes, and it helps to know early which options are open.",
  "Secondary buyout (PE exit)": "With the current holding period, it may be a good moment to see what trade buyers and other investors are looking for today.",
  "Growth partner / minority stake": "With the growth you are showing, some owners bring in a partner for the next step while staying fully in charge.",
  "Ownership transition review": "Leadership changes are often a natural moment to think about plans for the next few years.",
  "Add-on acquisition programme": "Congratulations on the recent acquisition. We see a number of off-market add-on candidates that could fit a buy-and-build strategy.",
  "Relationship build (no trigger yet)": "We regularly share with owners what buyers in their sector are looking for, with no process in mind.",
});

function evRange(ev) {
  if (!ev) return "Unknown until financials are confirmed";
  return `€${pyFixed((ev * 0.8) / 1e6, 0)}-${pyFixed((ev * 1.2) / 1e6, 0)}M`;
}

function whyNowLine(trigger) {
  const when = trigger.date ? ` (${trigger.date})` : "";
  return `${trigger.label}${when}: ${trigger.evidence}`;
}

export function buildHypothesis(record, triggers, scored, today) {
  const company = (record && record.company) || {};
  const name = company.legal_name || company.company_name || "The company";
  const dominant = triggers.length ? triggers[0] : null;
  const [mandateType, side] = dominant && hasOwn(MANDATES, dominant.type) ? MANDATES[dominant.type] : NO_TRIGGER;

  const founded = company.founded_year;
  const age = founded ? `${todayFrom(today).year - Number(founded)} years` : "many years";

  const headline = `${mandateType} for ${name}` + (dominant ? `: ${dominant.label.toLowerCase()}` : "");
  return {
    mandate_type: mandateType,
    side,
    headline,
    why_now: triggers.slice(0, 3).map(whyNowLine),
    why_mergero: WHY_MERGERO[side],
    owner_angle: OWNER_ANGLE[mandateType].replace("{age}", age),
    suggested_buyers: (scored && scored.best_buyers) || [],
    questions_for_owner: [...QUESTIONS[mandateType]],
    ev_range: evRange(scored && scored.ev_estimate),
    source: "template",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// engine/outreach_agent.py (template path only)
// ---------------------------------------------------------------------------------------------------------------------
export const SEQUENCE_DAYS = freeze([0, 4, 10, 21]);
export const FITTING_BUYER_SCORE = 55;
export const ANGLE_DE = freeze({
  "Succession sale": "Wer ein Unternehmen über {age} aufgebaut hat, denkt oft schon lange vor jeder Veränderung über das nächste Kapitel nach, und es hilft, die Optionen früh zu kennen.",
  "Secondary buyout (PE exit)": "Nach der bisherigen Haltedauer könnte jetzt ein guter Moment sein zu sehen, wonach strategische Käufer und andere Investoren heute suchen.",
  "Growth partner / minority stake": "Bei Ihrem Wachstum holen manche Eigentümer für den nächsten Schritt einen Partner an Bord, ohne die Kontrolle abzugeben.",
  "Ownership transition review": "Ein Führungswechsel ist oft ein guter Anlass, über die Pläne für die nächsten Jahre nachzudenken.",
  "Add-on acquisition programme": "Herzlichen Glückwunsch zur jüngsten Übernahme. Wir sehen mehrere Off-Market-Kandidaten, die zu einer Buy-and-Build-Strategie passen könnten.",
  default: "Wir teilen regelmäßig mit Eigentümern, wonach Käufer in ihrer Branche suchen, ganz ohne Prozess.",
});
export const NUM_EN = freeze({ 2: "Two", 3: "Three", 4: "Four", 5: "Five" });
export const NUM_DE = freeze({ 2: "Zwei", 3: "Drei", 4: "Vier", 5: "Fünf" });
export const SOFT_DOOR = "Nothing needs to change: some owners start with a growth partner or a minority stake, "
  + "others simply want to understand their options for the next few years.";
export const SMALL_ASK = "Would a 20-minute confidential conversation be useful? No commitment, no documents.";
// Mergero's rule: owners usually haven't considered selling, so a first touch never talks about selling or valuation.
// (Exported without the "g" flag so .test() is stateless; firstTouchIssues iterates with a global copy.)
export const FIRST_TOUCH_BANNED = new RegExp(
  `${WB}(sell${WORD}*|sale|sales process|exit${WORD}*|valuations?|m&a|verkauf${WORD}*|bewertung${WORD}*)${WB}`,
  "iu",
);

export function firstTouchIssues(text) {
  const found = new Set();
  for (const m of String(text ?? "").matchAll(globalOf(FIRST_TOUCH_BANNED))) found.add(m[0].toLowerCase());
  return [...found].sort();
}

const firstName = (fullName) => pySplit(fullName)[0] || "";

export function chooseChannel(company) {
  const ownership = String((company && company.ownership_type) || "").toLowerCase();
  const region = (company && company.region) || "";
  if (ownership === "pe") {
    return { channel: "Email to investment partner", tone: "Direct and deal-focused",
      step_channels: ["Email", "Email", "Email", "Email"], style: "pe" };
  }
  if (region === "DACH") {
    return { channel: "LinkedIn + phone", tone: "Formal (Sie), brief, buyer-demand-led",
      step_channels: ["LinkedIn", "Phone", "Email", "Email"], style: "dach" };
  }
  return { channel: "Email + LinkedIn", tone: "Direct and short, buyer-demand-led, 20-minute ask",
    step_channels: ["Email", "Email", "LinkedIn", "Email"], style: "nordic" };
}

function greeting(style, contact) {
  if (style === "dach") return contact ? `Guten Tag ${contact},` : "Guten Tag,";
  const first = firstName(contact);
  return first ? `Hi ${first},` : "Hi,";
}

function dachBodies(company, hypothesis, greet, buyers, today) {
  const name = company.legal_name || company.company_name || "Ihr Unternehmen";
  const founded = company.founded_year;
  const age = founded ? `${today.year - Number(founded)} Jahre` : "viele Jahre";
  const mandateType = hypothesis.mandate_type;
  const angle = (hasOwn(ANGLE_DE, mandateType) ? ANGLE_DE[mandateType] : ANGLE_DE.default).replace("{age}", age);
  let buyerLine;
  if (buyers === 1) buyerLine = `Ein Käufer aus unserem Netzwerk sucht derzeit gezielt nach Unternehmen wie ${name}.`;
  else if (buyers) buyerLine = `${hasOwn(NUM_DE, buyers) ? NUM_DE[buyers] : buyers} Käufer aus unserem Netzwerk suchen derzeit gezielt nach Unternehmen wie ${name}.`;
  else buyerLine = `Käufer aus unserem Netzwerk suchen derzeit aktiv nach Unternehmen in Ihrer Branche, und ${name} ist uns aufgefallen.`;
  return [
    ["LinkedIn-Nachricht", `${greet}\n\n${buyerLine} ${angle}\n\n`
      + "Hätten Sie Zeit für ein vertrauliches Gespräch von 20 Minuten? Ganz unverbindlich."],
    ["Telefonleitfaden (60 Sekunden)", "Kurz vorstellen (Mergero) und auf die LinkedIn-Nachricht Bezug nehmen.\n"
      + `Aufhänger: ${buyerLine}\n`
      + `Eine Frage: Wie sehen Ihre Pläne für ${name} in den nächsten Jahren aus?\n`
      + "Ziel: ein vertrauliches Gespräch von 20 Minuten vereinbaren."],
    [`${name}: Käuferinteresse`, `${greet}\n\nich hatte Ihnen kürzlich auf LinkedIn geschrieben. Ich habe eine kurze, anonymisierte `
      + "Übersicht zusammengestellt, wonach Käufer bei Unternehmen wie Ihrem derzeit suchen. "
      + "Soll ich sie Ihnen unverbindlich zusenden?"],
    ["Abschluss", `${greet}\n\nich möchte Ihr Postfach nicht überfüllen, daher ist dies vorerst meine letzte Nachricht. `
      + "Wenn der Zeitpunkt später besser passt, antworten Sie einfach."],
  ];
}

function bodies(company, hypothesis, style, contact, today) {
  const name = company.legal_name || company.company_name || "your company";
  const sector = company.sector || "your sector";
  const angle = hypothesis.owner_angle;
  const greet = greeting(style, contact);
  const buyers = (hypothesis.suggested_buyers || []).filter((b) => (b.score || 0) >= FITTING_BUYER_SCORE).length;
  if (style === "dach") return dachBodies(company, hypothesis, greet, buyers, today);

  if (style === "pe") {
    let buyerLine;
    if (buyers === 1) buyerLine = "We currently hold an active buyer mandate that fits companies like this.";
    else if (buyers) buyerLine = `We currently hold ${buyers} active buyer mandates that fit companies like this.`;
    else buyerLine = "";
    const opener = `${greet}\n\nI'm reaching out about ${name}. ${angle}\n\n`
      + `${buyerLine} We run off-market processes across the Nordics and DACH.\n\n`
      + "Would a short call on exit routes and what buyers are paying today be useful?";
    return [
      [`${name}: buyer interest`, opener],
      ["Following up", `${greet}\n\nFollowing up on my note about ${name}. Happy to share which buyer types are most active right now.`],
      ["Recent transactions", `${greet}\n\nI put together a short, anonymised view of recent ${sector} transactions. Happy to share it.`],
      ["Closing the loop", `${greet}\n\nThis is my last note for now. If the timing is better later, just reply.`],
    ];
  }

  let buyerLine;
  if (buyers === 1) buyerLine = `A buyer in our network is currently looking for companies like ${name}.`;
  else if (buyers) buyerLine = `${hasOwn(NUM_EN, buyers) ? NUM_EN[buyers] : buyers} buyers in our network are currently looking for companies like ${name}.`;
  else buyerLine = `Buyers in our network are actively looking at ${sector} companies in the Nordics, and ${name} stood out.`;
  const softDoor = hypothesis.mandate_type === "Growth partner / minority stake" ? "" : `${SOFT_DOOR}\n\n`;
  const opener = `${greet}\n\n${buyerLine} ${angle}\n\n${softDoor}${SMALL_ASK}`;
  return [
    [`Buyer interest in companies like ${name}`, opener],
    ["A quick follow-up", `${greet}\n\nA quick follow-up on my note about ${name}. The buyers we work with tend to move early, `
      + "often a year or two before an owner decides anything, so an early conversation keeps every option open.\n\n"
      + "Happy to work around your calendar."],
    ["LinkedIn note", `${greet} I put together a short, anonymised view of what buyers are looking for in ${sector} right now. `
      + "Happy to share it, no strings attached."],
    ["Closing the loop", `${greet}\n\nI don't want to crowd your inbox, so this is my last note for now. `
      + "If the timing is better later, just reply and we'll pick it up."],
  ];
}

export function planOutreach(record, hypothesis, today) {
  const company = (record && record.company) || {};
  const choice = chooseChannel(company);
  let contact = company.owner_name || company.ceo_name || "";
  if (choice.style === "pe") contact = company.ceo_name || "";

  const drafts = bodies(company, hypothesis, choice.style, contact, todayFrom(today));
  const steps = Math.min(drafts.length, SEQUENCE_DAYS.length, choice.step_channels.length);
  const sequence = [];
  for (let i = 0; i < steps; i += 1) {
    const [subject, body] = drafts[i];
    sequence.push({ step: i, day: SEQUENCE_DAYS[i], channel: choice.step_channels[i], subject, body,
      status: "drafted", sent_at: null, source: "template" });
  }
  return { channel: choice.channel, tone: choice.tone, contact_name: contact,
    sequence, stopped: false, stop_reason: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// engine/crm.py (pure parts)
// ---------------------------------------------------------------------------------------------------------------------
export const CRM_STAGES = freeze(["Prospect", "Contacted", "Replied", "Qualified", "Advisor handoff", "Mandate"]);
// Mergero's own mandate path: first touch, reply, warm-up, first advisor call, engagement letter after 2-4 meetings.
export const STAGE_LABELS = freeze({
  Prospect: "Not contacted",
  Contacted: "First touch sent",
  Replied: "Owner replied",
  Qualified: "Warm-up",
  "Advisor handoff": "First call booked",
  Mandate: "Engagement letter signed",
});
export const CATEGORIES = freeze(["interested_now", "interested_later", "needs_advisor", "not_interested", "unsubscribe"]);
export const CATEGORY_LABELS = freeze({
  interested_now: "Interested now",
  interested_later: "Interested later",
  needs_advisor: "Needs an advisor",
  not_interested: "Not interested",
  unsubscribe: "Unsubscribe",
});
export const TIMINGS = freeze(["now", "3-6 months", "6-12 months", "12+ months", "unknown"]);
export const TIMING_RULES = freeze([
  freeze(["now", freeze(["this week", "next week", "this month", "asap", "tällä viikolla", "ensi viikolla", "diese woche",
    "nächste woche", "denna vecka", "nästa vecka"])]),
  freeze(["3-6 months", freeze(["next quarter", "in a few months", "after the summer", "syksyllä", "muutaman kuukauden",
    "nach dem sommer", "in ein paar monaten", "efter sommaren"])]),
  freeze(["6-12 months", freeze(["next year", "ensi vuonna", "nächstes jahr", "nästa år"])]),
  freeze(["12+ months", freeze(["in two years", "a few years", "parin vuoden", "in ein paar jahren", "om några år"])]),
]);
export const DEFAULT_TIMING = freeze({ interested_now: "now", interested_later: "6-12 months" });
export const FOLLOW_UP_DAYS = freeze({ now: 14, "3-6 months": 90, "6-12 months": 180, "12+ months": 365 });
export const LIKELIHOOD_BASE = freeze({ interested_now: 70, needs_advisor: 55, interested_later: 35, not_interested: 5, unsubscribe: 0 });
export const POTENTIAL_MANDATE_AT = 50;

// Checked in this order, so "not interested" wins over "interested".
export const RULES = freeze([
  freeze(["unsubscribe", freeze(["unsubscribe", "remove me", "stop emailing", "do not contact", "abmelden", "keine weiteren e-mails",
    "älä lähetä", "avregistrera", "sluta mejla"])]),
  freeze(["not_interested", freeze(["not interested", "no thanks", "no thank you", "not for sale", "ei kiitos", "ei kiinnosta",
    "emme ole myymässä", "kein interesse", "nicht interessiert", "nicht zu verkaufen",
    "inte intresserad", "nej tack"])]),
  freeze(["interested_later", freeze(["next quarter", "next year", "not right now", "not now", "in a few months", "after the summer",
    "later this year", "ensi vuonna", "myöhemmin", "nächstes jahr", "später", "nästa år", "senare"])]),
  freeze(["needs_advisor", freeze(["call me", "give me a call", "ring me", "speak to an advisor", "talk to someone", "by phone",
    "soita", "rufen sie mich an", "ring mig", "our cfo", "our lawyer"])]),
  freeze(["interested_now", freeze(["happy to talk", "happy to meet", "let's meet", "lets meet", "sounds good", "coffee", "interested",
    "tell me more", "kiinnostaa", "sopii", "gerne", "interessiert", "intresserad", "gärna"])]),
]);
export const NEXT_ACTION = freeze({
  interested_now: "Book the first call with an advisor this week",
  interested_later: "Pause the sequence and follow up on the scheduled date",
  needs_advisor: "An advisor calls the owner within 24 hours",
  not_interested: "Close politely; revisit only if a new trigger appears",
  unsubscribe: "Remove from all outreach",
});

export const SAMPLE_REPLIES = freeze({
  interested_now: "Thanks for reaching out, happy to talk. Coffee next Tuesday works for me.",
  interested_later: "Interesting, but not right now. Let's pick this up next year.",
  needs_advisor: "I'd rather discuss this by phone, please call me on Thursday.",
  not_interested: "Ei kiitos, emme ole myymässä yritystä.",
  unsubscribe: "Bitte abmelden, keine weiteren E-Mails.",
});

/** The default conversation state (what get_conversation() creates in the Python). */
export function newConversation() {
  return { stage: "Prospect", thread: [], follow_up_on: null, closed: false, outcome: null,
    last_category: null, last_qualification: null, handoff: null };
}

export function advanceStage(conversation, stage) {
  const to = CRM_STAGES.indexOf(stage);
  const current = conversation.stage ?? "Prospect";
  const from = CRM_STAGES.indexOf(current);
  if (to < 0 || from < 0) throw new RangeError(`Unknown CRM stage: ${to < 0 ? stage : current}`); // Python ValueError
  if (to > from) conversation.stage = stage;
  return conversation;
}

export function extractTiming(text) {
  const lowered = String(text ?? "").toLowerCase();
  for (const [timing, phrases] of TIMING_RULES) {
    if (phrases.some((p) => lowered.includes(p))) return timing;
  }
  return "unknown";
}

export function mandateLikelihood(category, timing, prospectScore) {
  if (!hasOwn(LIKELIHOOD_BASE, category)) throw new RangeError(`Unknown category: ${category}`); // Python KeyError
  let value = LIKELIHOOD_BASE[category];
  if (prospectScore !== null && prospectScore !== undefined) value += (prospectScore - 50) / 5;
  if (timing === "now") value += 10;
  else if (timing === "12+ months") value -= 10;
  if (category === "unsubscribe") value = 0;
  return pyRound(Math.max(0, Math.min(100, value)));
}

/** The RULES fallback of _classify(): first matching phrase wins, else "needs_advisor" at low confidence. */
export function classifyRules(text) {
  const lowered = String(text ?? "").toLowerCase();
  for (const [category, phrases] of RULES) {
    const hit = phrases.find((p) => lowered.includes(p));
    if (hit !== undefined) {
      return { category, confidence: 0.8, timing: null, reason: `Reply contains "${hit}"`, source: "rules" };
    }
  }
  return { category: "needs_advisor", confidence: 0.3, timing: null,
    reason: "No clear pattern, so a person should read it", source: "rules" };
}

/**
 * Answer the three qualification questions: interested? timing? potential mandate?
 * options.classification ({category, timing, reason, source, confidence}) is a pre-computed classification (the
 * caller's Claude result) and takes the place of the Python LLM path; it must name a known category, otherwise the
 * RULES fallback is used, exactly as when llm.classify() returns None.
 */
export function qualifyReply(text, options = {}) {
  const { prospectScore = null, mandateType = null, classification = null } = options || {};
  let result = null;
  if (classification && CATEGORIES.includes(classification.category)) {
    result = {
      category: classification.category,
      confidence: classification.confidence ?? 0.9,
      timing: TIMINGS.includes(classification.timing) ? classification.timing : null,
      reason: classification.reason || "Classified by the language model",
      source: classification.source || "llm",
    };
  }
  if (!result) result = classifyRules(text);
  const category = result.category;
  let timing = TIMINGS.includes(result.timing) ? result.timing : extractTiming(text);
  if (timing === "unknown") timing = hasOwn(DEFAULT_TIMING, category) ? DEFAULT_TIMING[category] : "unknown";
  const likelihood = mandateLikelihood(category, timing, prospectScore);
  return {
    ...result,
    label: CATEGORY_LABELS[category],
    timing,
    mandate_likelihood: likelihood,
    potential_mandate: likelihood >= POTENTIAL_MANDATE_AT,
    mandate_type: mandateType,
    next_action: NEXT_ACTION[category],
  };
}

// Drawer step each action belongs to: 5 Outreach, 6 Qualification, 7 Handoff and mandate.
const action = (key, label, step) => ({ key, label, step });

/** The next drafted message, if its day in the sequence has arrived. */
function dueStep(campaign, today) {
  const sequence = campaign.sequence || [];
  const drafted = sequence.find((s) => s.status === "drafted");
  if (!drafted) return null;
  const firstSent = sequence.find((s) => s.status === "sent" && s.sent_at);
  if (drafted.day === 0 || !firstSent) return drafted;
  const start = parseIsoDate(firstSent.sent_at); // datetime.fromisoformat(first_sent).date()
  if (!start) throw new RangeError(`Invalid isoformat string: '${firstSent.sent_at}'`);
  return today.days - start.days >= drafted.day ? drafted : null;
}

/** The single thing to do next for a prospect. */
export function nextAction(conversation, campaign, today) {
  const day = todayFrom(today);
  const stage = conversation.stage ?? "Prospect";
  if (stage === "Mandate") return action("done", "Mandate won", 7);
  if (conversation.closed) return action("closed", "Closed", 6);
  if (stage === "Advisor handoff") return action("mandate", "Engagement letter signed", 7);
  if (stage === "Qualified") return action("handoff", "Book first call with advisor", 7);
  if (conversation.follow_up_on) {
    const due = parseIsoDate(conversation.follow_up_on);
    if (!due) throw new RangeError(`Invalid isoformat string: '${conversation.follow_up_on}'`);
    if (due.days <= day.days) return action("follow_up", "Follow up with the owner", 5);
    return action("wait", `Follow up on ${conversation.follow_up_on}`, 6);
  }
  if (!campaign) return action("plan", "Plan outreach", 5);
  const due = campaign.stopped ? null : dueStep(campaign, day);
  if (due) {
    const label = due.day === 0 ? "Send first message" : `Send day-${due.day} follow-up`;
    return { ...action("send", label, 5), message_step: due.step };
  }
  return action("log_reply", "Log owner reply", 6);
}

/** stages: one CRM stage string per company (a conversation object with .stage is accepted too). */
export function funnel(stages) {
  const list = [...(stages || [])].map((s) => (s && typeof s === "object" ? s.stage : s) ?? "Prospect");
  const reached = (stage) => {
    const idx = CRM_STAGES.indexOf(stage);
    return list.filter((s) => CRM_STAGES.indexOf(s) >= idx).length;
  };
  return {
    prospects: list.length,
    contacted: reached("Contacted"),
    replied: reached("Replied"),
    qualified: reached("Qualified"),
    handed_off: reached("Advisor handoff"),
    mandates: reached("Mandate"),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// outreach.py
// ---------------------------------------------------------------------------------------------------------------------
export const STAGES = freeze([
  "Screened",
  "Owner identified",
  "Warm-up drafted",
  "Outreach ready",
  "Mandate conversation",
]);

const ceoFirstName = (ceo) => pySplit(ceo || "there")[0] || "there";

function mix(profile, fallback = "") {
  const products = profile.products !== "Pending Analysis" ? profile.products : "";
  const customers = profile.customers !== "Pending Analysis" ? profile.customers : "";
  if (products && customers) return `${products}; customers: ${customers}`;
  return products || customers || fallback || "undisclosed mix";
}

function regionFromProfile(profile, explicit = null) {
  if (explicit) return explicit;
  const hint = String(profile.geographic_hint || "").toLowerCase();
  if (["germany", "dach", "austria", "switzerland", "gmbh"].some((k) => hint.includes(k))) return "DACH";
  return "Nordics";
}

export function ownerWarmup(profile, match = null, ceo = "there", region = null) {
  const company = profile.company_name || "your company";
  let mixed = mix(profile, "-");
  mixed = mixed === "-" ? "" : mixed;
  region = regionFromProfile(profile, region);
  const name = ceoFirstName(ceo);
  if (region === "DACH") {
    const greet = ceo && ceo !== "there" ? `Guten Tag ${ceo},` : "Guten Tag,";
    return (
      `${greet}\n\n`
      + `Käufer aus unserem Netzwerk suchen derzeit gezielt nach spezialisierten Unternehmen wie ${company}. `
      + "Es muss sich nichts ändern: Manche Eigentümer beginnen mit einem Wachstumspartner oder einer Minderheitsbeteiligung, "
      + "andere möchten einfach ihre Optionen für die nächsten Jahre kennen.\n\n"
      + "Hätten Sie Zeit für ein vertrauliches Gespräch von 20 Minuten? Ganz unverbindlich."
    );
  }
  const given = mixed ? `, with your mix (${mixed}),` : "";
  return (
    `Hi ${name},\n\n`
    + `Buyers in our network are currently looking for ${profile.sector || "specialist"} companies like ${company}${given} `
    + "in the Nordics.\n\n"
    + "Nothing needs to change: some owners start with a growth partner or a minority stake, others simply want to "
    + "understand their options for the next few years.\n\n"
    + "Would a 20-minute confidential conversation be useful? No commitment, no documents."
  );
}

export function icNote(buyerName, profile, match = null) {
  const company = profile.company_name || "Target";
  const mixed = mix(profile);
  const score = match ? nn(match.score) : null;
  const reasons = match ? match.reasons : [];
  const gaps = match ? match.gaps : [];
  const reasonLines = (reasons && reasons.length ? reasons : ["Public-site screen completed"]).map((r) => `- ${pyStr(r)}`).join("\n");
  const gapLines = (gaps && gaps.length ? gaps : ["None flagged"]).map((g) => `- ${pyStr(g)}`).join("\n");
  const scoreBit = score !== null ? ` Match score ${score}/100.` : "";
  return (
    `Investment committee note — ${pyStr(buyerName)} / ${company}\n\n`
    + `Live web screen of ${profile.source_url || "the corporate site"}.${scoreBit}\n`
    + `Sector: ${pyStr(profile.sector)}. EBITDA signal: ${pyStr(profile.ebitda)}. Mix: ${mixed}.\n\n`
    + `Why this fit:\n${reasonLines}\n\n`
    + `Gaps to confirm with the owner:\n${gapLines}\n\n`
    + "Ask: approve a confidential owner warm-up. Off-market only; Mergero on the buy-side."
  );
}

export function sellSideWarmup(target) {
  const profile = {
    company_name: nn(target.company),
    sector: "software",
    products: nn(target.revenue_split),
    customers: nn(target.top_clients),
    geographic_hint: nn(target.region),
  };
  return ownerWarmup(profile, null, target.ceo || "there", nn(target.region));
}
