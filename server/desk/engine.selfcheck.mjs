// Self-check for engine.js: facts derived from reading Amir's Python (amir/src). Run from the repo root:
//   node server/desk/engine.selfcheck.mjs
// Prints PASS, or lists every failing fact and exits 1. No dependencies, no network.
import assert from "node:assert/strict";
import * as E from "./engine.js";

const failures = [];
let passed = 0;
function fact(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}\n    ${String(err.message).split("\n").join("\n    ")}`); }
}
const eq = assert.deepStrictEqual;

const TODAY = "2026-09-27";
const CAPMAN = { id: 4, buyer_name: "CapMan", target_sector: "B2B SaaS & Digital Services", min_ebitda_eur: 3000000, max_ebitda_eur: 12000000, geographic_focus: "Nordics" };
const FI_BUYER = { id: 7, buyer_name: "Sponsor Nordic", target_sector: "B2B SaaS & Digital Services", geographic_focus: "Finland", min_ebitda_eur: 500000, max_ebitda_eur: 3000000 };
const SAAS_PROFILE = { company_name: "Testi Oy", sector: "B2B SaaS", products: "cloud software", customers: "SMBs", ebitda: "€1.2M", verified: false, fetched: true, evidence: [], source_url: "https://testi.fi", geographic_hint: "Helsinki, Finland", company_id: 1 };
const record = (company = {}, signals = []) => ({
  company: { company_id: 1, company_name: "Nordic Cloud Oy", country: "FI", country_name: "Finland", region: "Nordics", sector: "B2B SaaS & Digital Services", founded_year: 1990, revenue_eur: 14500000, ebitda_eur: 3600000, employees: 85, ownership_type: "founder", owner_name: "Mikael Lindström", ceo_name: "Mikael Lindström", website: "", business_id: "", ...company },
  signals, provenance: {}, sources_used: ["seed"], registry: null, website: null, enriched_at: null, new_signals: [],
});
const PE_RECORD = record({ company_id: 7, company_name: "Fjordline Data AS", country: "NO", country_name: "Norway", founded_year: 2014, ebitda_eur: 2400000, ownership_type: "pe", owner_name: "", ceo_name: "Ingrid Solberg" },
  [{ signal_type: "ownership_change", date: "2021-09-27", headline: "PE owner entered", source: "Ownership data" }]);
const DACH_RECORD = record({ company_id: 11, company_name: "Rhein Software Handel GmbH", country: "DE", country_name: "Germany", region: "DACH", sector: "Software & Technical wholesale", founded_year: 2001, ebitda_eur: 6100000, owner_name: "Thomas Krüger", ceo_name: "Thomas Krüger" });

// ---- constants -----------------------------------------------------------------------------------------------------
fact("constants match the Python modules", () => {
  eq([...E.SIGNAL_TYPES], ["succession", "growth", "acquisition", "management_change", "ownership_change", "capital_need"]);
  eq(E.SIGNAL_LABELS.management_change, "Management change");
  eq(E.BASE.capital_need, 0.75); eq(E.HALF_LIFE_DAYS, 365); eq(E.SIDE.acquisition, "buy"); eq(E.THEME.pe_exit, "ownership");
  eq([...E.CRM_STAGES], ["Prospect", "Contacted", "Replied", "Qualified", "Advisor handoff", "Mandate"]);
  eq(E.STAGE_LABELS.Qualified, "Warm-up"); eq(E.STAGE_LABELS["Advisor handoff"], "First call booked");
  eq([...E.CATEGORIES], ["interested_now", "interested_later", "needs_advisor", "not_interested", "unsubscribe"]);
  eq(E.CATEGORY_LABELS.needs_advisor, "Needs an advisor"); eq([...E.TIMINGS], ["now", "3-6 months", "6-12 months", "12+ months", "unknown"]);
  eq(E.SAMPLE_REPLIES.unsubscribe, "Bitte abmelden, keine weiteren E-Mails."); eq(E.NEXT_ACTION.needs_advisor, "An advisor calls the owner within 24 hours");
  eq([...E.SEQUENCE_DAYS], [0, 4, 10, 21]); eq([...E.STAGES], ["Screened", "Owner identified", "Warm-up drafted", "Outreach ready", "Mandate conversation"]);
  eq(E.COUNTRY_NAMES.FI, "Finland"); eq(E.REGION_BY_COUNTRY.CH, "DACH"); eq(Object.keys(E.COUNTRY_NAMES).length, 7);
  eq(E.SECTOR_MULTIPLES["Industrial construction"], 6); eq(E.DEFAULT_MULTIPLE, 7); eq(E.TIER_A, 80); eq(E.TIER_B, 60);
  eq(E.POTENTIAL_MANDATE_AT, 50); eq(E.FOLLOW_UP_DAYS["6-12 months"], 180); eq(E.LIKELIHOOD_BASE.needs_advisor, 55);
  eq(E.MANDATES.acquisition, ["Add-on acquisition programme", "buy"]); eq(E.NO_TRIGGER, ["Relationship build (no trigger yet)", "sell"]);
  eq(E.QUESTIONS["Growth partner / minority stake"].length, 3); eq(E.WHY_MERGERO.buy[0].startsWith("The company is acquiring."), true);
  eq(E.OWNER_ANGLE["Relationship build (no trigger yet)"], "We regularly share with owners what buyers in their sector are looking for, with no process in mind.");
  eq(E.ANGLE_DE.default, "Wir teilen regelmäßig mit Eigentümern, wonach Käufer in ihrer Branche suchen, ganz ohne Prozess.");
  eq(E.FIRST_TOUCH_BANNED instanceof RegExp, true); eq(E.FIRST_TOUCH_BANNED.global, false); eq(E.FIRST_TOUCH_BANNED.test("a Valuation"), true);
});

// ---- Python rounding semantics -------------------------------------------------------------------------------------
fact("pyRound / pyFixed follow Python's round-half-even on the exact binary value", () => {
  eq(E.pyRound(22.5), 22); eq(E.pyRound(23.5), 24); eq(E.pyRound(20.4), 20);
  eq(E.pyRound(72.25, 1), 72.2); eq(E.pyRound(72.75, 1), 72.8); eq(E.pyRound(2.675, 2), 2.67); eq(E.pyRound(0.51000000000000001, 3), 0.51);
  eq(E.pyFixed(0.5, 0), "0"); eq(E.pyFixed(2.5, 0), "2"); eq(E.pyFixed(1.5, 0), "2"); eq(E.pyFixed(5.25, 1), "5.2"); eq(E.pyFixed(36, 1), "36.0");
});

// ---- signals ---------------------------------------------------------------------------------------------------------
fact("decay: half-life of 365 days, never above 1", () => {
  eq(E.decay(365), 0.5); eq(E.decay(0), 1); eq(E.decay(-5), 1); eq(E.decay(730), 0.25);
});

fact("detectTriggers: founder company founded 1990 → derived succession 0.51 (today 2026-09-27)", () => {
  const triggers = E.detectTriggers(record(), TODAY);
  eq(triggers, [{ type: "derived_succession", label: "Founder-generation succession likely", strength: 0.51, date: null, age_days: null,
    evidence: "Founder-owned and founded in 1990 (36 years ago)", source: "Derived from profile", side: "sell", derived: true }]);
  eq(E.detectTriggers(record({ founded_year: 2002 }), TODAY), []); // 24 years: below SUCCESSION_MIN_AGE
  eq(E.detectTriggers(record({ founded_year: 1950, ownership_type: "family" }), TODAY)[0].strength, 0.65); // capped
  eq(E.detectTriggers(record({ ownership_type: "listed" }), TODAY), []);
});

fact("detectTriggers: explicit signals decay from BASE, growth + capital_need derive growth_capital, sorted by strength", () => {
  const triggers = E.detectTriggers(record({}, [
    { signal_type: "growth", date: "2026-09-27", headline: "ARR up", source: "News" },
    { signal_type: "capital_need", date: "2025-09-27", headline: "Looking for capital", source: "News" },
    { signal_type: "not_a_signal", date: "2026-01-01", headline: "ignored", source: "News" },
  ]), TODAY);
  eq(triggers.map((t) => t.type), ["growth_capital", "derived_succession", "growth", "capital_need"]);
  eq(triggers.map((t) => t.strength), [0.7, 0.51, 0.45, 0.375]);
  eq(triggers[2], { type: "growth", label: "Growth", strength: 0.45, date: "2026-09-27", age_days: 0, evidence: "ARR up", source: "News", side: "either", derived: false });
  eq(triggers[3].age_days, 365);
  eq(triggers[0].evidence, "Growing fast and publicly looking for capital");
  // An unparsable date counts as unknown age: half the base strength.
  eq(E.detectTriggers(record({ ownership_type: "" }, [{ signal_type: "succession", date: "soon", headline: "h", source: "s" }]), TODAY)[0], {
    type: "succession", label: "Succession", strength: 0.5, date: "soon", age_days: null, evidence: "h", source: "s", side: "sell", derived: false });
});

fact("detectTriggers: PE owner for 5 years → pe_exit 0.8 with the entry date", () => {
  const triggers = E.detectTriggers(PE_RECORD, TODAY);
  eq(triggers.map((t) => t.type), ["pe_exit", "ownership_change"]);
  eq(triggers[0], { type: "pe_exit", label: "PE holding period ending, exit window", strength: 0.8, date: "2021-09-27", age_days: null,
    evidence: "PE owner since 2021 (5.0 years; typical hold is 4-6)", source: "Derived from ownership signal", side: "sell", derived: true });
  eq(triggers[1].age_days, 1826); eq(triggers[1].strength, 0.025);
  eq(E.detectTriggers({ ...PE_RECORD, signals: [{ ...PE_RECORD.signals[0], date: "2023-05-15" }] }, TODAY).some((t) => t.type === "pe_exit"), false);
});

fact("detectWebSignals / detectFoundedYear read the site text like the Python rules", () => {
  const text = "Acme Oy was founded in 1985 in Helsinki. We're hiring! Our new CEO joined.";
  const signals = E.detectWebSignals(text, "https://acme.fi", TODAY);
  eq(signals.map((s) => [s.signal_type, s.headline]), [
    ["succession", "Founded in 1985 (41 years ago): founder-generation ownership is likely"],
    ["management_change", 'Website mentions a CEO change ("new CEO")'],
    ["growth", 'Website shows hiring or record growth ("We\'re hiring")'],
  ]);
  eq(signals[0], { signal_type: "succession", date: TODAY, headline: signals[0].headline, source: "Company website", url: "https://acme.fi", evidence: text });
  eq(E.detectFoundedYear("Established 1799 as a mill, gegründet im Jahr 1990 als GmbH.", TODAY), 1990);
  eq(E.detectFoundedYear("since 2030", TODAY), null);
  eq(E.detectWebSignals("Since 2020 we build APIs. Acme has acquired Beta.", "", TODAY).map((s) => s.signal_type), ["acquisition"]);
  eq(E.detectWebSignals("", "", TODAY), []);
});

fact("registrySignals: a rename in the last 3 years is an ownership_change signal", () => {
  const reg = { status: "ok", legal_name: "New Oy", business_id: "1234567-8", previous_names: [{ name: "Old Oy", until: "2024-06-30" }, { name: "Older Oy", until: "2019-01-01" }, { name: "X", until: null }] };
  eq(E.registrySignals(reg, "", TODAY), [{ signal_type: "ownership_change", date: "2024-06-30", headline: "Registered name changed from Old Oy to New Oy",
    source: "Finnish Trade Register (PRH)", url: "https://tietopalvelu.ytj.fi/yritys/1234567-8" }]);
  eq(E.registrySignals(reg, "https://prh.example/x", TODAY)[0].url, "https://prh.example/x");
  eq(E.registrySignals({ status: "not_found" }, "", TODAY), []);
});

// ---- matcher -----------------------------------------------------------------------------------------------------------
fact("parseEbitdaEur handles the same spellings (and quirks) as the Python", () => {
  eq(E.parseEbitdaEur("€5.2M"), 5200000); eq(E.parseEbitdaEur("12 million"), 12000000); eq(E.parseEbitdaEur("1.2B"), 1200000000);
  eq(E.parseEbitdaEur("12,000,000"), 12000000); eq(E.parseEbitdaEur("EUR 3.4m"), 3400000); eq(E.parseEbitdaEur(1200000), 1200000);
  eq(E.parseEbitdaEur("Confidential"), null); eq(E.parseEbitdaEur("Pending Audit"), null); eq(E.parseEbitdaEur(null), null); eq(E.parseEbitdaEur("n/a"), null);
  eq(E.parseEbitdaEur("€500k"), 500000000); // the Python treats "500" with a € sign as 500 million; kept on purpose
});

fact("scoreBuyer: SaaS Helsinki €1.2M vs Finnish SaaS buyer → 50/20/20/4 = 94, strong", () => {
  const m = E.scoreBuyer(FI_BUYER, SAAS_PROFILE);
  eq(m.parts, { sector: 50, region: 20, size: 20, verified: 4 }); eq(m.score, 94); eq(m.verdict, "strong");
  eq(m.summary, "Same kind of company, in their region. Right size.");
  eq(m.checks, {
    sector: { ok: "yes", label: "B2B SaaS & Digital Services", detail: "Sector matches what the buyer wants (B2B SaaS & Digital Services)" },
    region: { ok: "yes", label: "Finland", detail: "Located in the buyer's region (Finland)" },
    size: { ok: "yes", label: "€0–3M EBITDA", detail: "EBITDA inside the buyer's range (€0–3M)" }, // f"{0.5:.0f}" is "0" in Python
  });
  eq(m.axes, { sector: 100, region: 100, size: 100 }); eq(m.company_ebitda_eur, 1200000); eq(m.in_mandate_band, true);
  eq(m.reasons, ["Sector matches what the buyer wants (B2B SaaS & Digital Services)", "Located in the buyer's region (Finland)", "EBITDA inside the buyer's range (€0–3M)"]);
  eq(m.gaps, ["Sector unclear from the website"]);
  eq([m.buyer_id, m.buyer_name, m.target_sector, m.geographic_focus, m.min_ebitda_eur, m.max_ebitda_eur], [7, "Sponsor Nordic", "B2B SaaS & Digital Services", "Finland", 500000, 3000000]);
});

fact("scoreBuyer: retail company in London vs CapMan → 8/4/8/4 = 24, weak, size just outside", () => {
  const m = E.scoreBuyer(CAPMAN, { company_name: "Far Ltd", sector: "Retail", products: "furniture store", ebitda: "€2.5M", verified: false, geographic_hint: "London, UK" });
  eq(m.parts, { sector: 8, region: 4, size: 8, verified: 4 }); eq(m.score, 24); eq(m.verdict, "weak");
  eq(m.summary, "Different sector, outside their region. Size is close.");
  eq(m.gaps, ["Sector mismatch: buyer wants B2B SaaS & Digital Services, company looks like Retail", "Outside the buyer's region (Nordics)",
    "EBITDA €2.5M is just outside the buyer's range (€3–12M)", "Sector unclear from the website"]);
  eq(m.checks.region.ok, "no"); eq(m.checks.size.ok, "partial"); eq(m.axes, { sector: 16, region: 20, size: 40 });
  const unknown = E.scoreBuyer(CAPMAN, { sector: "", products: "Pending Analysis", ebitda: "Confidential", geographic_hint: "" });
  eq(unknown.parts, { sector: 8, region: 8, size: 10, verified: 4 }); eq(unknown.summary, "Different sector, location not on the site. Size not public.");
  eq(unknown.checks.size.detail, "EBITDA not public; buyer needs €3–12M");
  eq(E.scoreBuyer({ buyer_name: "No band", target_sector: "", geographic_focus: "", min_ebitda_eur: null, max_ebitda_eur: "abc" }, SAAS_PROFILE).checks.size, { ok: "unknown", label: "size band", detail: "" });
});

fact("rankBuyers sorts by score (stable) and summarizeMatches reads the spread like the Python", () => {
  const twin = { ...CAPMAN, id: 99, buyer_name: "Twin" };
  eq(E.rankBuyers([CAPMAN, twin, FI_BUYER], SAAS_PROFILE).map((r) => r.buyer_name), ["Sponsor Nordic", "CapMan", "Twin"]);
  const stats = (scores) => E.summarizeMatches(scores.map((score) => ({ score })));
  eq(stats([94, 40, 30, 20]), { n: 4, best: 94, mean: 46, median: 35, stdev: 28.6, min: 20, max: 94, lift: 59, strong: 1, possible: 0, weak: 3,
    read: "One buyer stands out from the rest.", scores: [94, 40, 30, 20] });
  eq(stats([95, 60, 50, 24]).mean, 57.2); // round(57.25, 1) → 57.2 in Python (half-even), not 57.3
  eq(stats([80, 76, 30]).read, "Several buyers are a strong fit.");
  eq(stats([60, 55]).read, "Possible fits only — no strong mandate yet.");
  eq(stats([75, 70, 65]).read, "A few buyers are close; none dominate.");
  eq(stats([50, 20]).read, "No buyer in the book is a fit.");
  eq(E.summarizeMatches([]), { n: 0, best: 0, mean: 0, median: 0, stdev: 0, min: 0, max: 0, lift: 0, strong: 0, possible: 0, weak: 0, read: "No buyer mandates to compare.", scores: [] });
});

// ---- scoring -----------------------------------------------------------------------------------------------------------
fact("toProfile shapes a record like a scraper profile (EBITDA formatted the Python way)", () => {
  eq(E.toProfile(record()), { company_name: "Nordic Cloud Oy", sector: "B2B SaaS & Digital Services", products: "B2B SaaS & Digital Services", customers: "Pending Analysis",
    ebitda: "€3.6M", verified: false, fetched: false, evidence: [], source_url: "", geographic_hint: "finland nordics", company_id: 1 });
  eq(E.toProfile(record({ ebitda_eur: 5250000, legal_name: "Nordic Cloud Oy (legal)", geographic_hint: "Espoo" })).ebitda, "€5.2M"); // f"{5.25:.1f}" → "5.2"
  eq(E.toProfile(record({ legal_name: "Legal Oy", geographic_hint: "Espoo" })).geographic_hint, "finland nordics Espoo");
  eq(E.toProfile({ ...record({ ebitda_eur: null, sector: "" }), website: { fetched: true, verified: true } }), { company_name: "Nordic Cloud Oy", sector: "Unverified Sector",
    products: "Pending Analysis", customers: "Pending Analysis", ebitda: "Pending Audit", verified: true, fetched: true, evidence: [], source_url: "", geographic_hint: "finland nordics", company_id: 1 });
});

fact("estimateEv / floorStatus / tierFor use Mergero's €3-5M floor and €100M ceiling", () => {
  eq(E.estimateEv({ sector: "B2B SaaS & Digital Services", ebitda_eur: 3600000 }), [36000000, 10]);
  eq(E.estimateEv({ sector: "Unknown", ebitda_eur: 1000000 }), [7000000, 7]); eq(E.estimateEv({ sector: "Food & Beverage", ebitda_eur: null }), [null, 7]);
  eq([null, 2999999, 3000000, 4999999, 5000000, 100000000, 100000001].map(E.floorStatus), ["unknown", "below", "borderline", "borderline", "above", "above", "too_large"]);
  eq([100, 80, 79, 60, 59, 0].map(E.tierFor), ["A", "A", "B", "B", "C", "C"]);
});

fact("scoreProspect: founder SaaS company with CapMan → 20 + 34 + 12 = 66, tier B, full explanation", () => {
  const rec = record();
  const triggers = E.detectTriggers(rec, TODAY);
  const s = E.scoreProspect(rec, triggers, [CAPMAN]);
  eq([s.score, s.tier, s.timing, s.fit, s.urgency], [66, "B", 20, 34, 12]);
  eq(s.explanation, [
    'Timing 20/40: strongest trigger is "Founder-generation succession likely"',
    "Fit 34/35: best buyer CapMan scores 94/100",
    "Estimated value €36.0M (10x EBITDA) clears Mergero's €3-5M minimum",
    "Urgency 12/25: sell-side triggers on 1 theme(s) (succession), the owner is still CEO",
  ]);
  eq([s.ev_estimate, s.ev_multiple, s.in_band, s.floor_check], [36000000, 10, true, "above"]);
  eq(s.best_buyers.length, 1); eq(s.best_buyers[0].buyer_name, "CapMan"); eq(s.best_buyers[0].score, 94); eq(s.best_buyers[0].verdict, "strong");
  eq(Object.keys(s.best_buyers[0]), ["buyer_id", "buyer_name", "score", "target_sector", "geographic_focus", "verdict", "summary", "checks", "axes", "parts",
    "company_ebitda_eur", "min_ebitda_eur", "max_ebitda_eur", "reasons", "gaps"]);
  eq(s.match_stats.n, 1); eq(s.match_stats.read, "A few buyers are close; none dominate.");
  // A 90/100 buyer gives round(22.5) = 22 fit points in Python (half-even), so fit is 32, not 33.
  const euro = E.scoreProspect(rec, triggers, [{ ...CAPMAN, id: 5, buyer_name: "EuroCap", geographic_focus: "Europe" }]);
  eq(euro.best_buyers[0].score, 90); eq(euro.fit, 32); eq(euro.explanation[1], "Fit 32/35: best buyer EuroCap scores 90/100"); eq(euro.score, 64);
});

fact("scoreProspect: every passed buyer is scored and kept", () => {
  const rec = record();
  const buyers = [
    CAPMAN,
    FI_BUYER,
    { id: 8, buyer_name: "WasteCap", target_sector: "Circular economy / Waste logistics", min_ebitda_eur: 3000000, max_ebitda_eur: 12000000, geographic_focus: "Nordics" },
    { id: 9, buyer_name: "EuroInd", target_sector: "Manufacturing & Industrial Automation", min_ebitda_eur: 2000000, max_ebitda_eur: 15000000, geographic_focus: "Europe" },
  ];
  const s = E.scoreProspect(rec, E.detectTriggers(rec, TODAY), buyers);
  eq(s.best_buyers.length, buyers.length);
  eq(s.match_stats.n, buyers.length);
  eq(new Set(s.best_buyers.map((b) => b.buyer_id)).size, buyers.length);
  eq(s.best_buyers[0].score, Math.max(...s.best_buyers.map((b) => b.score)));
});

fact("scoreProspect: several sell-side themes, a recent trigger and an owner-CEO max out urgency at 25", () => {
  const rec = record({}, [
    { signal_type: "growth", date: "2026-09-27", headline: "ARR up", source: "News" },
    { signal_type: "capital_need", date: "2025-09-27", headline: "Looking for capital", source: "News" },
  ]);
  const s = E.scoreProspect(rec, E.detectTriggers(rec, TODAY), [CAPMAN]);
  eq([s.score, s.tier, s.timing, s.fit, s.urgency], [87, "A", 28, 34, 25]);
  eq(s.explanation[3], "Urgency 25/25: sell-side triggers on 2 theme(s) (capital, succession), a trigger in the last 6 months, the owner is still CEO");
  const none = E.scoreProspect(record({ ownership_type: "listed", ebitda_eur: null }), [], []);
  eq(none, { score: 0, tier: "C", timing: 0, fit: 0, urgency: 0, explanation: ["Timing 0/40: no transaction trigger detected yet",
    "EBITDA unknown, so the value can't be checked against Mergero's €3-5M minimum", "Urgency 0/25: nothing pressing"], best_buyers: [],
    match_stats: E.summarizeMatches([]), ev_estimate: null, ev_multiple: 10, in_band: false, floor_check: "unknown" });
  eq(E.scoreProspect(record({ ebitda_eur: 400000 }), [], []).explanation[1], "Estimated value €4.0M (10x EBITDA) is at Mergero's €3-5M minimum, so borderline");
  eq(E.scoreProspect(record({ ebitda_eur: 200000 }), [], []).explanation[1], "Estimated value €2.0M (10x EBITDA) is below Mergero's €3-5M minimum valuation");
  eq(E.scoreProspect(record({ ebitda_eur: 15000000 }), [], []).explanation[1], "Estimated value €150.0M (10x EBITDA) is above the €100M range Mergero serves");
});

fact("rankProspects orders companies by score and keeps their ids", () => {
  const rows = E.rankProspects(new Map([[1, record()], [7, PE_RECORD]]), [CAPMAN], TODAY);
  // PE record: timing 32 + fit (round(25 * 82 / 100) = 20, half-even, + 10 band) + urgency 8 = 70.
  eq(rows.map((r) => [r.company_id, r.scored.score]), [[7, 70], [1, 66]]);
  eq(E.rankProspects({ 1: record(), 7: PE_RECORD }, [CAPMAN], TODAY).map((r) => r.company_id), [7, 1]);
});

// ---- hypothesis ------------------------------------------------------------------------------------------------------
fact("buildHypothesis: succession mandate, headline, why-now lines, owner angle with age, EV range", () => {
  const rec = record();
  const triggers = E.detectTriggers(rec, TODAY);
  const h = E.buildHypothesis(rec, triggers, E.scoreProspect(rec, triggers, [CAPMAN]), TODAY);
  eq(h.mandate_type, "Succession sale"); eq(h.side, "sell");
  eq(h.headline, "Succession sale for Nordic Cloud Oy: founder-generation succession likely");
  eq(h.why_now, ["Founder-generation succession likely: Founder-owned and founded in 1990 (36 years ago)"]);
  eq(h.why_mergero, E.WHY_MERGERO.sell);
  eq(E.toPoints("First point. Second point follows. Third stays too."), ["First point", "Second point follows", "Third stays too"]);
  eq(h.owner_angle, "Owners who have built a company over 36 years often start thinking about the next chapter well before anything changes, and it helps to know early which options are open.");
  eq(h.suggested_buyers.length, 1); eq(h.questions_for_owner, ["Is there a family or management successor?", "What timeline does the owner have in mind?", "Full sale, or staying on for a transition period?"]);
  eq(h.ev_range, "€29-43M"); eq(h.source, "template");
  const none = E.buildHypothesis(record({ ownership_type: "listed", ebitda_eur: null, legal_name: "Nordic Cloud Oyj" }), [], E.scoreProspect(record({ ebitda_eur: null }), [], []), TODAY);
  eq([none.mandate_type, none.side, none.headline, none.why_now, none.ev_range], ["Relationship build (no trigger yet)", "sell", "Relationship build (no trigger yet) for Nordic Cloud Oyj", [], "Unknown until financials are confirmed"]);
  const pe = E.buildHypothesis(PE_RECORD, E.detectTriggers(PE_RECORD, TODAY), { best_buyers: [], ev_estimate: 24000000 }, TODAY);
  eq(pe.headline, "Secondary buyout (PE exit) for Fjordline Data AS: pe holding period ending, exit window"); eq(pe.ev_range, "€19-29M");
  eq(pe.why_now, ["PE holding period ending, exit window (2021-09-27): PE owner since 2021 (5.0 years; typical hold is 4-6)", "Ownership change (2021-09-27): PE owner entered"]);
});

// ---- outreach --------------------------------------------------------------------------------------------------------
fact("chooseChannel: PE → email to partner, DACH → LinkedIn + phone, otherwise email + LinkedIn", () => {
  eq(E.chooseChannel(PE_RECORD.company), { channel: "Email to investment partner", tone: "Direct and deal-focused", step_channels: ["Email", "Email", "Email", "Email"], style: "pe" });
  eq(E.chooseChannel(DACH_RECORD.company), { channel: "LinkedIn + phone", tone: "Formal (Sie), brief, buyer-demand-led", step_channels: ["LinkedIn", "Phone", "Email", "Email"], style: "dach" });
  eq(E.chooseChannel(record().company), { channel: "Email + LinkedIn", tone: "Direct and short, buyer-demand-led, 20-minute ask", step_channels: ["Email", "Email", "LinkedIn", "Email"], style: "nordic" });
});

fact("firstTouchIssues flags Mergero's banned first-touch words, with Python's Unicode word boundaries", () => {
  eq(E.firstTouchIssues("we can discuss a sale and the valuation"), ["sale", "valuation"]);
  eq(E.firstTouchIssues("Verkaufsgespräch über M&A und Exit-Strategie, sales"), ["exit", "m&a", "verkaufsgespräch"]);
  eq(E.firstTouchIssues("Selling is a sales process; Bewertungen; exits"), ["bewertungen", "exits", "sales process", "selling"]);
  eq(E.firstTouchIssues("Nothing to flag: options, growth partner, minority stake."), []); eq(E.firstTouchIssues(""), []);
});

fact("planOutreach for a DACH company: 4 steps LinkedIn/Phone/Email/Email with the German bodies", () => {
  const triggers = E.detectTriggers(DACH_RECORD, TODAY);
  const h = E.buildHypothesis(DACH_RECORD, triggers, E.scoreProspect(DACH_RECORD, triggers, []), TODAY);
  const plan = E.planOutreach(DACH_RECORD, h, TODAY);
  eq([plan.channel, plan.tone, plan.contact_name, plan.stopped, plan.stop_reason], ["LinkedIn + phone", "Formal (Sie), brief, buyer-demand-led", "Thomas Krüger", false, null]);
  eq(plan.sequence.map((s) => [s.step, s.day, s.channel, s.status, s.sent_at, s.source]), [[0, 0, "LinkedIn", "drafted", null, "template"], [1, 4, "Phone", "drafted", null, "template"], [2, 10, "Email", "drafted", null, "template"], [3, 21, "Email", "drafted", null, "template"]]);
  eq(plan.sequence.map((s) => s.subject), ["LinkedIn-Nachricht", "Telefonleitfaden (60 Sekunden)", "Rhein Software Handel GmbH: Käuferinteresse", "Abschluss"]);
  eq(plan.sequence[0].body, "Guten Tag Thomas Krüger,\n\nKäufer aus unserem Netzwerk suchen derzeit aktiv nach Unternehmen in Ihrer Branche, und Rhein Software Handel GmbH ist uns aufgefallen. "
    + "Wer ein Unternehmen über 25 Jahre aufgebaut hat, denkt oft schon lange vor jeder Veränderung über das nächste Kapitel nach, und es hilft, die Optionen früh zu kennen.\n\n"
    + "Hätten Sie Zeit für ein vertrauliches Gespräch von 20 Minuten? Ganz unverbindlich.");
  eq(plan.sequence[1].body, "Kurz vorstellen (Mergero) und auf die LinkedIn-Nachricht Bezug nehmen.\n"
    + "Aufhänger: Käufer aus unserem Netzwerk suchen derzeit aktiv nach Unternehmen in Ihrer Branche, und Rhein Software Handel GmbH ist uns aufgefallen.\n"
    + "Eine Frage: Wie sehen Ihre Pläne für Rhein Software Handel GmbH in den nächsten Jahren aus?\nZiel: ein vertrauliches Gespräch von 20 Minuten vereinbaren.");
  eq(plan.sequence[2].body, "Guten Tag Thomas Krüger,\n\nich hatte Ihnen kürzlich auf LinkedIn geschrieben. Ich habe eine kurze, anonymisierte Übersicht zusammengestellt, wonach Käufer bei Unternehmen wie Ihrem derzeit suchen. Soll ich sie Ihnen unverbindlich zusenden?");
  eq(plan.sequence[3].body, "Guten Tag Thomas Krüger,\n\nich möchte Ihr Postfach nicht überfüllen, daher ist dies vorerst meine letzte Nachricht. Wenn der Zeitpunkt später besser passt, antworten Sie einfach.");
  const two = E.planOutreach(DACH_RECORD, { ...h, suggested_buyers: [{ score: 80 }, { score: 60 }, { score: 40 }] }, TODAY);
  eq(two.sequence[0].body.startsWith("Guten Tag Thomas Krüger,\n\nZwei Käufer aus unserem Netzwerk suchen derzeit gezielt nach Unternehmen wie Rhein Software Handel GmbH. Wer"), true);
  eq(E.planOutreach(record({ region: "DACH", owner_name: "", ceo_name: "" }), h, TODAY).sequence[0].body.startsWith("Guten Tag,\n\n"), true);
});

fact("planOutreach for a Nordic owner: English opener with the soft door and the 20-minute ask", () => {
  const rec = record();
  const triggers = E.detectTriggers(rec, TODAY);
  const h = E.buildHypothesis(rec, triggers, E.scoreProspect(rec, triggers, [CAPMAN]), TODAY);
  const plan = E.planOutreach(rec, h, TODAY);
  eq(plan.sequence.map((s) => s.channel), ["Email", "Email", "LinkedIn", "Email"]); eq(plan.contact_name, "Mikael Lindström");
  eq(plan.sequence.map((s) => s.subject), ["Buyer interest in companies like Nordic Cloud Oy", "A quick follow-up", "LinkedIn note", "Closing the loop"]);
  eq(plan.sequence[0].body, "Hi Mikael,\n\nA buyer in our network is currently looking for companies like Nordic Cloud Oy. "
    + "Owners who have built a company over 36 years often start thinking about the next chapter well before anything changes, and it helps to know early which options are open.\n\n"
    + "Nothing needs to change: some owners start with a growth partner or a minority stake, others simply want to understand their options for the next few years.\n\n"
    + "Would a 20-minute confidential conversation be useful? No commitment, no documents.");
  eq(plan.sequence[1].body, "Hi Mikael,\n\nA quick follow-up on my note about Nordic Cloud Oy. The buyers we work with tend to move early, often a year or two before an owner decides anything, so an early conversation keeps every option open.\n\nHappy to work around your calendar.");
  eq(plan.sequence[2].body, "Hi Mikael, I put together a short, anonymised view of what buyers are looking for in B2B SaaS & Digital Services right now. Happy to share it, no strings attached.");
  eq(plan.sequence[3].body, "Hi Mikael,\n\nI don't want to crowd your inbox, so this is my last note for now. If the timing is better later, just reply and we'll pick it up.");
  eq(E.firstTouchIssues(plan.sequence[0].body), []); // the owner-facing template obeys the messaging rule
  // Growth mandate: no soft door; no fitting buyer: generic buyer line.
  const growth = E.planOutreach(rec, { ...h, mandate_type: "Growth partner / minority stake", owner_angle: E.OWNER_ANGLE["Growth partner / minority stake"], suggested_buyers: [{ score: 54 }] }, TODAY);
  eq(growth.sequence[0].body, "Hi Mikael,\n\nBuyers in our network are actively looking at B2B SaaS & Digital Services companies in the Nordics, and Nordic Cloud Oy stood out. "
    + "With the growth you are showing, some owners bring in a partner for the next step while staying fully in charge.\n\nWould a 20-minute confidential conversation be useful? No commitment, no documents.");
  eq(E.planOutreach(rec, { ...h, suggested_buyers: [{ score: 90 }, { score: 70 }, { score: 55 }] }, TODAY).sequence[0].body.startsWith("Hi Mikael,\n\nThree buyers in our network are currently looking for companies like Nordic Cloud Oy. "), true);
});

fact("planOutreach for a PE-owned company: email to the CEO, deal-focused opener (exit wording allowed there)", () => {
  const triggers = E.detectTriggers(PE_RECORD, TODAY);
  const scored = E.scoreProspect(PE_RECORD, triggers, [CAPMAN]);
  const plan = E.planOutreach(PE_RECORD, E.buildHypothesis(PE_RECORD, triggers, scored, TODAY), TODAY);
  eq([plan.channel, plan.contact_name], ["Email to investment partner", "Ingrid Solberg"]); eq(plan.sequence.map((s) => s.channel), ["Email", "Email", "Email", "Email"]);
  eq(plan.sequence[0].subject, "Fjordline Data AS: buyer interest");
  eq(plan.sequence[0].body, "Hi Ingrid,\n\nI'm reaching out about Fjordline Data AS. With the current holding period, it may be a good moment to see what trade buyers and other investors are looking for today.\n\n"
    + "We currently hold an active buyer mandate that fits companies like this. We run off-market processes across the Nordics and DACH.\n\n"
    + "Would a short call on exit routes and what buyers are paying today be useful?");
  eq(plan.sequence.slice(1).map((s) => s.subject), ["Following up", "Recent transactions", "Closing the loop"]);
  eq(plan.sequence[2].body, "Hi Ingrid,\n\nI put together a short, anonymised view of recent B2B SaaS & Digital Services transactions. Happy to share it.");
  eq(E.firstTouchIssues(plan.sequence[0].body), ["exit"]);
});

fact("ownerWarmup / icNote / sellSideWarmup reproduce outreach.py", () => {
  const match = E.scoreBuyer(FI_BUYER, SAAS_PROFILE);
  eq(E.ownerWarmup(SAAS_PROFILE, match, "Anna Berg"), "Hi Anna,\n\nBuyers in our network are currently looking for B2B SaaS companies like Testi Oy, with your mix (cloud software; customers: SMBs), in the Nordics.\n\n"
    + "Nothing needs to change: some owners start with a growth partner or a minority stake, others simply want to understand their options for the next few years.\n\n"
    + "Would a 20-minute confidential conversation be useful? No commitment, no documents.");
  eq(E.ownerWarmup({ company_name: "Rhein Software Handel GmbH", geographic_hint: "München, Germany" }, null, "Thomas Krüger"), "Guten Tag Thomas Krüger,\n\n"
    + "Käufer aus unserem Netzwerk suchen derzeit gezielt nach spezialisierten Unternehmen wie Rhein Software Handel GmbH. Es muss sich nichts ändern: Manche Eigentümer beginnen mit einem Wachstumspartner oder einer Minderheitsbeteiligung, andere möchten einfach ihre Optionen für die nächsten Jahre kennen.\n\n"
    + "Hätten Sie Zeit für ein vertrauliches Gespräch von 20 Minuten? Ganz unverbindlich.");
  eq(E.ownerWarmup({ products: "Pending Analysis", customers: "Pending Analysis" }).startsWith("Hi there,\n\nBuyers in our network are currently looking for specialist companies like your company in the Nordics.\n\n"), true);
  eq(E.icNote("CapMan", SAAS_PROFILE, match), "Investment committee note — CapMan / Testi Oy\n\nLive web screen of https://testi.fi. Match score 94/100.\n"
    + "Sector: B2B SaaS. EBITDA signal: €1.2M. Mix: cloud software; customers: SMBs.\n\n"
    + "Why this fit:\n- Sector matches what the buyer wants (B2B SaaS & Digital Services)\n- Located in the buyer's region (Finland)\n- EBITDA inside the buyer's range (€0–3M)\n\n"
    + "Gaps to confirm with the owner:\n- Sector unclear from the website\n\nAsk: approve a confidential owner warm-up. Off-market only; Mergero on the buy-side.");
  eq(E.icNote("X", { sector: "software", ebitda: "Pending Audit" }, {}), "Investment committee note — X / Target\n\nLive web screen of the corporate site.\nSector: software. EBITDA signal: Pending Audit. Mix: undisclosed mix.\n\n"
    + "Why this fit:\n- Public-site screen completed\n\nGaps to confirm with the owner:\n- None flagged\n\nAsk: approve a confidential owner warm-up. Off-market only; Mergero on the buy-side.");
  eq(E.sellSideWarmup({ company: "Nordic Cloud Oy", region: "Nordics", ceo: "Mikael Lindström", revenue_split: "60% SaaS / 40% services", top_clients: "Top 3 = 35%" }).startsWith(
    "Hi Mikael,\n\nBuyers in our network are currently looking for software companies like Nordic Cloud Oy, with your mix (60% SaaS / 40% services; customers: Top 3 = 35%), in the Nordics.\n\n"), true);
  eq(E.sellSideWarmup({ company: "Alpenstahl Bau GmbH", region: "DACH", ceo: null }).startsWith("Guten Tag,\n\nKäufer aus unserem Netzwerk suchen derzeit gezielt nach spezialisierten Unternehmen wie Alpenstahl Bau GmbH. "), true);
});

// ---- CRM -----------------------------------------------------------------------------------------------------------------
fact("extractTiming matches the multilingual timing phrases", () => {
  eq(E.extractTiming("next year"), "6-12 months"); eq(E.extractTiming("Let's do this ASAP"), "now"); eq(E.extractTiming("in ein paar Jahren"), "12+ months");
  eq(E.extractTiming("syksyllä sopii"), "3-6 months"); eq(E.extractTiming("next quarter or next year"), "3-6 months"); eq(E.extractTiming("no timing here"), "unknown"); eq(E.extractTiming(""), "unknown");
});

fact("mandateLikelihood: base by category, ±(score-50)/5, +10 now / -10 12+ months, clamped, unsubscribe is 0", () => {
  eq(E.mandateLikelihood("interested_now", "now", 60), 82); eq(E.mandateLikelihood("interested_now", "now", null), 80); eq(E.mandateLikelihood("interested_later", "12+ months", null), 25);
  eq(E.mandateLikelihood("needs_advisor", "unknown", 52), 55); eq(E.mandateLikelihood("needs_advisor", "unknown", 53), 56); eq(E.mandateLikelihood("interested_now", "now", 200), 100);
  eq(E.mandateLikelihood("not_interested", "12+ months", 0), 0); eq(E.mandateLikelihood("unsubscribe", "now", 100), 0);
  assert.throws(() => E.mandateLikelihood("bogus", "now", 50), RangeError);
});

fact("classifyRules: first matching phrase wins in RULES order, else needs_advisor at 0.3", () => {
  eq(E.classifyRules("Ei kiitos, emme ole myymässä yritystä."), { category: "not_interested", confidence: 0.8, timing: null, reason: 'Reply contains "ei kiitos"', source: "rules" });
  eq(E.classifyRules("Not interested, but happy to talk").category, "not_interested"); eq(E.classifyRules("Please unsubscribe. Happy to talk though.").category, "unsubscribe");
  eq(E.classifyRules("???"), { category: "needs_advisor", confidence: 0.3, timing: null, reason: "No clear pattern, so a person should read it", source: "rules" });
});

fact("qualifyReply answers interested / timing / mandate potential (rules path)", () => {
  eq(E.qualifyReply("Ei kiitos, emme ole myymässä yritystä."), { category: "not_interested", confidence: 0.8, timing: "unknown", reason: 'Reply contains "ei kiitos"', source: "rules",
    label: "Not interested", mandate_likelihood: 5, potential_mandate: false, mandate_type: null, next_action: "Close politely; revisit only if a new trigger appears" });
  const now = E.qualifyReply(E.SAMPLE_REPLIES.interested_now, { prospectScore: 70, mandateType: "Succession sale" });
  eq([now.category, now.timing, now.mandate_likelihood, now.potential_mandate, now.mandate_type, now.next_action], ["interested_now", "now", 84, true, "Succession sale", "Book the first call with an advisor this week"]);
  const later = E.qualifyReply(E.SAMPLE_REPLIES.interested_later, { prospectScore: 93 });
  // "next year" precedes "not right now" in the interested_later phrase list, so it is the reported hit.
  eq([later.category, later.reason, later.timing, later.mandate_likelihood, later.potential_mandate], ["interested_later", 'Reply contains "next year"', "6-12 months", 44, false]);
  const phone = E.qualifyReply("Call me next week", { prospectScore: 100 });
  eq([phone.category, phone.label, phone.timing, phone.mandate_likelihood, phone.potential_mandate], ["needs_advisor", "Needs an advisor", "now", 75, true]);
  eq(E.qualifyReply(E.SAMPLE_REPLIES.unsubscribe, { prospectScore: 100 }).mandate_likelihood, 0);
  eq(E.qualifyReply("").timing, "unknown");
});

fact("qualifyReply with a pre-computed (Claude) classification replaces the rules, invalid categories fall back", () => {
  const q = E.qualifyReply("Let's talk next quarter", { prospectScore: 50, mandateType: "Succession sale", classification: { category: "interested_later", timing: null, reason: "Owner wants to wait", source: "claude", confidence: 0.9 } });
  eq(q, { category: "interested_later", confidence: 0.9, timing: "3-6 months", reason: "Owner wants to wait", source: "claude", label: "Interested later", mandate_likelihood: 35, potential_mandate: false,
    mandate_type: "Succession sale", next_action: "Pause the sequence and follow up on the scheduled date" });
  eq(E.qualifyReply("Sounds good", { classification: { category: "interested_now", timing: "12+ months", reason: "" } }).timing, "12+ months");
  eq(E.qualifyReply("Sounds good", { classification: { category: "interested_now", timing: "someday", reason: "" } }).reason, "Classified by the language model");
  eq(E.qualifyReply("Sounds good", { classification: { category: "bogus" } }).source, "rules");
});

fact("nextAction: the single next step for each conversation / campaign state", () => {
  const camp = (statuses, sentAt = {}) => ({ sequence: statuses.map((status, i) => ({ step: i, day: [0, 4, 10, 21][i], channel: "Email", subject: "", body: "", status, sent_at: sentAt[i] ?? null, source: "template" })), stopped: false, stop_reason: null });
  eq(E.nextAction(E.newConversation(), null, TODAY), { key: "plan", label: "Plan outreach", step: 5 });
  eq(E.nextAction(E.newConversation(), camp(["drafted", "drafted", "drafted", "drafted"]), TODAY), { key: "send", label: "Send first message", step: 5, message_step: 0 });
  eq(E.nextAction({ ...E.newConversation(), stage: "Contacted" }, camp(["sent", "drafted", "drafted", "drafted"], { 0: "2026-09-20T09:00:00+00:00" }), TODAY), { key: "send", label: "Send day-4 follow-up", step: 5, message_step: 1 });
  eq(E.nextAction({ ...E.newConversation(), stage: "Contacted" }, camp(["sent", "drafted", "drafted", "drafted"], { 0: "2026-09-25T09:00:00.000Z" }), TODAY), { key: "log_reply", label: "Log owner reply", step: 6 });
  eq(E.nextAction({ ...E.newConversation(), stage: "Contacted" }, { ...camp(["sent", "cancelled", "cancelled", "cancelled"], { 0: "2026-09-01T09:00:00+00:00" }), stopped: true }, TODAY).key, "log_reply");
  eq(E.nextAction({ ...E.newConversation(), stage: "Replied", follow_up_on: "2026-10-01" }, null, TODAY), { key: "wait", label: "Follow up on 2026-10-01", step: 6 });
  eq(E.nextAction({ ...E.newConversation(), stage: "Replied", follow_up_on: "2026-09-27" }, null, TODAY), { key: "follow_up", label: "Follow up with the owner", step: 5 });
  eq(E.nextAction({ ...E.newConversation(), stage: "Qualified" }, null, TODAY), { key: "handoff", label: "Book first call with advisor", step: 7 });
  eq(E.nextAction({ ...E.newConversation(), stage: "Advisor handoff" }, null, TODAY), { key: "mandate", label: "Engagement letter signed", step: 7 });
  eq(E.nextAction({ ...E.newConversation(), stage: "Mandate" }, null, TODAY), { key: "done", label: "Mandate won", step: 7 });
  eq(E.nextAction({ ...E.newConversation(), stage: "Replied", closed: true }, null, TODAY), { key: "closed", label: "Closed", step: 6 });
  eq(E.nextAction({}, null).key, "plan"); // a bare object behaves like a fresh conversation, today defaults to now
});

fact("funnel counts companies that reached each stage; advanceStage never moves backwards", () => {
  eq(E.funnel(["Prospect", "Contacted", "Replied", "Qualified", "Advisor handoff", "Mandate"]), { prospects: 6, contacted: 5, replied: 4, qualified: 3, handed_off: 2, mandates: 1 });
  eq(E.funnel([]), { prospects: 0, contacted: 0, replied: 0, qualified: 0, handed_off: 0, mandates: 0 });
  eq(E.funnel([{ stage: "Replied" }, null]), { prospects: 2, contacted: 1, replied: 1, qualified: 0, handed_off: 0, mandates: 0 });
  const c = E.newConversation();
  E.advanceStage(c, "Replied"); E.advanceStage(c, "Contacted"); eq(c.stage, "Replied");
  E.advanceStage(c, "Mandate"); eq(c.stage, "Mandate");
  assert.throws(() => E.advanceStage(c, "Nope"), RangeError);
  eq(E.newConversation(), { stage: "Prospect", thread: [], follow_up_on: null, closed: false, outcome: null, last_category: null, last_qualification: null, handoff: null });
});

// ---- report ------------------------------------------------------------------------------------------------------------
if (failures.length) {
  console.log(`FAIL: ${failures.length} of ${passed + failures.length} facts failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS: ${passed} facts about engine.js hold (${Object.keys(E).length} exports)`);
