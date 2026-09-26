# Merge plan — three branches, one product

Repo: https://github.com/tommy2006/mergerochocolate · branches `main` (this Node app), `amir`, `son`. Clones for reading: `./amir`, `./son` (git-ignored).
Rules that apply: `docs/integration.md` → "Merge rules" (the app is the system of record; one approval queue; tagged sources; the app owns seller emails; tiebreak = more robust, more complete data, more agentified).

## What each branch is

| | `main` (Node, this app) | `amir` (Python) | `son` (Python + old Node snapshot) |
|---|---|---|---|
| Purpose | Sell-side origination engine: sourcing → research → score → buyer demand → humanised outreach → triage → intake, with real email, advisor caps, learning loop | "Origination Desk": trigger signals → relevance score → mandate hypothesis → 4-step outreach (simulated) → reply rules → funnel; explainable buyer-fit checks with charts and a guided demo | Finnish company profiler with per-fact evidence (PRH register + XBRL financials + website), Claude analysis with checked citations, seller→buyer discovery from the register, outreach drafts, Excel export |
| Stack | Express, vanilla JS, Claude (Zod structured outputs), Resend, JSON/Postgres | FastAPI, vanilla JS + Tailwind, OpenAI gpt-4o-mini optional, CSV data, PRH live, DuckDuckGo | Flask (:8765), Claude opus-5 streaming, requests/bs4, openpyxl; JSON files in `output/` |
| Registries | FI PRH, NO Brønnøysund (+ roles = owner age), DK CVR; filed accounts FI/NO/DK | FI PRH only | FI PRH + PRH XBRL (line-item evidence) |
| Matching | Deterministic prefilter + Claude rerank with reasons; one-click pairing with six checks; learning loop | Rule-based `score_buyer` (sector 50 / region 20 / size 20 / verified 10) with checks, reasons, gaps; charts | Claude scores register-found buyers for a seller (fit ≥60 preselected) |
| Outreach | 3-touch (0/6/14), framing (open/growth/minority/exit), linter + humanizer, send gate, per-advisor cap, Resend, scheduled follow-ups, inbox | 4-touch (0/4/10/21) EN/DE templates, banned "sell/exit/valuation" regex, sending simulated | Buyer emails with signature + opt-out line, anonymity check, CSV mail-merge; never sends |
| Replies | Claude triage + reply draft + re-scoring with evidence | Keyword rules EN/FI/SV/DE | — |
| Tests | Smoke/live checks in-session | 100 pytest functions, HTTP mocked | none committed |
| Known gaps | Registry reach beyond FI/NO/DK; compliance skipped by Timo's instruction | In-memory state, region/sector matching bugs, timing score overwritten in `/api/prospects`, dead code (`mergero-deal-engine/`) | Web UI folder (`static/`) not committed; Node folder is just an old copy of `main` |

`son`'s `server/` and `public/` are an untouched snapshot of `main` from 15:18 on 26 Sep — nothing to merge from there.

## Decisions (tiebreak rule applied)

1. **The Node app stays the product and the demo.** It is the most complete (both registries with owner ages, research with sources, real email, caps, learning) and the most agentified.
2. **Matching:** keep ours as primary (LLM rerank + deterministic checks + learning). Reuse from Amir the *explainability presentation* (per-check verdict yes/partial/unknown/no and the fit histogram) where ours only shows a bar.
3. **Finnish enrichment:** the research module stays primary (FI/NO/DK, web, watch). Son's profiler is added as a **source for Finnish companies** because its per-fact evidence (XBRL context ids, formulas, page quotes) is more complete for FI than ours.
4. **Outreach:** ours (linter + humanizer + gate + caps). Port Amir's banned-word regex list into `humanlint.js` if it has phrases ours lacks; keep our 0/6/14 cadence (Timo: 50–100 first touches/day per advisor, quality over volume).
5. **Triggers:** port Amir's signal model (12-month half-life; derived succession / PE-exit / growth-capital triggers; register rename → ownership-change signal) into our scoring inputs. It is small, tested and rule-based.
6. **Buyer discovery from the register (Son) and buy-side generation (ours):** both out of the demo (Timo: sell-side only). Keep in the code.

## Work items

| # | Item | Where | Effort |
|---|---|---|---|
| 1 | **Son bridge:** `python son/company_scraper.py "<name or business id>" --json` → adapter maps `{registry, financials{years, evidence, calculated}, website{signals, people_mentions, evidence}}` to our profile contract → `POST /api/integrations/profiles`; button "Enrich from Finnish profiler" on FI companies; facts tagged `source: son-scraper` | `server/adapters/son_scraper.js`, `public/app.js` | 45 min |
| 2 | **Amir signals:** port `signal_engine.py` decay + derived triggers and `registry_signals` (rename) into `server/signals.js`; feed into `agents.score` as "trigger signals" and show them as chips | `server/signals.js`, `index.js` stepScore, `app.js` Profile tab | 45 min |
| 3 | **Amir explainability:** per-check verdict scale and a fit histogram on the Buyer demand tab / dashboard | `app.js`, `styles.css` | 30 min |
| 4 | **Amir tests → CI:** keep `amir/` Python as `python/buyer-engine/` with its pytest; add a GitHub Action running `pytest -q` and `node --check` for the Node app | `.github/workflows/ci.yml` | 20 min |
| 5 | **Repo layout on `main`:** Node app at root; `python/company-scraper/` (Son: `company_scraper.py`, `ai.py`, `buyers.py`, `app.py`, `requirements.txt`); `python/buyer-engine/` (Amir: `src/`, `data/`, `tests/`, `web/`, `requirements*.txt`); remove `mergero-deal-engine/` (dead) and Son's `server/`+`public/` copies; one root README linking the three | repo | 30 min |
| 6 | **Keys:** one `.env` at root: `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`, `RESEND_*`, `DEMO_EMAIL`; Son's Python reads the same names; Amir's OpenAI stays optional | `.env.example` | 5 min |

## Merge order for tomorrow

1. Items 5 and 6 first (layout + keys) so everyone runs from one tree.
2. Item 1 (Son bridge) — the visible win for Finnish demo companies.
3. Item 2 (signals) — improves the "why now" for every prospect.
4. Items 3–4 if time remains.
