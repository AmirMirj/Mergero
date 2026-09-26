// Zod schemas = the contract between the agents and the UI (structured outputs).
import { z } from "zod/v4"; // the SDK's zodOutputFormat helper requires the v4 API

// Evidence = ids of research facts ("f12") backing a statement; empty when the statement is not from research.
const Evidence = z.array(z.string()).describe("Ids of the research facts that support this (e.g. f3, f12); empty if none");

export const EnrichmentSchema = z.object({
  summary: z.string().describe("What the company does, 2-3 sentences, specific"),
  products: z.array(z.string()),
  customers: z.array(z.string()).describe("Named customers or precise customer segments"),
  positioning: z.string(),
  recent_news: z.array(z.string()),
  leadership: z.string(),
  signals: z.array(z.string()).describe("Observations relevant to sale-readiness: owner age/tenure, succession, growth, PE interest, sector consolidation"),
  data_gaps: z.array(z.string()).describe("What Mergero would still need: revenue split by product, top-10 client concentration, normalized EBITDA, etc."),
  sources: z.array(z.string()).describe("URLs actually consulted"),
  confidence: z.enum(["high", "medium", "low"]),
  offering: z.object({
    summary: z.string().describe("What they sell and how they make money, 1-2 sentences"),
    product_lines: z.array(z.object({ name: z.string(), description: z.string(), evidence: Evidence })),
    business_model: z.string().describe("e.g. project deliveries, product sales, recurring service contracts, mix with rough weights if known"),
    evidence: Evidence,
  }),
  customer_segments: z.array(z.object({
    segment: z.string(),
    named_customers: z.array(z.string()).describe("Only customers named in the research facts"),
    evidence: Evidence,
  })),
  footprint: z.object({
    headquarters: z.string(),
    sites: z.array(z.string()).describe("Offices, plants, subsidiaries with city/country"),
    sales_markets: z.array(z.string()).describe("Countries/regions they sell into (ISO country codes where possible)"),
    evidence: Evidence,
  }),
  direction: z.object({
    vision: z.string().describe("Stated vision/mission in their words, empty if not stated"),
    stated_goals: z.array(z.string()),
    recent_moves: z.array(z.object({ date: z.string().describe("YYYY or YYYY-MM"), event: z.string(), evidence: Evidence })).describe("Acquisitions, expansions, launches, leadership/ownership changes, big contracts; newest first"),
    evidence: Evidence,
  }),
  financial_view: z.string().describe("2-3 sentences on size, trend and profitability based ONLY on the filed/published figures provided; say plainly what is not public"),
});

// Research: facts extracted from the company's own pages (each must quote the page verbatim).
const FactCategory = z.enum(["offering", "customers", "footprint", "direction", "financials", "ownership", "people", "events", "other"]);
export const PageFactsSchema = z.object({
  facts: z.array(z.object({
    page: z.number().int().describe("Index of the page the fact comes from, exactly as numbered in the input"),
    category: FactCategory,
    claim: z.string().describe("One self-contained factual statement in English"),
    quote: z.string().describe("Verbatim excerpt copied from that page's text (original language), 5-40 words, that supports the claim"),
    as_of: z.string().describe("Year or YYYY-MM the fact refers to if stated or dated on the page, else empty string"),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});

// Research: facts from third-party sources found via web search (must cite a URL the tools returned).
export const WebFactsSchema = z.object({
  facts: z.array(z.object({
    url: z.string().describe("Source URL exactly as listed in the research notes"),
    source_title: z.string(),
    category: FactCategory,
    claim: z.string().describe("One self-contained factual statement in English"),
    quote: z.string().describe("The supporting excerpt as given in the research notes (cited text); empty if none"),
    as_of: z.string().describe("YYYY or YYYY-MM if known, else empty string"),
    confidence: z.enum(["high", "medium", "low"]),
  })),
  financial_mentions: z.array(z.object({
    url: z.string(),
    year: z.number().int(),
    metric: z.enum(["revenue", "ebit", "ebitda", "net_income", "employees"])
      .describe("revenue = turnover/operating income; ebit = operating profit (driftsresultat, liikevoitto, rörelseresultat, Betriebsergebnis); net_income = profit AFTER tax only; skip pre-tax profit and gross profit"),
    value: z.number().describe("Absolute amount in the stated currency (convert thousands/millions to units); head count for employees"),
    currency: z.string().describe("ISO code, e.g. EUR, SEK, NOK, DKK; empty for employees"),
    quote: z.string(),
  })).describe("Figures published in press, directories or registries; only when the source states them"),
});

// Research: financial statements read from an annual-report PDF.
export const ReportFinancialsSchema = z.object({
  is_this_company: z.boolean().describe("True if the report belongs to the named company or its group"),
  entity_name: z.string(),
  currency: z.string().describe("ISO currency code of the statements"),
  years: z.array(z.object({
    year: z.number().int().describe("Financial year (calendar year of the period end)"),
    revenue: z.number().nullable().describe("Absolute amount in currency units (multiply out 'in thousands' etc.)"),
    ebit: z.number().nullable().describe("Operating profit (EBIT)"),
    depreciation: z.number().nullable().describe("Depreciation, amortisation and impairment (positive number)"),
    ebitda: z.number().nullable().describe("Only if the report states EBITDA explicitly"),
    net_income: z.number().nullable(),
    employees: z.number().nullable(),
    page: z.number().int().nullable().describe("PDF page where the income statement is"),
  })),
});

// Buyer-side: anonymised teaser, only after a mandate is signed.
export const TeaserSchema = z.object({
  project_name: z.string().describe("Neutral code name, e.g. 'Project Nordlys'"),
  headline: z.string().describe("One line: sector, region at country/region level, size band"),
  blind_profile: z.string().describe("120-180 words; no company name, no brand/product names, no named customers, no city, no people"),
  key_figures: z.array(z.string()).describe("Ranges only, e.g. 'Revenue €8-10M (FY2025)'"),
  investment_highlights: z.array(z.string()),
  transaction: z.string().describe("What the owner is open to (majority/minority/full exit), timing"),
  redactions: z.array(z.string()).describe("Identifying details deliberately left out, for the advisor's check"),
});

export const ScoreSchema = z.object({
  readiness: z.number().int().min(0).max(100).describe("Likelihood the owner is open to a transaction within 6-18 months"),
  attractiveness: z.number().int().min(0).max(100).describe("How attractive to the buyers in Mergero's network"),
  valuation_band_eur: z.object({ low: z.number(), high: z.number() }),
  meets_minimum: z.boolean().describe("Valuation high end >= EUR 3-5M floor"),
  why_now: z.string().describe("3-5 short sentences, each one point an advisor can scan. Separate with newlines. No long paragraph."),
  signals: z.array(z.object({
    signal: z.string(),
    direction: z.enum(["positive", "negative", "neutral"]),
    weight: z.enum(["high", "medium", "low"]),
    note: z.string(),
  })),
  risks: z.array(z.string()),
  recommended_timing: z.enum(["now", "3-6 months", "6-12 months", "not yet"]),
});

export const MatchRerankSchema = z.object({
  matches: z.array(z.object({
    buyer_id: z.string(),
    fit: z.number().int().min(0).max(100),
    reason: z.string().describe("One sentence, specific to this company and this buyer's thesis"),
  })),
});

export const OutreachSchema = z.object({
  messages: z.array(z.object({
    step: z.number().int().min(1).max(5),
    send_after_days: z.number().int().min(0),
    channel: z.enum(["email", "linkedin", "call_script"]),
    subject: z.string().describe("Email subject; empty string for linkedin/call_script"),
    body: z.string(),
  })).min(1).describe("One message per step of the requested sequence, in order (step 1 first)"),
});

export const HumanizerSchema = z.object({
  ai_tell_score_before: z.number().int().min(0).max(100).describe("0 = reads fully human, 100 = obviously machine written"),
  ai_tell_score_after: z.number().int().min(0).max(100),
  flags: z.array(z.string()).describe("Each: the offending phrase in quotes plus why it reads as AI/templated"),
  changes: z.array(z.string()).describe("What was changed and why, briefly"),
  subject: z.string(),
  body: z.string().describe("The rewritten message"),
});

export const TriageSchema = z.object({
  intent: z.enum(["interested", "curious", "not_now", "info_request", "not_interested", "referral", "other"]),
  sentiment: z.enum(["warm", "neutral", "cold"]),
  extracted_facts: z.array(z.object({
    field: z.string().describe("snake_case, e.g. revenue_split, top_clients_concentration, succession_intent, timing, decision_makers, valuation_expectation"),
    value: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
  recommended_stage: z.enum(["contacted", "replied", "warming", "meeting_booked", "disqualified"]),
  next_step: z.string(),
  open_questions: z.array(z.string()).describe("Direct questions the owner asked and is waiting on; the reply must answer each. Empty if none"),
  reply_subject: z.string(),
  reply_body: z.string().describe("The reply the advisor should send, in the same language as the inbound message"),
});

// Reply understanding: what the owner's own words say about readiness and timing, with verbatim evidence.
export const ReplyScoreSchema = z.object({
  readiness: z.number().int().min(0).max(100).describe("Updated readiness after reading the reply (0-100), same meaning as in the score"),
  attractiveness: z.number().int().min(0).max(100).describe("Updated attractiveness to buyers; change only if the reply reveals business facts (size, margins, client concentration)"),
  recommended_timing: z.enum(["now", "3-6 months", "6-12 months", "not yet"]),
  reason: z.string().describe("One or two sentences an advisor could say out loud: why the score moved (or did not)"),
  evidence: z.array(z.object({
    quote: z.string().describe("Verbatim words from the owner's reply, 3-25 words, copied exactly"),
    reading: z.string().describe("What this tells us, e.g. 'succession is on his mind', 'timing is 2+ years out'"),
    effect: z.enum(["raises", "lowers", "neutral"]),
    weight: z.enum(["high", "medium", "low"]),
  })).describe("The phrases that drove the change; empty if the reply says nothing about readiness"),
  signals: z.array(z.object({
    signal: z.string(),
    direction: z.enum(["positive", "negative", "neutral"]),
    weight: z.enum(["high", "medium", "low"]),
    note: z.string(),
  })).describe("New readiness signals learned from the reply, in the same form as the score's signals"),
  risks: z.array(z.string()).describe("New risks or objections raised in the reply"),
  confidence: z.enum(["high", "medium", "low"]),
});

export const IntakeTurnSchema = z.object({
  reply: z.string().describe("Next message to the owner. Warm, brief, one question at a time."),
  status: z.enum(["in_progress", "complete"]),
  summary: z.object({
    revenue_split: z.string(),
    top_clients_concentration: z.string(),
    ebitda_normalized: z.string(),
    timing: z.string(),
    motivation: z.string(),
    deal_breakers: z.string(),
    open_questions: z.array(z.string()),
  }).nullable().describe("Fill only when status is complete; otherwise null"),
});
