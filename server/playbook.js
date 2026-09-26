// Mergero origination playbook — distilled from the Q&A with Mergero (Timo Tontti / team) at the hackathon.
// Single source of truth for the agents' ideal-customer profile, messaging principles and pipeline semantics.
// Wire into agents.js prompts (scoring, outreach, triage, intake) — kept separate so the playbook can be tuned without touching agent code.

export const ICP = {
  side: "sell-side",
  revenue_eur: { min: 2_000_000, sweet_spot_max: 50_000_000, max: 100_000_000 },
  valuation_floor_eur: { low: 3_000_000, high: 5_000_000 },
  ownership: ["founder-owned", "family-owned", "management-owned"],
  owner_profile: "majority owner, typically 55+ or facing a succession question; often has NOT yet considered selling",
  decision_maker: "the majority owner (not CFO, board or family members)",
  industries: "agnostic — deals come from anywhere (bicycles, mechanics, sports equipment, industrial, software); demo on 1–2 sectors with high buyer appetite",
  markets: { nordics: { channel: "email" }, dach: { channel: "linkedin + calls" } },
  soft_entry: "growth capital or a minority stake is an explicit, softer entry point before a full exit",
};

// The mandate moment, as Mergero describes it: first call with an advisor → 2–4 meetings → engagement letter.
export const MANDATE_PATH = [
  { stage: "contacted", label: "First touch sent", meaning: "personal first-touch email/LinkedIn/call, demand-led, no 'sell your company'" },
  { stage: "replied", label: "Owner replied", meaning: "any reply; triage decides intent" },
  { stage: "warming", label: "Warm-up conversation", meaning: "owner is curious; exchanging information; intake link shared" },
  { stage: "meeting_booked", label: "First call booked", meaning: "owner takes a first call with a Mergero advisor" },
  { stage: "mandate_signed", label: "Engagement letter signed", meaning: "after 2–4 meetings the owner signs the engagement letter (= the mandate)" },
];
export const MEETINGS_BEFORE_MANDATE = { min: 2, max: 4 };

// What the tool replaces: manual prospect research and first-touch outreach. Used for the "hours saved" impact metric.
export const TIME_SAVED_MINUTES = { enrichment: 45, scoring: 15, buyer_matching: 20, outreach_sequence: 40, reply_triage: 10, intake_summary: 30 };

// Messaging principles that all writer/triage agents must follow.
export const MESSAGING_PRINCIPLES = `
- Assume the owner has NOT considered selling. Never write "sell your company", "exit", "M&A process" or "valuation" in a first touch.
- Lead with demand, not with Mergero: a concrete statement that specific buyers in our network are looking for exactly this kind of company, and one specific observation about theirs.
- Offer the softer door first: growth capital, a partial or minority stake, or simply "understanding your plans for the next few years" — a full sale is one option among several.
- Write to the majority owner as a peer who has built and sold a company himself (our founder sold his own company in 2019). One idea per message.
- The ask is small: a 20-minute confidential conversation, no commitment, no documents.
- Nordics: email, direct and short. DACH: LinkedIn note first, then a call; slightly more formal, use the formal address in German.
- Never mention that messages are generated, sequenced or automated. No placeholders. No exclamation marks, no em dashes, no bullet lists, no stock openers.
`.trim();

// Signals that mark an owner who is open before they know it (used by the scoring agent).
export const READINESS_SIGNALS = {
  positive: [
    "owner aged 55+ or 25+ years at the helm",
    "no visible successor / second-generation involvement",
    "flat or declining revenue after years of growth",
    "founder still CEO with no external management layer",
    "recent inbound interest from buyers in the sector (consolidation wave)",
    "sector where Mergero buyers have explicit appetite",
    "owner has publicly discussed future, retirement, or 'next chapter'",
  ],
  negative: [
    "PE-backed within the last 3 years (holding period)",
    "very recent large capex or expansion financing",
    "founder under 45 in growth mode",
    "revenue below €2M or valuation clearly below the €3–5M floor",
  ],
};

// Value proposition from the customer's point of view (owner) and the buyer's — for intake page copy and pitch.
export const VALUE_PROP = {
  owner: "You learn what your company is worth to the buyers who actually want it, confidentially, without running a public process, at your own pace, and with options short of a full sale.",
  buyer: "Access to companies that are not for sale and not in any process, with an advisor who opens and facilitates the conversation.",
  mergero: "Demand-led origination at scale: every buyer mandate becomes hundreds of personal owner conversations, without adding headcount.",
};

// ICP + mandate path only (for analytical agents such as scoring).
export function icpForPrompt() {
  return `Ideal sell-side profile: revenue €${ICP.revenue_eur.min / 1e6}–${ICP.revenue_eur.sweet_spot_max / 1e6}M (up to €${ICP.revenue_eur.max / 1e6}M), valuation floor €${ICP.valuation_floor_eur.low / 1e6}–${ICP.valuation_floor_eur.high / 1e6}M, ${ICP.ownership.join("/")}; decision-maker is ${ICP.decision_maker}; owner profile: ${ICP.owner_profile}. Industries: ${ICP.industries}. Soft entry: ${ICP.soft_entry}.
Mandate path: ${MANDATE_PATH.map((s) => s.label).join(" → ")} (${MEETINGS_BEFORE_MANDATE.min}–${MEETINGS_BEFORE_MANDATE.max} meetings before the engagement letter).`;
}

// ICP + mandate path + messaging principles (for writing agents).
export function playbookForPrompt() {
  return `${icpForPrompt()}\nMessaging principles:\n${MESSAGING_PRINCIPLES}`;
}
