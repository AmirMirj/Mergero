# Optional Python parts

The Node app (`npm start`) runs without Python. Two Python folders sit next to it and are optional:

| Folder | From | What it adds |
|---|---|---|
| `python/company-scraper/` | Son | Finnish company profiles with **per-fact evidence**: PRH trade register (form, industry, dates, status, employer/VAT registers), PRH digital financial statements (XBRL: revenue, growth, EBITDA, operating profit, equity ratio for the latest two years, each with the filed line-item code, element and context id) and the company website (people with roles, family/succession/hiring/growth signals, contact points, each with the page and the quote it came from). The Node app calls it through `server/adapters/son_scraper.js` as a data source for Finnish companies; its facts carry `source: "son-scraper"`. |
| `python/buyer-engine/` | Amir | Buyer-side engine (trigger signals with decay, relevance scoring, mandate hypothesis, outreach and reply rules) with its pytest suite. Not called by the Node app; kept for its tests and as the reference for the signal/scoring ports. |

## Install

Python 3.9 or newer. The bridge only needs `requests` and `beautifulsoup4`; the rest of Son's `requirements.txt` (flask, openpyxl, anthropic) is for his own web app.

Windows (PowerShell or cmd):
```
python --version
pip install -r python/company-scraper/requirements.txt
```
If `python` opens the Microsoft Store, install Python from python.org (tick "Add python.exe to PATH") or run `py -3 -m pip install -r python/company-scraper/requirements.txt` and make sure `python` resolves afterwards.

macOS / Linux:
```
python3 --version
python3 -m pip install -r python/company-scraper/requirements.txt
```

Son's own app (browser UI on http://127.0.0.1:8765, needs the full requirements): `cd python/company-scraper && python app.py`, or double-click `Start Company Scraper.command` on macOS. Its AI features read `ANTHROPIC_API_KEY` from a `.env` next to `app.py`; the Node bridge needs no key.

## How the Node app picks it up

`available()` in `server/adapters/son_scraper.js` looks for `python`, then `python3`, on PATH (3.9+), checks that `python/company-scraper/company_scraper.py` exists and that `import requests, bs4` works, and caches the answer for 5 minutes (`available({ force: true })` re-checks). When it is not available, `enrichCompany()` returns `{ skipped: true, reason }` and everything else works as before. `profile()` runs `company_scraper.py "<query>" --json --out <temp dir>` (plus `--website`, `--no-website`, `--no-financials`), kills it after 120 s, and returns `{ found: false, note }` when PRH has no match. Quick check from the repo root:

```
node --input-type=module -e "import('./server/adapters/son_scraper.js').then(async m => { console.log(m.available()); const p = await m.profile('0180611-0'); console.log(p.registry?.name, m.toFacts(p).facts.length, 'facts'); })"
```

Restart `npm start` after installing Python so the server sees the new PATH.

## Amir's engine tests

```
cd python/buyer-engine
pip install -r requirements-dev.txt
python -m pytest -q                 # offline, external calls mocked
RUN_LIVE=1 python -m pytest -q      # also hits the real PRH registry and company websites
```

`python/.gitignore` keeps virtualenvs, `__pycache__`, `.pytest_cache`, Son's `output/` and Amir's `data/dialogues.jsonl` out of git.
