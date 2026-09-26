# Pitch notes — Mergero Origination Engine

Built from two Q&A rounds with Mergero. Use for the judging narrative and to answer the two open questions.

## The two "need answer" questions — proposed answers

**What is the one thing Mergero hasn't done before?**
Demand-led origination at scale. Today Mergero finds companies, then looks for buyers. The engine inverts it: every buyer mandate in the MGX network is turned into hundreds of *personal* owner conversations — the first touch already says "three buyers in our network are looking for exactly your kind of company" — and it reaches owners *before they know they want to sell*. Mergero has never had a way to open that many warm, specific, off-market conversations without adding headcount.

**Why should the customer care (owner's view)?**
"You find out what your company is worth to the buyers who actually want it — confidentially, without a public process, at your own pace, and with options short of a full sale (growth capital, a partial stake)." No auction, no leak to staff or competitors, no commitment beyond a 20-minute call.

## What the engine changes in Mergero's flow

| Mergero's answer | What the engine does |
|---|---|
| Sell-side first; origination is the bottleneck | Whole pipeline is sell-side: source → enrich → score → match demand → personal outreach → triage → intake → first call |
| Mandate = engagement letter after first call + 2–4 meetings | Pipeline stages mirror that path; dashboard projects mandates from stage conversion |
| Less manual research and first-touch outreach | Enrichment + outreach agents replace ~1.5 h of analyst time per prospect (tracked as "hours saved") |
| Internal tool with an external touchpoint | Advisor app + owner-facing confidential intake link |
| €2–50M revenue, founder-owned, 55+ / succession | Scoring model's ideal profile; registry lookup filters by founding year as the age proxy |
| Industry-agnostic (bicycles, mechanics, sports…) | Buyer matching is criteria-based, not sector-hardcoded; demo on industrial + healthcare where appetite is high |
| Owner doesn't know yet — catch them before | Readiness signals (age, tenure, no successor, flat growth); first touch never says "sell" |
| Decision-maker = majority owner | Enrichment identifies the majority owner; outreach is written to that person only |
| Growth capital / minority as softer entry | Outreach offers the soft door first; buyer mandates carry deal types incl. minority/growth |
| "Reach out to know" → mass outreach needed | Bulk pipeline runs the full chain on every new prospect with a human approving each message |
| Nordics = email, DACH = LinkedIn/calls | Channel chosen by country automatically |

## Partnerships and channels (slide)

The engine tags every prospect with its **source** and reports reply, meeting and mandate rates per source, so channels can be compared honestly. Channels to open, in order of expected yield:

| Channel | Why | How it plugs in |
|---|---|---|
| **Accountants and auditors** (Finland: authorised accountants network; DACH: Steuerberater) | They know a succession question 2–3 years before anyone else | Referral tag + partner name on the prospect; success-fee share on mandates |
| **Banks' SME advisors** (OP, Nordea, Danske, Sparebank 1) | See financing needs and owner age at the same time | Same referral tag; co-branded owner intake link |
| **Succession programmes** (Finland: *Omistajanvaihdos* / Suomen Yrittäjät's ownership-change service; Norway: *Eierskifte* initiatives) | Owners self-identify as "thinking about it" | Public demand page as the partner's landing page; leads arrive as `Inbound: demand page` |
| **Industry associations and trade fairs** | Sector concentration matches buyer theses | Registry lookup by industry code + event as source |

Sample history in the app shows referrals replying at roughly 2–3× the rate of database prospects and inbound owners converting best of all — the point of the slide: build the channels, measure them with the same funnel.

## Timo's DM answers (afternoon) — what changes in the story

- **Sell-side only.** The Buy-side mandates page stays in the code but out of the demo. The buyer network is context for owner outreach ("three buyers are looking for exactly this"), not a product.
- **Capacity is per advisor:** 50–100 first touches a day per sender. The engine's job is to make each of those 50 count, not to send 5,000. Say it out loud: quality per email, at the advisor's capacity.
- **Benchmark to beat:** 1,000 outbound contacts → 450–500 owner conversations. Our learning card measures reply, meeting and mandate rates by framing, source and country so the number becomes a fact, not a hope.
- **What failed before:** promotional or templated emails. Every draft now has to show *why this company*: the linter requires two sourced facts in a first touch and blocks anything that reads templated; the humanizer rewrites; the advisor approves.
- **Demo market:** Norway (free register with owner ages and filed accounts). Sweden would be preferred but has no free API.
- **MGX buyer data** comes over API/MCP with sector, size, deal type and geography — the same fields our matching uses.
- **Skip GDPR** in the demo.

## Demo slides (five, short)

1. **The bottleneck** — origination is person-by-person; Mergero wants to reach owners before they know they want to sell. One line from the brief.
2. **What we built** — sourcing (registers, owner age from the roles register) → research → readiness score → buyer demand → a personal first touch → reply triage → owner intake. One diagram, the pipeline stages named as Mergero's own path.
3. **Why this company** — a real Norwegian draft next to its linter card: two sourced facts, human-check 0, framing chosen (open / growth / minority), what the humanizer changed. This is the slide that answers "no templates".
4. **Numbers** — cost and minutes per prospect (measured), 35,000 Norwegian companies in reach, per-advisor capacity, the 1,000 → 450 benchmark and how the learning card tracks it.
5. **Pilot on Monday** — connect MGX over API/MCP, one advisor, one market (Norway), 50 first touches a day for two weeks; report replies, calls, engagement letters.

## Demo script (3 minutes)
1. Dashboard: 24 prospects, funnel, projected mandates, 5 drafts waiting for approval.
2. Registry lookup: pull 30+ Tampere machinery makers founded before 2005 straight from PRH → import.
3. Open a prospect → *Run full pipeline* → profile, readiness 78, valuation band, 3 buyers with reasons, humanized 3-touch sequence ("AI-tell 58 → 8").
4. Approve and send touch 1 (mailto). Paste an owner reply → triage: intent, extracted facts, next step, reply draft.
5. Owner intake link on a phone → 6 questions → structured summary lands on the record → stage moves to warm-up.
6. Back to Dashboard → *Run pipeline on all NEW* → the scale story.
