# Mergero Buyer Engine

Automated buy-side matching and private equity outreach generator. Designed to systemically lock in PE funds and serial acquirers by matching their acquisition criteria against proprietary off-market targets.

## Quick Start
1. Install dependencies:
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```
2. Run the origination desk:
   ```bash
   PYTHONPATH=src python src/main.py
   ```
3. Open http://127.0.0.1:8000/

Buyer mandates are read from `data/buyers_criteria.csv`. Every screen, match and draft is appended to `data/dialogues.jsonl`.

## Data sources

The **Data sources** tab combines five sources into one company record (`src/sources/`), with every field tagged by origin:

| Source | File / service | Notes |
|---|---|---|
| Buyer mandates | `data/buyers_criteria.csv` | Buy-side criteria |
| Company universe | `data/companies.csv` | 32 illustrative companies + 8 real Finnish companies (real ones carry no invented figures) |
| External signals | `data/signals.csv` | Dated succession, growth, acquisition, management, ownership and capital-need signals (simulated for illustrative companies) |
| Finnish Trade Register | [PRH open data API](https://avoindata.prh.fi/) | Live, free, no key: legal name, registration date, industry, name history |
| Company websites | `src/scraper.py` | Live: sector, geography and website signals |

## Prospect engine

The **Prospects** tab runs workflow steps 2-7 (`src/engine/`):

1. `ingest.py`: batch ingestion of every company (datasets only, or with live registry and website enrichment).
2. `signal_engine.py`: M&A triggers from signals (12-month half-life) plus derived ones (founder-generation succession, PE exit window, growth capital).
3. `scoring.py`: relevance score = timing (40) + buyer fit and deal size (35) + urgency (25); tiers A >= 80, B >= 60.
4. `hypothesis.py`: sell-side or buy-side mandate type, why now, why Mergero, suggested buyers, questions for the owner.
5. `outreach_agent.py`: channel and tone by region and ownership, 4-step sequence (days 0, 4, 10, 21). Sending is simulated.
6. `crm.py`: reply qualification (English, Finnish, Swedish, German rules), stages from Prospect to Mandate, advisor handoff package, funnel.

Set `OPENAI_API_KEY` to let an LLM polish hypotheses and first messages and classify replies. Without it, templates and rules are used.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q                  # offline, external calls mocked
RUN_LIVE=1 python -m pytest -q       # also hits the real registry and websites
```
