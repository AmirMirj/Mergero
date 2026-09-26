# Integration contract — merging the teammate's scraper, matcher and mass mailer

The app is the system of record (prospects, buyers, messages, approvals, conversations). The teammate's components plug in through four JSON endpoints and can replace the built-in agents one at a time. Mock payloads in `data/mock/` let us demo the merged flow before his code lands (`POST /api/integrations/mock/profiles`, `POST /api/integrations/mock/matches`).

## 1. Scraper → company profiles
`POST /api/integrations/profiles`  body: `{ "source": "his-scraper", "profiles": [ Profile ] }` (or a bare array)

```json
{
  "company": { "name": "Vaasa Energy Services Oy", "country": "FI", "website": "https://…", "registry_id": "1234567-8" },
  "summary": "2–3 sentences",
  "pages_read": 17,
  "financials": { "revenue_eur": 7800000, "ebit_eur": 900000, "employees": 54, "year": 2025, "source": "PRH" },
  "facts": [
    { "id": "x1", "category": "events|direction|people|ownership|customers|offering|footprint|careers|financials|other",
      "claim": "one sentence", "quote": "verbatim text from the page", "url": "https://…", "as_of": "2026-03-11", "confidence": "high|medium|low" }
  ]
}
```
Matching order for `company`: `company_id` → `registry_id` → website host → exact name; unknown companies are created as `new` prospects. Facts land in `company.research.facts`, which enrichment, scoring, outreach (sourced observations) and the Web dossier tab already consume. Financials fill blank fields only.

## 2. NLP matcher → buyer matches
`POST /api/integrations/matches`  body: `{ "replace": false, "matches": [ Match ] }`

```json
{ "name": "Vaasa Energy Services Oy", "buyer_name": "Nordic lower-mid-market PE fund", "fit": 0.81, "reason": "why", "source": "his-matcher" }
```
`fit` may be 0–1 or 0–100. Buyers are matched by `buyer_id` or exact `buyer_name`. Results appear in the Buyer demand tab, feed the outreach writer's "buyer demand" line and the buy-side suggestions.

## 3. Mass mailer ← outbox, → acknowledgements
`GET /api/integrations/outbox?status=approved` returns every human-approved email on both sides:

```json
{ "from": { "name": "Timo Tontti", "email": "…" }, "count": 4,
  "items": [ { "side": "seller", "message_id": "m_…", "company_id": "c_…", "to": "owner@…", "subject": "…", "body": "…", "step": 1, "send_after_days": 0, "framing": "growth" },
             { "side": "buyer",  "message_id": "bm_…", "buyer_id": "b_…", "company_id": "c_…", "to": "deals@…", "subject": "…", "body": "…" } ] }
```
After sending: `POST /api/integrations/outbox/ack` with `{ "acks": [ { "message_id": "m_…", "provider_id": "…", "sent_at": "ISO" } ] }` → status `sent`, stage → *First touch sent*, conversation entry written. Approval stays in the app: the mailer must only send items that appear in the outbox.

## 4. Inbound replies → triage
`POST /api/integrations/inbound`
- seller: `{ "side": "seller", "company_id": "c_…" | "registry_id" | "website" | "name", "from": "owner@…", "text": "…", "channel": "email" }` → runs the existing reply → triage → reply-draft flow, stops the sequence.
- buyer: `{ "side": "buyer", "buyer_id": "b_…", "company_id": "c_…", "from": "…", "text": "…" }` → stored on the buyer (`buyer.replies`).

The built-in email layer (Resend webhook at `/api/mail/inbound/resend`) does the same for mail the app sends itself; both paths end in the same triage.

## Where the parts overlap with the app today

| Teammate component | Built-in equivalent | Merge plan |
|---|---|---|
| Company scraper | `server/research/` (site crawl + registries + web search) and Registry lookup | Either feeds `research.facts`; run both and de-duplicate by URL, or switch the pipeline's research step to his output via endpoint 1 |
| NLP buyer↔seller matcher | `agents.match` (deterministic prefilter + Claude rerank) | His matches import via endpoint 2; a `source` field keeps both visible; the UI shows the best fit per buyer |
| Mass mailer, both sides | Outreach writer + humanizer + approval queue (sellers); buyer notes (`server/suggest.js`); email layer (Resend, scheduled follow-ups, inbox) | His mailer pulls only approved items from the outbox and acks sends; the app keeps approval, sequencing, stop-on-reply and triage |

Rule of thumb: his components generate and deliver; the app decides, approves, tracks and learns.

## Merge rules (agreed 2026-09-26)

1. **The app is the system of record.** Prospects, buyers, pairings, messages, approvals and conversations live here; external components read and write through the endpoints above, never by editing the store.
2. **Approval stays human and single.** Nothing reaches an owner or a buyer unless it appears in the approved outbox. One queue, one inbox, one triage path.
3. **Same shapes, tagged sources.** Facts, matches and messages carry a `source`; both implementations can coexist and be compared side by side.
4. **Sell-side email writing is owned by this app** (seller sequences, humanizer, reply drafts). The teammate's mailer delivers; it does not compose.
5. **Tiebreak rule:** when two implementations cover the same job, the one that is more robust (handles failures and missing data), provides more complete data (sources, fields, structure), and is more agentified (does the work autonomously with a human approving outcomes) is the one chosen.
