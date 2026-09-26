// Buy-side mandate generation: a buyer's investment thesis → structured criteria → off-market targets pulled from the
// open registers → scored against the thesis → a pitch that wins the buy-side mandate
// ("we found 40 unlisted companies matching your thesis; 6 owners are already talking to us").
import { z } from "zod/v4";
import * as db from "./db.js";
import * as registry from "./registry.js";
import { parse, runTracked } from "./agents.js";
import { ensureBuyerContacts } from "./suggest.js";
import { icpForPrompt, MESSAGING_PRINCIPLES } from "./playbook.js";

const CriteriaSchema = z.object({
  buyer_name: z.string().describe("Short anonymised name for the mandate, e.g. 'Nordic industrial buyout fund'"),
  buyer_type: z.enum(["PE", "family_office", "strategic"]),
  thesis_summary: z.string().describe("Two sentences in plain words"),
  sectors: z.array(z.string()).describe("Sector labels from: Industrial equipment, Manufacturing, B2B software, IT services, Healthcare services, Medtech, Logistics, Food processing, Engineering services, Business services, Cleantech, E-commerce, or a precise custom label"),
  industry_codes: z.array(z.object({ code: z.string().describe("NACE Rev. 2 code prefix with 2 to 4 digits, no dots, e.g. 28, 2822, 6201"), label: z.string() })).min(1).describe("The 1 to 4 NACE codes that best cover the thesis; broad codes find more companies"),
  geographies: z.array(z.string()).describe("ISO codes among FI, SE, NO, DK, DE, AT, CH; use EU for pan-European"),
  revenue_min_eur: z.number().nullable(), revenue_max_eur: z.number().nullable(),
  ebitda_min_eur: z.number().nullable(), ebitda_max_eur: z.number().nullable(),
  employees_min: z.number().int().nullable().describe("Headcount proxy for the revenue band when the registers cannot filter by revenue"),
  employees_max: z.number().int().nullable(),
  deal_types: z.array(z.enum(["majority", "minority", "buyout", "add-on", "growth"])),
  owner_situation: z.string().describe("Owner situations this buyer prefers, e.g. succession, founder stays two years"),
  exclusions: z.array(z.string()),
});
const TargetScoreSchema = z.object({
  scores: z.array(z.object({
    registry_id: z.string(),
    fit: z.number().int().min(0).max(100),
    reason: z.string().describe("One sentence tying the company to the thesis"),
    owner_signal: z.string().describe("One short phrase on the owner situation if known (age, tenure, founder), else empty string"),
  })),
});
const PitchSchema = z.object({
  subject: z.string(),
  email_body: z.string().describe("120-180 words to the buyer contact: what we scanned, how many fit, how many owners already talk to us, one anonymised example, the proposed buy-side mandate, one question. Human, no lists."),
  one_pager: z.object({
    headline: z.string(),
    market_scan: z.string().describe("What was scanned: registers, codes, countries, counts"),
    how_we_found_them: z.string().describe("Method in 2-3 sentences: registers, owner-age signals, research agents, off-market network"),
    highlights: z.array(z.string()).describe("4-6 anonymised target profiles: sector, region, size band, founded, owner situation; never names"),
    already_in_conversation: z.string(),
    proposed_mandate: z.string().describe("Exclusive buy-side search mandate: scope, process, what the buyer gets, timing"),
    next_step: z.string(),
  }),
});

const REGISTRY_COUNTRIES = ["FI", "NO"];
const WARM = new Set(["replied", "warming", "meeting_booked", "mandate_signed"]);
const eurM = (n) => (n == null ? "n/a" : `€${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`);
const year = () => new Date().getFullYear();

function mandates() { const s = db.load(); s.buyside = s.buyside || []; return s.buyside; }
const byId = (id) => mandates().find((m) => m.id === id) || (() => { throw Object.assign(new Error("Mandate not found"), { status: 404 }); })();

// 1. Thesis → criteria
export async function parseThesis(text, hints, settings) {
  return parse(settings, {
    schema: CriteriaSchema,
    effort: "medium",
    system: `You turn a buyer's investment thesis into search criteria for off-market target sourcing from Nordic and DACH company registers. ${icpForPrompt()}\nRegisters filter by NACE industry code and (Norway) headcount; revenue bands must be translated into a headcount proxy (roughly €0.15–0.25M revenue per employee for industrial and services companies, more for software). Prefer 2–3 digit NACE prefixes so the scan is wide; add one 4-digit code only when the thesis is narrow.`,
    user: `Investment thesis (verbatim):\n"""\n${text}\n"""\n${hints.buyer_name ? `Buyer name hint: ${hints.buyer_name}\n` : ""}${hints.buyer_type ? `Buyer type hint: ${hints.buyer_type}\n` : ""}${hints.countries?.length ? `Countries to scan: ${hints.countries.join(", ")}\n` : ""}`,
  });
}

// 2. Criteria → targets from the open registers (FI, NO today), de-duplicated and cross-checked against the pipeline
export async function sourceTargets(criteria, { maxTargets = 60, hintCountries = [] } = {}) {
  const wanted = new Set((hintCountries.length ? hintCountries : criteria.geographies).map((g) => g.toUpperCase()));
  const countries = REGISTRY_COUNTRIES.filter((c) => wanted.has(c) || wanted.has("EU"));
  const codes = (criteria.industry_codes || []).slice(0, 4).map((x) => String(x.code).replace(/\D/g, "")).filter(Boolean);
  const s = db.load();
  const known = new Map(s.companies.filter((c) => c.registry_id).map((c) => [c.registry_id, c]));
  const knownNames = new Map(s.companies.map((c) => [c.name.toLowerCase(), c]));
  const seen = new Set();
  const targets = [];
  const log = [];
  for (const country of countries) {
    for (const code of codes) {
      const params = { country, industry_code: code, page: 1 };
      if (country === "NO") { params.employees_min = criteria.employees_min || 10; }
      params.founded_before = year() - 5; // mature companies: an owner with history, not a start-up
      try {
        const r = await registry.search(params);
        log.push({ country, code, total: r.total, taken: r.results.length });
        for (const t of r.results) {
          const key = t.registry_id || `${t.name}|${t.country}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (criteria.employees_max && t.employees && t.employees > criteria.employees_max) continue;
          const existing = known.get(t.registry_id) || knownNames.get(t.name.toLowerCase());
          targets.push({ ...t, in_pipeline: Boolean(existing), company_id: existing?.id || null, stage: existing?.stage || null, owner_age: existing?.owner?.age || null, fit: null, reason: "" });
          if (targets.length >= maxTargets) break;
        }
      } catch (err) { log.push({ country, code, error: err.message }); }
      if (targets.length >= maxTargets) break;
    }
  }
  // Owners already talking to us in the same sectors (not necessarily in the target list): the pitch's strongest line.
  const sectorWords = (criteria.sectors || []).map((x) => x.toLowerCase());
  const warmOthers = s.companies.filter((c) => WARM.has(c.stage) && sectorWords.some((w) => String(c.industry || "").toLowerCase().includes(w) || w.includes(String(c.industry || "").toLowerCase())) && (wanted.has(c.country) || wanted.has("EU")));
  return { targets, log, warm_in_sector: warmOthers.map((c) => ({ company_id: c.id, stage: c.stage, industry: c.industry, country: c.country })) };
}

// 3. Score targets against the thesis (batches of 25)
export async function scoreTargets(criteria, targets, settings) {
  const out = new Map();
  for (let i = 0; i < targets.length; i += 25) {
    const batch = targets.slice(i, i + 25);
    const list = batch.map((t) => `- id ${t.registry_id || t.name}: ${t.name} | ${t.country} ${t.city || ""} | ${t.industry || ""} (${t.industry_code || ""}) | staff ${t.employees ?? "n/a"} | founded ${t.founded ?? "n/a"}${t.owner_age ? ` | owner ${t.owner_age}` : ""}${t.in_pipeline ? ` | already in our pipeline (${t.stage})` : ""}`).join("\n");
    const r = await parse(settings, {
      schema: TargetScoreSchema,
      effort: "low",
      system: `You rank off-market acquisition targets against a buyer's thesis. Fit 0-100: sector match with the thesis, size band (headcount as proxy), maturity, and any owner situation. Be calibrated: most land 30-70. Use exactly the ids given.`,
      user: `Thesis summary: ${criteria.thesis_summary}\nSectors: ${criteria.sectors.join(", ")} | Deal types: ${criteria.deal_types.join(", ")} | Size: revenue ${eurM(criteria.revenue_min_eur)}–${eurM(criteria.revenue_max_eur)}, staff ${criteria.employees_min ?? "?"}–${criteria.employees_max ?? "?"} | Owner situation: ${criteria.owner_situation}\nExclusions: ${criteria.exclusions.join("; ") || "none"}\n\nTargets:\n${list}`,
    });
    for (const sc of r.scores) out.set(String(sc.registry_id), sc);
  }
  return targets.map((t) => { const sc = out.get(String(t.registry_id || t.name)); return sc ? { ...t, fit: sc.fit, reason: sc.reason, owner_signal: sc.owner_signal } : { ...t, fit: 30, reason: "Not scored" }; })
    .sort((a, b) => (b.fit || 0) - (a.fit || 0));
}

// 4. The pitch that wins the mandate
export async function writePitch(m, settings) {
  const s = db.load();
  const sender = settings.sender;
  const top = m.targets.slice(0, 8);
  const inConv = m.targets.filter((t) => t.in_pipeline && WARM.has(t.stage)).length + (m.warm_in_sector || []).length;
  const anon = top.map((t) => `${t.industry || "company"} in ${t.city ? t.city + " region, " : ""}${t.country}, ${t.employees ? t.employees + " staff, " : ""}founded ${t.founded ?? "n/a"}${t.owner_age ? `, owner ${t.owner_age}` : ""}${t.owner_signal ? `, ${t.owner_signal}` : ""} (fit ${t.fit})`).join("\n");
  const counts = m.stats;
  const proof = (settings.value_props || []).join(" | ");
  return parse(settings, {
    schema: PitchSchema,
    effort: "high",
    system: `You write the pitch with which ${sender.name} (${sender.title}, ${sender.firm}) wins a buy-side search mandate from a professional buyer. The buyer has a thesis; we have already scanned the open company registers and our own off-market network and found concrete targets. Tone: senior advisor, specific, numbers first, no hype. Never name a target company or its people; describe them anonymised. House style: ${settings.style_rules}\n${MESSAGING_PRINCIPLES}\nProof points (use at most two): ${proof}`,
    user: `Buyer: ${m.criteria.buyer_name} (${m.criteria.buyer_type}). Thesis: ${m.criteria.thesis_summary}\nScan: ${counts.targets} unlisted companies matched across ${counts.countries.join(", ")} (registers: ${counts.log.map((l) => `${l.country} NACE ${l.code}: ${l.total ?? "n/a"} in register`).join("; ")}); ${counts.scored_70} score 70+ against the thesis; ${inConv} owners in these sectors are already in confidential conversations with us.\nTop anonymised targets:\n${anon}\n\nProposed mandate: exclusive buy-side search on this thesis, off-market, with our origination engine (registers + owner-age signals + research agents + humanised owner outreach), weekly pipeline reviews, success fee on completion. Sign the email as ${sender.name}, ${sender.title}, ${sender.firm}.`,
  });
}

function summarize(m) {
  const t = m.targets || [];
  return {
    targets: t.length, countries: [...new Set(t.map((x) => x.country))], scored_70: t.filter((x) => (x.fit || 0) >= 70).length, scored_50: t.filter((x) => (x.fit || 0) >= 50).length,
    in_pipeline: t.filter((x) => x.in_pipeline).length, in_conversation: t.filter((x) => x.in_pipeline && WARM.has(x.stage)).length + (m.warm_in_sector || []).length,
    with_owner_age: t.filter((x) => x.owner_age).length, log: m.log || [],
  };
}

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(`[${req.method} ${req.path}]`, err?.message || err); res.status(err.status || 500).json({ error: err?.message || String(err) }); });

export function register(app) {
  app.get("/api/buyside/mandates", (req, res) => res.json(mandates().map((m) => ({ ...m, targets: undefined, target_count: (m.targets || []).length }))));
  app.get("/api/buyside/mandates/:id", (req, res) => { try { res.json(byId(req.params.id)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });

  // Thesis → criteria → targets → scores, in one call (about a minute).
  app.post("/api/buyside/mandates", wrap(async (req, res) => {
    const text = String(req.body?.thesis_text || "").trim();
    if (text.length < 40) throw Object.assign(new Error("Paste the buyer's investment thesis (a few sentences)."), { status: 400 });
    const settings = db.load().settings;
    const hints = { buyer_name: req.body?.buyer_name, buyer_type: req.body?.buyer_type, countries: Array.isArray(req.body?.countries) ? req.body.countries : [] };
    const m = { id: db.uid("bs"), created_at: db.now(), thesis_text: text, status: "parsing", criteria: null, targets: [], warm_in_sector: [], log: [], stats: null, pitch: null, buyer_id: null, buyer_message_id: null };
    mandates().unshift(m); db.save();
    await runTracked(null, async () => {
      m.criteria = await parseThesis(text, hints, settings);
      if (hints.buyer_name) m.criteria.buyer_name = hints.buyer_name;
      if (hints.buyer_type) m.criteria.buyer_type = hints.buyer_type;
      m.status = "sourcing"; db.save();
      const src = await sourceTargets(m.criteria, { hintCountries: hints.countries });
      m.targets = src.targets; m.log = src.log; m.warm_in_sector = src.warm_in_sector;
      // Owner age from the Norwegian register for the top candidates (fast, best-effort, 4 at a time).
      const no = m.targets.filter((t) => t.country === "NO" && t.registry_id && !t.owner_age).slice(0, 24);
      for (let i = 0; i < no.length; i += 4) {
        await Promise.all(no.slice(i, i + 4).map(async (t) => { try { const r = await registry.rolesNO(t.registry_id); const lead = r.ceo || r.chair; if (lead) { t.owner_name = lead.name; t.owner_role = lead.role; t.owner_age = lead.age; } } catch { /* optional */ } }));
      }
      m.status = "scoring"; db.save();
      m.targets = m.targets.length ? await scoreTargets(m.criteria, m.targets, settings) : [];
      m.stats = summarize(m); m.status = "scored"; db.save();
    }, "buyside");
    res.json(m);
  }));

  // Write the pitch and park it as a buyer-side draft (goes through the same approve → send flow; demo mode redirects sends).
  app.post("/api/buyside/mandates/:id/pitch", wrap(async (req, res) => {
    const m = byId(req.params.id);
    if (!m.targets?.length) throw Object.assign(new Error("Source and score targets first."), { status: 409 });
    const s = db.load();
    const settings = s.settings;
    const p = await runTracked(null, () => writePitch(m, settings), "buyside_pitch");
    m.pitch = { ...p, written_at: db.now() };
    // Buyer record for this mandate (so notes, pairings and the network view know about it).
    let b = m.buyer_id ? s.buyers.find((x) => x.id === m.buyer_id) : s.buyers.find((x) => x.name.toLowerCase() === m.criteria.buyer_name.toLowerCase());
    if (!b) {
      b = { id: db.uid("b"), name: m.criteria.buyer_name, buyer_type: m.criteria.buyer_type, sectors: m.criteria.sectors, geographies: m.criteria.geographies,
        revenue_min_eur: m.criteria.revenue_min_eur, revenue_max_eur: m.criteria.revenue_max_eur, ebitda_min_eur: m.criteria.ebitda_min_eur, ebitda_max_eur: m.criteria.ebitda_max_eur,
        deal_types: m.criteria.deal_types, thesis: m.criteria.thesis_summary, active: true, source: "buy-side pitch", messages: [] };
      s.buyers.push(b);
    }
    m.buyer_id = b.id;
    const contact = ensureBuyerContacts(b)[0];
    const msg = { id: db.uid("bm"), buyer_id: b.id, company_id: null, mandate_id: m.id, side: "buyer", kind: "pitch", channel: "email", to: req.body?.to || contact.email, to_name: req.body?.to_name || contact.name,
      subject: p.subject, body: p.email_body, status: "draft", created_at: db.now(), sent_at: null };
    b.messages = b.messages || []; b.messages.unshift(msg);
    m.buyer_message_id = msg.id; m.status = "pitched";
    db.save();
    res.json({ mandate: m, message: msg, buyer: b });
  }));

  // Put the best targets into the sell-side pipeline (source tagged with the mandate) so the origination engine takes over.
  app.post("/api/buyside/mandates/:id/import", wrap(async (req, res) => {
    const m = byId(req.params.id);
    const top = Math.max(1, Math.min(40, Number(req.body?.top) || 10));
    const s = db.load();
    const known = new Set(s.companies.map((c) => c.registry_id).filter(Boolean));
    const created = [];
    for (const t of m.targets.slice(0, top)) {
      if (t.in_pipeline || (t.registry_id && known.has(t.registry_id))) continue;
      const c = db.normalizeCompany({ name: t.name, country: t.country, city: t.city, website: t.website, industry: t.industry, industry_code: t.industry_code, employees: t.employees, founded: t.founded,
        registry_id: t.registry_id, ownership_type: "unknown", owner: t.owner_name ? { name: t.owner_name, title: t.owner_role, age: t.owner_age, age_source: "Brønnøysund roles register" } : {},
        source: `Buy-side mandate: ${m.criteria.buyer_name}`, notes: `Sourced for ${m.criteria.buyer_name} (fit ${t.fit}): ${t.reason}` });
      s.companies.unshift(c); created.push(c);
      t.in_pipeline = true; t.company_id = c.id; t.stage = c.stage;
    }
    m.stats = summarize(m); db.save();
    res.json({ imported: created.length, companies: created, mandate: m });
  }));
  app.delete("/api/buyside/mandates/:id", (req, res) => { const list = mandates(); const i = list.findIndex((m) => m.id === req.params.id); if (i >= 0) list.splice(i, 1); db.save(); res.json({ ok: true }); });
}
