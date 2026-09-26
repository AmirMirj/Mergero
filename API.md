# Mergero Origination Engine — API contract (v1)

Sell-side deal origination copilot. Node/Express backend on `http://localhost:3000`, static frontend in `public/`.
All endpoints return JSON. Errors: `{ error: string }` with 4xx/5xx.

## Core objects

### Company (prospect)
```json
{
  "id": "c_ab12cd",
  "name": "Nordic Pump Oy",
  "country": "FI",                 // FI SE NO DK DE AT CH
  "city": "Tampere",
  "website": "https://nordicpump.fi",
  "industry": "Industrial equipment",
  "revenue_eur": 8400000,
  "ebitda_eur": 1100000,
  "employees": 46,
  "founded": 1998,
  "ownership_type": "founder-owned",   // founder-owned | family-owned | pe-backed | management-owned | unknown
  "owner": { "name": "Jari Lehtinen", "title": "CEO & Owner", "age": 61, "tenure_years": 26,
             "email": "jari@nordicpump.fi", "linkedin": "https://linkedin.com/in/..." },
  "source": "Prospect database import",
  "stage": "new",   // new | enriched | outreach_ready | contacted | replied | warming | meeting_booked | mandate_signed | disqualified
  "channel": "email",               // derived: FI/SE/NO/DK -> email ; DE/AT/CH -> linkedin
  "enrichment": null | {
    "summary": "…what the company does in 2-3 sentences…",
    "products": ["…"],
    "customers": ["…named or described customers…"],
    "positioning": "…",
    "recent_news": ["…"],
    "leadership": "…",
    "signals": ["Owner 61, founder since 1998", "No successor named", "Flat revenue 2023-2025"],
    "data_gaps": ["Revenue split by product unknown", "Top-10 client concentration unknown"],
    "sources": ["https://…"],
    "confidence": "high|medium|low",
    "enriched_at": "ISO"
  },
  "score": null | {
    "readiness": 78,                     // 0-100 likelihood owner is open to a transaction in 6-18 months
    "attractiveness": 71,                // 0-100 how attractive to buyers in network
    "valuation_band_eur": { "low": 6000000, "high": 9000000 },
    "meets_minimum": true,               // valuation >= 3-5M EUR floor
    "why_now": "…one paragraph…",
    "signals": [ { "signal": "Owner age 61", "direction": "positive", "weight": "high", "note": "…" } ],
    "risks": ["…"],
    "recommended_timing": "now | 3-6 months | 6-12 months | not yet",
    "scored_at": "ISO"
  },
  "matches": [ { "buyer_id": "b_01", "buyer_name": "Nordic industrial PE fund", "fit": 86, "reason": "…" } ],
  "messages": [ /* Message */ ],
  "conversation": [ /* ConversationEntry */ ],
  "intake": null | { "token": "…", "status": "pending|in_progress|complete", "summary": {…}, "transcript": [ {role, text, at} ] },
  "notes": "",
  "created_at": "ISO", "updated_at": "ISO"
}
```

### Message (outreach draft)
```json
{
  "id": "m_xyz", "company_id": "c_ab12cd",
  "channel": "email" | "linkedin" | "call_script",
  "step": 1,                    // 1,2,3 for sequence; 0 = reply draft
  "send_after_days": 0,         // 0, 6, 14 typical
  "language": "en",             // en | fi | sv | de …
  "subject": "…",               // email only
  "body": "…",
  "status": "draft" | "approved" | "sent" | "rejected",
  "humanizer": { "ai_tell_score_before": 62, "ai_tell_score_after": 9, "flags": ["…phrase…: reason"], "changes": ["…"] },
  "created_at": "ISO", "sent_at": null
}
```

### ConversationEntry
```json
{ "id": "e_1", "direction": "inbound" | "outbound", "channel": "email", "text": "…", "at": "ISO",
  "triage": null | {
    "intent": "interested" | "curious" | "not_now" | "info_request" | "not_interested" | "referral" | "other",
    "sentiment": "warm" | "neutral" | "cold",
    "extracted_facts": [ { "field": "revenue_split", "value": "…", "confidence": "high" } ],
    "recommended_stage": "warming",
    "next_step": "…",
    "reply_message_id": "m_reply1"     // draft reply created in messages
  } }
```

### Buyer mandate
```json
{ "id": "b_01", "name": "Nordic industrial PE fund", "buyer_type": "PE" | "family_office" | "strategic",
  "sectors": ["Industrial equipment", "Manufacturing"], "geographies": ["FI","SE","NO","DK"],
  "revenue_min_eur": 5000000, "revenue_max_eur": 50000000, "ebitda_min_eur": 800000, "ebitda_max_eur": 8000000,
  "deal_types": ["majority", "buyout"], "thesis": "…", "active": true }
```

### Settings
```json
{ "api_key_set": true, "api_key_masked": "sk-ant-…7f2a", "model": "claude-opus-5",
  "sender": { "name": "Timo Tontti", "title": "Managing Partner", "firm": "Mergero", "email": "timo.tontti@mergero.com", "phone": "+358 400 274491" },
  "style_rules": "Short. Plain words. One concrete reason we are writing. No em dashes, no 'I hope this finds you well', no bullet lists, no 'delve', no exclamation marks. Sound like a person who has done 50 deals, not a marketing team.",
  "value_props": ["2,000+ verified buyers", "€500M+ closed", "off-market process, no auction"],
  "funnel_assumptions": { "contact_to_reply": 0.18, "reply_to_meeting": 0.45, "meeting_to_mandate": 0.30 } }
```

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/state` | | `{ settings, stats, companies:[Company summary], buyers:[Buyer] }` |
| GET | `/api/stats` | | `{ by_stage:{stage:count}, total, avg_readiness, projected_mandates, messages_pending_approval, replies_unhandled }` |
| GET | `/api/companies` | | `[Company]` |
| GET | `/api/companies/:id` | | `Company` |
| POST | `/api/companies` | partial Company (name, country, website, …) | `Company` |
| PUT | `/api/companies/:id` | partial fields (notes, owner, stage…) | `Company` |
| DELETE | `/api/companies/:id` | | `{ ok:true }` |
| POST | `/api/companies/import` | `{ csv: "text" }` — columns: name,country,city,website,industry,revenue_eur,ebitda_eur,employees,founded,ownership_type,owner_name,owner_title,owner_age,owner_email,owner_linkedin | `{ imported: n, companies:[Company] }` |
| POST | `/api/companies/:id/enrich` | | `Company` (enrichment filled, stage>=enriched) |
| POST | `/api/companies/:id/score` | | `Company` |
| POST | `/api/companies/:id/match` | | `Company` |
| POST | `/api/companies/:id/outreach` | `{ language?: "en", channel?: "email" }` | `Company` (3 messages appended, stage outreach_ready) |
| POST | `/api/companies/:id/run` | `{ language? }` | `Company` — enrich → score → match → outreach in one go |
| POST | `/api/pipeline/run` | `{ ids?: [id], stage?: "new", language? }` | `{ job_id }` |
| GET | `/api/jobs/:id` | | `{ id, total, done, current_company, errors:[{id,name,error}], finished:bool, started_at }` |
| POST | `/api/companies/:id/stage` | `{ stage }` | `Company` |
| PUT | `/api/messages/:id` | `{ subject?, body? }` | `Message` |
| POST | `/api/messages/:id/approve` | | `Message` |
| POST | `/api/messages/:id/reject` | | `Message` |
| POST | `/api/messages/:id/send` | | `{ message, mailto }` — marks sent, appends outbound ConversationEntry, stage→contacted, `mailto:` link for email channel |
| POST | `/api/messages/:id/humanize` | | `Message` — re-run humanizer pass |
| POST | `/api/companies/:id/replies` | `{ text, channel? }` | `Company` — stores inbound, runs triage, creates reply draft, updates stage |
| GET | `/api/buyers` | | `[Buyer]` |
| POST | `/api/buyers` | Buyer without id | `Buyer` |
| PUT | `/api/buyers/:id` | partial | `Buyer` |
| DELETE | `/api/buyers/:id` | | `{ ok:true }` |
| GET | `/api/settings` | | `Settings` |
| PUT | `/api/settings` | `{ api_key?, model?, sender?, style_rules?, value_props?, funnel_assumptions? }` | `Settings` |
| POST | `/api/companies/:id/intake-link` | | `{ url: "http://localhost:3000/intake/<token>", token }` |
| GET | `/api/intake/:token` | | `{ company_name, firm, advisor_name, status, transcript:[{role:'assistant'|'owner', text}] }` — first call with empty transcript returns an opening assistant message |
| POST | `/api/intake/:token/message` | `{ text }` | `{ reply: string, status: "in_progress"|"complete", summary?: {…} }` |
| POST | `/api/reset-demo` | | `{ ok:true }` — reload seed data |

## Frontend routes (SPA, hash based)
- `#/dashboard` — KPIs, funnel by stage, "Run pipeline on all new" with progress, pending approvals, unhandled replies
- `#/prospects` — table (name, country flag, industry, revenue, readiness score pill, stage pill, channel icon), search/filter by stage/country, Import CSV modal, Add prospect modal
- `#/company/:id` — header (name, country, owner, stage selector, Run all / Enrich / Score / Match / Draft outreach buttons), tabs: **Profile & signals**, **Score & why now**, **Buyer demand**, **Outreach** (sequence cards with humanizer badge, edit/approve/reject/send/copy), **Conversation** (paste reply → triage card + reply draft), **Owner intake** (generate link, view summary)
- `#/buyers` — buyer mandate cards + add/edit
- `#/settings` — API key, sender identity, style rules, value props, funnel assumptions
- `/intake/:token` — separate public page `public/intake.html`: chat UI for the business owner

## Web research, watch mode and buyer teaser (added)

Pipeline is now **research → enrich → score → match → outreach**. `POST /api/companies/:id/run` and the bulk pipeline run research first (reused for `RESEARCH_MAX_AGE_DAYS`, default 7); pass `{ research: false }` to skip it.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/companies/:id/research` | | `Company` with fresh `research` (crawl + registries + web + PDF). Fills blank `revenue_eur` / `ebitda_eur` / `employees` / `registry_id` from filed accounts; never overwrites database figures (differences go to `research.financials.conflicts`) |
| POST | `/api/companies/:id/watch` | | `Company` with `watch` updated: re-crawl, diff against `research.snapshot`, new facts appended to `research.facts` (with `detected_at`) |
| POST | `/api/watch/run` | `{ ids? }` | `{ job_id, total }`; job shape as `/api/jobs/:id` plus `kind: "watch"` (pipeline jobs have `kind: "pipeline"`) |
| GET | `/api/watch/alerts` | `?limit=50` | `{ watched, alerts:[{ id, at, kind, category, signal, title, url, company_id, company_name, country }] }`, newest first |
| POST | `/api/companies/:id/teaser` | | `Company` with `teaser`; **409 unless stage is `mandate_signed`** |

### Company additions
```json
"research": {
  "status": "done", "ran_at": "ISO", "duration_ms": 52000,
  "site": { "ok": true, "root": "https://…", "languages": ["fi","en"], "pages_found": 212, "pages_read": 24, "by_category": {"offering": 31},
            "js_only": false, "rendered_with": "none|browser", "robots_blocked": false, "jsonld_org": {…}, "social": {"linkedin": "…"},
            "business_ids": [{ "type": "FI_YTUNNUS", "value": "1234567-8", "raw": "…" }] },
  "pages": [{ "url", "category", "title", "lang", "words", "hash", "rendered" }],          // page text is not stored
  "facts": [{ "id": "f12", "category": "offering|customers|footprint|direction|financials|ownership|people|events|other",
              "claim": "…", "quote": "verbatim excerpt", "as_of": "2025", "confidence": "high|medium|low",
              "url": "https://…", "source_title": "…", "origin": "site|web", "verified": "quote|source", "detected_at": "ISO (watch only)" }],
  "financials": { "identifier": { "country": "NO", "id": "923609016", "source": "registry_id|website|name_search" },
                  "rows": [{ "year": 2025, "currency": "NOK", "revenue", "ebit", "ebitda", "net_income", "employees",
                             "revenue_eur", "ebit_eur", "ebitda_eur", "net_income_eur", "fx_to_eur", "ebitda_basis": "reported|derived|null",
                             "source": "Brønnøysund Regnskapsregisteret (NO)", "url", "confidence": "high|medium" }],
                  "documents": [{ "type": "annual_report", "year", "format": "pdf|xbrl", "url", "source" }],
                  "notes": ["…"], "checked": ["…"], "conflicts": ["Revenue: database €8.4M vs €11.2M in 2025 (…), 33% apart"] },
  "stats": { "facts", "site_facts", "web_facts", "dropped_unverified", "web_sources" },
  "filled_fields": ["revenue 2025 (…)"], "warnings": ["…"],
  "snapshot": { "at": "ISO", "urls": ["…"], "hashes": { "url": "sha1" } }
},
"watch": { "last_run_at": "ISO", "last_error": null, "last_summary": { "new_urls", "changed_pages", "new_facts" },
           "alerts": [{ "id", "at", "kind": "new_fact|new_page|changed_page|hiring_spike", "category", "signal": "leadership_change|acquisition|ownership|expansion|financial_report|hiring|null", "title", "url" }] },
"teaser": { "project_name", "headline", "blind_profile", "key_figures": [], "investment_highlights": [], "transaction", "redactions": [], "drafted_at", "status": "draft" }
```
`enrichment` additionally has `offering {summary, product_lines[{name, description, evidence}], business_model, evidence}`, `customer_segments[{segment, named_customers, evidence}]`, `footprint {headquarters, sites, sales_markets, evidence}`, `direction {vision, stated_goals, recent_moves[{date, event, evidence}], evidence}`, `financial_view` and `research_based`. `evidence` arrays hold fact ids (`f12`) from `research.facts`; unknown ids are stripped server-side.

### How research works
1. **Own website** (`server/research/crawl.js`): robots.txt (obeyed, honest `MergeroResearchBot` user agent, ~2 req/s), sitemaps + homepage/footer links, multilingual page picker (EN/FI/SV/NO/DA/DE) with per-topic quotas (~24 pages), JSON-LD organisation data, business IDs from footer/imprint, hreflang languages, PDF report links. JavaScript-only sites are rendered with the local Chrome/Edge (`server/research/render.js`, `puppeteer-core`, `BROWSER_PATH` override).
2. **Filed accounts** (`server/financials.js`): NO Brønnøysund Regnskapsregisteret, FI PRH digital (iXBRL) financial statements, DK Virk annual-report XBRL; converted to EUR at ECB reference rates. SE/DE/AT/CH: no open API wired; published figures come from step 3.
3. **Wider web**: Claude `web_search` localised to the company's country (+ `web_fetch`, LinkedIn blocked): press, events, published figures, report PDFs.
4. **Facts**: Claude extracts facts per page; a site fact is kept only if its quote is found on the cited page, a web fact only if its URL came back from the search tools. One annual-report PDF per run is read directly by Claude when it adds a year the registries don't have.

## Registry lookup (added)
| Method | Path | Params / Body | Returns |
|---|---|---|---|
| GET | `/api/registry/search` | `country=FI|NO|DK`, `q`, `industry_code`, `city` (FI), `founded_before` (year), `employees_min` (NO), `page` | `{ total, results:[{ name,country,city,website,industry,industry_code,employees,founded,registry_id,source,already_imported }] }` |
| POST | `/api/companies/bulk` | `{ companies:[…rows from search…] }` | `{ imported, companies }` — skips registry_ids already in the pipeline |

## Playbook additions
- `POST /api/companies/:id/outreach` and `POST /api/companies/:id/run` accept `framing`: `open` (default) | `growth` | `minority` | `exit`. Each generated Message carries `framing`.
- `GET /api/stats` also returns `hours_saved` (analyst hours the agents replaced, from `server/playbook.js` TIME_SAVED_MINUTES).
- `Settings` has `workspace_id` (sent as the `anthropic-workspace-id` header for org-level API keys).
