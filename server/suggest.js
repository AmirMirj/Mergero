// Outreach suggestions for BOTH sides + buy-side outreach drafts.
// Sell-side stays the focus, but every warm owner conversation is also a reason to talk to the buyers who fit it,
// and every buyer mandate is a reason to open owner conversations. This module proposes both, and drafts the buyer note.
// Self-contained on purpose (new file): registers its routes via register(app). Buyer contacts are mock until MGX is connected.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import * as db from "./db.js";
import * as mail from "./mail.js";
import { prefilterBuyers, track } from "./agents.js";
import { MESSAGING_PRINCIPLES, ICP } from "./playbook.js";

// ---------- buyer contacts (mock until the MGX buyer network is connected) ----------
const FIRST = ["Anna", "Mikko", "Sara", "Jonas", "Elin", "Lukas", "Maria", "Henrik", "Laura", "Tobias", "Nina", "Erik"];
const LAST = ["Virtanen", "Lindqvist", "Berg", "Hansen", "Keller", "Weber", "Nyman", "Schmid", "Larsen", "Koskinen", "Andersson", "Meier"];
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 28);
export function ensureBuyerContacts(b) {
  if (Array.isArray(b.contacts) && b.contacts.length) return b.contacts;
  const n = parseInt(String(b.id).replace(/\D/g, ""), 10) || 0;
  const role = b.buyer_type === "strategic" ? "Head of Corporate Development" : b.buyer_type === "family_office" ? "Investment Director" : "Investment Manager";
  b.contacts = [{ name: `${FIRST[n % FIRST.length]} ${LAST[(n * 7) % LAST.length]}`, role, email: `deals@${slug(b.name) || "buyer"}-demo.example`, mock: true }];
  return b.contacts;
}

// ---------- suggestion engine (deterministic, no LLM) ----------
const eurM = (n) => (n == null ? "undisclosed" : `€${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`);
const band = (n) => (n == null ? "revenue undisclosed" : n < 5e6 ? "€2–5M revenue" : n < 1e7 ? "€5–10M revenue" : n < 2.5e7 ? "€10–25M revenue" : n < 5e7 ? "€25–50M revenue" : "€50M+ revenue");
const WARM = new Set(["replied", "warming", "meeting_booked", "mandate_signed"]);
const UNCONTACTED = new Set(["new", "enriched", "outreach_ready"]);

export function suggestions() {
  const { companies, buyers } = db.load();
  // Sell-side: owners worth contacting next, ranked by readiness, then by buyer demand.
  const sellers = companies.filter((c) => UNCONTACTED.has(c.stage)).map((c) => {
    const readiness = c.score?.readiness ?? null;
    const demand = (c.matches || []).length;
    const draft = c.messages.find((m) => m.step === 1 && ["draft", "approved"].includes(m.status));
    const priority = (readiness ?? 35) + demand * 6 + (c.score?.recommended_timing === "now" ? 15 : 0) + (draft ? 5 : 0);
    const why = [
      readiness != null ? `readiness ${readiness}` : "not scored yet",
      demand ? `${demand} buyer${demand > 1 ? "s" : ""} fit` : null,
      c.score?.recommended_timing ? `timing: ${c.score.recommended_timing}` : null,
      c.owner?.age ? `owner ${c.owner.age}` : null,
    ].filter(Boolean).join(" · ");
    const next = draft ? (draft.status === "approved" ? "send_first_touch" : "approve_first_touch") : c.score ? "draft_outreach" : "run_pipeline";
    return { side: "seller", company_id: c.id, company_name: c.name, country: c.country, stage: c.stage, readiness, demand, priority, why, next };
  }).sort((a, b) => b.priority - a.priority).slice(0, 12);

  // Buy-side: buyers who should hear about a warm, anonymised opportunity they fit and have not been told about yet.
  const buyerSide = [];
  for (const b of buyers.filter((x) => x.active !== false)) {
    const told = new Set((b.messages || []).map((m) => m.company_id));
    for (const c of companies.filter((x) => WARM.has(x.stage))) {
      const m = (c.matches || []).find((x) => x.buyer_id === b.id);
      if (!m || told.has(c.id)) continue;
      buyerSide.push({
        side: "buyer", buyer_id: b.id, buyer_name: b.name, buyer_type: b.buyer_type, company_id: c.id, company_name: c.name,
        opportunity: `${c.industry || "company"} in ${c.country}, ${band(c.revenue_eur)}, ${c.ownership_type || "private"}`,
        stage: c.stage, fit: m.fit, reason: m.reason, priority: m.fit + (c.stage === "meeting_booked" ? 15 : c.stage === "mandate_signed" ? 25 : 0),
        next: "draft_buyer_note",
      });
    }
  }
  buyerSide.sort((a, b) => b.priority - a.priority);
  return { sellers, buyers: buyerSide.slice(0, 12), counts: { sellers: sellers.length, buyers: buyerSide.length } };
}

// ---------- buy-side note writer (anonymised, teaser rules) ----------
const BuyerNoteSchema = z.object({
  subject: z.string(),
  body: z.string().describe("60-110 words. Anonymised: sector, country, size band, ownership situation, why it fits their thesis, one question. No company name, city, product names, owner name or exact figures."),
});
const clients = new Map();
function client(settings) {
  const key = settings.api_key || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("No Anthropic API key configured. Add it in Settings (or set ANTHROPIC_API_KEY).");
  const workspace = settings.workspace_id || process.env.ANTHROPIC_WORKSPACE_ID || "";
  const k = `${key}|${workspace}`;
  if (!clients.has(k)) clients.set(k, new Anthropic({ apiKey: key, timeout: 5 * 60 * 1000, defaultHeaders: workspace ? { "anthropic-workspace-id": workspace } : undefined }));
  return clients.get(k);
}

export async function draftBuyerNote(buyer, company, settings) {
  const s = settings.sender;
  const contact = ensureBuyerContacts(buyer)[0];
  const m = (company.matches || []).find((x) => x.buyer_id === buyer.id);
  const res = await client(settings).messages.parse({
    model: settings.model || "claude-opus-5",
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(BuyerNoteSchema) },
    system: `You write a short, confidential note from ${s.name} (${s.title}, ${s.firm}) to ${contact.name} (${contact.role}) at a buyer in Mergero's off-market network, about a company whose owner is in a warm, confidential conversation with us. Strictly anonymised: no company name, city, product or brand names, owner name, website, or exact financial figures — use bands and sector language only. State why it fits this buyer's thesis, the owner's situation in one line (e.g. succession, growth partner sought), the stage (early conversation, first call held), and ask one question: would they like to see a blind teaser under NDA. Same house style as owner outreach: ${settings.style_rules}\n${MESSAGING_PRINCIPLES}`,
    messages: [{ role: "user", content: `Buyer: ${buyer.name} (${buyer.buyer_type}). Thesis: ${buyer.thesis}. Sectors: ${(buyer.sectors || []).join(", ")}. Deal types: ${(buyer.deal_types || []).join(", ")}.\n\nOpportunity (internal facts, anonymise them): ${company.name}, ${company.industry}, ${company.country}, revenue ${eurM(company.revenue_eur)}, EBITDA ${eurM(company.ebitda_eur)}, ${company.ownership_type}, owner ${company.owner?.age ? "aged " + company.owner.age : "age unknown"}, stage ${company.stage}. Fit ${m?.fit ?? "n/a"}: ${m?.reason || "n/a"}. Why now: ${company.score?.why_now || "n/a"}.\n\nSign as ${s.name}, ${s.title}, ${s.firm}.` }],
  });
  track(res.usage, settings.model || "claude-opus-5", "buyer_note");
  if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error("Buyer note could not be drafted; please retry.");
  return res.parsed_output;
}

// ---------- one-click pairing (seller ↔ buyer) with a justified rationale ----------
// Deterministic and instant: it combines the matcher's fit and reason, the buyer's thesis and deal types, the scoring
// agent's timing, and hard checks on size and geography. The LLM is only used later, when the buyer note is drafted.
const FRAMING_LABEL = { open: "open conversation", growth: "growth capital", minority: "partial / minority stake", exit: "full sale" };
function framingFor(buyer, company) {
  const dt = (buyer.deal_types || []).map((x) => String(x).toLowerCase());
  if (dt.includes("growth")) return "growth";
  if (dt.includes("minority")) return "minority";
  if ((company.score?.readiness ?? 0) >= 75 && dt.some((x) => ["majority", "buyout"].includes(x))) return "exit";
  return "open";
}
function within(v, lo, hi, tol = 0.3) { return v == null || ((lo == null || v >= lo * (1 - tol)) && (hi == null || v <= hi * (1 + tol))); }
function pairingRationale(c, b) {
  const m = (c.matches || []).find((x) => x.buyer_id === b.id);
  const revOk = within(c.revenue_eur, b.revenue_min_eur, b.revenue_max_eur);
  const ebitdaOk = within(c.ebitda_eur, b.ebitda_min_eur, b.ebitda_max_eur);
  const geoOk = (b.geographies || []).some((g) => g.toUpperCase() === c.country || g.toUpperCase() === "EU");
  const o = c.owner || {};
  const fit = m?.fit ?? Math.max(35, 50 + (revOk ? 10 : -10) + (geoOk ? 10 : -15));
  const checks = [
    { label: "Sector / thesis", ok: Boolean(m) || (b.sectors || []).some((s) => String(c.industry || "").toLowerCase().includes(s.toLowerCase())), note: m?.reason || `Mandate covers ${(b.sectors || []).slice(0, 3).join(", ")}; company is ${c.industry || "unclassified"}.` },
    { label: "Size", ok: revOk && ebitdaOk, note: `Revenue ${eurM(c.revenue_eur)} vs mandate ${eurM(b.revenue_min_eur)}–${eurM(b.revenue_max_eur)}; EBITDA ${eurM(c.ebitda_eur)} vs ${eurM(b.ebitda_min_eur)}–${eurM(b.ebitda_max_eur)}.` },
    { label: "Geography", ok: geoOk, note: `${c.country} ${geoOk ? "is" : "is not"} in the mandate (${(b.geographies || []).join(", ")}).` },
    { label: "Timing", ok: ["now", "3-6 months"].includes(c.score?.recommended_timing), note: c.score ? `${c.score.recommended_timing}: ${c.score.why_now}` : "Not scored yet — run the pipeline for a timing view." },
    { label: "Owner situation", ok: (o.age ?? 0) >= 55 || /founder|family/.test(c.ownership_type || ""), note: [c.ownership_type, o.age ? `owner ${o.age}` : null, o.tenure_years ? `${o.tenure_years} years at the helm` : null].filter(Boolean).join(", ") || "unknown" },
    { label: "Deal structure", ok: true, note: `Buyer does ${(b.deal_types || []).join("/") || "unspecified"}; suggested first framing with the owner: ${FRAMING_LABEL[framingFor(b, c)]}.` },
  ];
  const passed = checks.filter((x) => x.ok).length;
  const summary = `${b.name} fits ${c.name} on ${passed} of ${checks.length} checks (fit ${fit}). ${m?.reason || ""} ${c.score?.why_now ? "Why now: " + c.score.why_now : ""}`.trim();
  return { fit, checks, passed, total: checks.length, summary, framing: framingFor(b, c), thesis: b.thesis };
}
function bestBuyerFor(c, buyers) {
  const active = buyers.filter((b) => b.active !== false);
  const byId = Object.fromEntries(active.map((b) => [b.id, b]));
  const matched = (c.matches || []).filter((m) => byId[m.buyer_id]).sort((a, b) => b.fit - a.fit);
  if (matched.length) return byId[matched[0].buyer_id];
  return prefilterBuyers(c, active)[0] || null;
}
function bestSellerFor(b, companies) {
  const cands = companies.filter((c) => !["disqualified"].includes(c.stage) && (c.matches || []).some((m) => m.buyer_id === b.id))
    .map((c) => ({ c, fit: c.matches.find((m) => m.buyer_id === b.id).fit + (WARM.has(c.stage) ? 15 : 0) + ((c.score?.readiness ?? 0) >= 70 ? 10 : 0) }))
    .sort((a, z) => z.fit - a.fit);
  if (cands.length) return cands[0].c;
  return companies.filter((c) => c.stage !== "disqualified" && prefilterBuyers(c, [b]).length).sort((a, z) => (z.score?.readiness ?? 0) - (a.score?.readiness ?? 0))[0] || null;
}
function pairings() { const s = db.load(); s.pairings = s.pairings || []; return s.pairings; }
export function createPairing({ company_id, buyer_id }) {
  const s = db.load();
  let c = company_id ? db.findCompany(company_id) : null;
  let b = buyer_id ? s.buyers.find((x) => x.id === buyer_id) : null;
  if (!c && !b) throw Object.assign(new Error("company_id or buyer_id is required"), { status: 400 });
  if (!b) b = bestBuyerFor(c, s.buyers);
  if (!c) c = bestSellerFor(b, s.companies);
  if (!c || !b) throw Object.assign(new Error("No suitable counterpart found yet — run the pipeline (matching) first."), { status: 404 });
  const existing = pairings().find((p) => p.company_id === c.id && p.buyer_id === b.id && p.status !== "dismissed");
  if (existing) return existing;
  const r = pairingRationale(c, b);
  const p = { id: db.uid("p"), company_id: c.id, company_name: c.name, country: c.country, stage: c.stage, buyer_id: b.id, buyer_name: b.name, buyer_type: b.buyer_type,
    fit: r.fit, framing: r.framing, rationale: r, status: "proposed", created_at: db.now(), buyer_message_id: null,
    next_steps: [WARM.has(c.stage) ? "Send the anonymised note to the buyer (one click on Accept)" : `Open the owner conversation first (${FRAMING_LABEL[r.framing]} framing); the buyer is told once the owner replies`] };
  pairings().unshift(p);
  db.save();
  return p;
}
export function listPairings() {
  const s = db.load();
  return pairings().map((p) => { const c = db.findCompany(p.company_id); return { ...p, stage: c?.stage || p.stage, company_name: c?.name || p.company_name }; });
}

// ---------- routes ----------
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(`[${req.method} ${req.path}]`, err?.message || err); res.status(err.status || 500).json({ error: err?.message || String(err) }); });
const notFound = (w) => Object.assign(new Error(`${w} not found`), { status: 404 });
const buyerById = (id) => db.load().buyers.find((b) => b.id === id) || (() => { throw notFound("Buyer"); })();

export function register(app) {
  app.get("/api/suggestions", (req, res) => res.json(suggestions()));

  // Buyer contacts (mock) and buyer-side messages live on the buyer object.
  app.get("/api/buyers/:id/contacts", wrap(async (req, res) => { const b = buyerById(req.params.id); ensureBuyerContacts(b); db.save(); res.json(b.contacts); }));

  app.post("/api/buyers/:id/notes", wrap(async (req, res) => {
    const b = buyerById(req.params.id);
    const c = db.findCompany(req.body?.company_id) || (() => { throw notFound("Company"); })();
    const settings = db.load().settings;
    const note = await draftBuyerNote(b, c, settings);
    const contact = ensureBuyerContacts(b)[0];
    const msg = { id: db.uid("bm"), buyer_id: b.id, company_id: c.id, side: "buyer", channel: "email", to: contact.email, to_name: contact.name,
      subject: note.subject, body: note.body, status: "draft", created_at: db.now(), sent_at: null };
    b.messages = b.messages || [];
    b.messages.unshift(msg);
    db.save();
    res.json({ message: msg, buyer: b });
  }));

  const buyerMessage = (id) => {
    for (const b of db.load().buyers) { const m = (b.messages || []).find((x) => x.id === id); if (m) return { buyer: b, message: m }; }
    throw notFound("Buyer message");
  };
  app.put("/api/buyer-messages/:id", wrap(async (req, res) => { const { message: m } = buyerMessage(req.params.id); if ("subject" in req.body) m.subject = req.body.subject; if ("body" in req.body) m.body = req.body.body; db.save(); res.json(m); }));
  app.post("/api/buyer-messages/:id/approve", wrap(async (req, res) => { const { message: m } = buyerMessage(req.params.id); m.status = "approved"; db.save(); res.json(m); }));
  app.post("/api/buyer-messages/:id/reject", wrap(async (req, res) => { const { message: m } = buyerMessage(req.params.id); m.status = "rejected"; db.save(); res.json(m); }));
  app.post("/api/buyer-messages/:id/send", wrap(async (req, res) => {
    const { buyer: b, message: m } = buyerMessage(req.params.id);
    if (!["approved", "draft"].includes(m.status)) throw Object.assign(new Error(`Message is ${m.status}`), { status: 409 });
    const c = db.findCompany(m.company_id);
    // Buyer notes go out as the advisor who owns the seller conversation (or the first advisor for a pitch) and count
    // against that advisor's daily cap, same as owner emails.
    const adv = typeof db.advisorFor === "function" ? db.advisorFor(c || { country: (b.geographies || [])[0] }) : null;
    const settings = typeof db.settingsFor === "function" && c ? db.settingsFor(c) : db.load().settings;
    if (adv && typeof db.sentToday === "function") {
      const cap = db.capOf(adv), used = db.sentToday(adv.id);
      if (used >= cap) throw Object.assign(new Error(`${adv.name} has already sent ${used} of ${cap} emails today (the daily limit that protects deliverability). Send this buyer note on the next working morning or raise the cap in Settings.`), { status: 429, capped: true, next_at: new Date(db.nextSendWindow()).toISOString() });
    }
    let delivery = "mailto";
    // Mock contact addresses are never emailed for real; in demo mode every send is redirected anyway, so they can go.
    const demoMode = Boolean(String(settings.demo_email || process.env.DEMO_EMAIL || "").trim());
    if (mail.configured(settings) && (demoMode || !/-demo\.example$/.test(m.to))) {
      const from = mail.parseAddress(mail.config(settings).from);
      const asAdvisor = adv?.name && from.email ? { ...settings, mail: { ...settings.mail, from: `${adv.name} <${from.email}>` } } : settings;
      const r = await mail.send(asAdvisor, { to: m.to, subject: m.subject, text: m.body, reply_to: adv?.email || settings.sender?.email || undefined });
      m.provider_id = r?.id || r?.provider_id || null; delivery = "email";
    }
    m.status = "sent"; m.sent_at = db.now(); m.delivery = delivery; m.sent_by = adv?.id || null;
    if (c) { c.conversation.push({ id: db.uid("e"), direction: "outbound", channel: "buyer_note", text: `Anonymised note sent to buyer ${b.name} (${m.to_name}).\nSubject: ${m.subject}`, at: m.sent_at, triage: null }); db.touch(c); }
    db.save();
    res.json({ message: m, mailto: delivery === "mailto" ? `mailto:${encodeURIComponent(m.to)}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}` : null });
  }));

  // Pairings: one click pairs a seller with its best buyer (or a buyer with its best seller) and explains why.
  app.get("/api/pairings", (req, res) => res.json(listPairings()));
  app.post("/api/pairings", wrap(async (req, res) => res.json(createPairing({ company_id: req.body?.company_id, buyer_id: req.body?.buyer_id }))));
  const pairingById = (id) => pairings().find((p) => p.id === id) || (() => { throw notFound("Pairing"); })();
  app.post("/api/pairings/:id/accept", wrap(async (req, res) => {
    const p = pairingById(req.params.id);
    const c = db.findCompany(p.company_id) || (() => { throw notFound("Company"); })();
    const b = buyerById(p.buyer_id);
    p.status = "active"; p.accepted_at = db.now();
    // Warm owner conversation → draft the anonymised buyer note right away; otherwise the owner comes first.
    if (WARM.has(c.stage) && !p.buyer_message_id) {
      const note = await draftBuyerNote(b, c, db.load().settings);
      const contact = ensureBuyerContacts(b)[0];
      const msg = { id: db.uid("bm"), buyer_id: b.id, company_id: c.id, side: "buyer", channel: "email", to: contact.email, to_name: contact.name,
        subject: note.subject, body: note.body, status: "draft", created_at: db.now(), sent_at: null, pairing_id: p.id };
      b.messages = b.messages || []; b.messages.unshift(msg); p.buyer_message_id = msg.id;
    }
    c.notes = [c.notes, `Paired with ${b.name} (fit ${p.fit}, ${FRAMING_LABEL[p.framing]} framing) on ${p.accepted_at.slice(0, 10)}`].filter(Boolean).join("\n");
    db.touch(c); db.save();
    res.json({ pairing: p, buyer_message_id: p.buyer_message_id });
  }));
  app.post("/api/pairings/:id/dismiss", wrap(async (req, res) => { const p = pairingById(req.params.id); p.status = "dismissed"; p.dismissed_at = db.now(); db.save(); res.json(p); }));
}
