import csv
import re
from datetime import date
from functools import lru_cache

from . import DATA_DIR

SIGNALS_CSV = DATA_DIR / "signals.csv"
SIGNAL_TYPES = ("succession", "growth", "acquisition", "management_change", "ownership_change", "capital_need")
SIGNAL_LABELS = {
    "succession": "Succession",
    "growth": "Growth",
    "acquisition": "Acquisition",
    "management_change": "Management change",
    "ownership_change": "Ownership change",
    "capital_need": "Capital need",
}

# Signals found by live enrichment; keyed by company_id. Lost on restart like the rest of the in-memory state.
LIVE_SIGNALS: dict[int, list[dict]] = {}

FOUNDED_RE = re.compile(r"\b(?:founded|established|since|perustettu|grundad|gegründet)\s+(?:in\s+|im\s+jahr\s+)?((?:18|19|20)\d{2})\b", re.I)
WEB_RULES = [
    ("acquisition", "Website mentions an acquisition or merger",
     re.compile(r"\b(?:has acquired|acquired|acquires|acquisition of|joins forces with|merger with)\b", re.I)),
    ("management_change", "Website mentions a CEO change",
     re.compile(r"\b(?:new ceo|named ceo|appointed[^.]{0,60}\bceo\b)", re.I)),
    ("growth", "Website shows hiring or record growth",
     re.compile(r"\b(?:we'?re hiring|we are hiring|open positions|record year|record revenue|record growth)\b", re.I)),
]
SUCCESSION_AGE_YEARS = 25


@lru_cache(maxsize=1)
def _load_csv() -> tuple[dict, ...]:
    if not SIGNALS_CSV.exists():
        return ()
    rows = []
    with SIGNALS_CSV.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            signal = {key: (value or "").strip() for key, value in row.items()}
            signal["company_id"] = int(signal["company_id"])
            rows.append(signal)
    return tuple(rows)


def load_signals() -> list[dict]:
    stored = [dict(row) for row in _load_csv()]
    live = [dict(s) for signals in LIVE_SIGNALS.values() for s in signals]
    return stored + live


def signals_for(company_id: int) -> list[dict]:
    rows = [s for s in load_signals() if s["company_id"] == company_id]
    rows.sort(key=lambda s: s.get("date") or "", reverse=True)
    return rows


def add_live_signals(company_id: int, signals: list[dict]) -> list[dict]:
    """Store newly detected signals, skipping ones already known. Returns only the new ones."""
    existing = LIVE_SIGNALS.setdefault(company_id, [])
    known = {(s["signal_type"], s["headline"]) for s in existing}
    added = []
    for signal in signals:
        key = (signal["signal_type"], signal["headline"])
        if key in known:
            continue
        row = {**signal, "company_id": company_id}
        existing.append(row)
        known.add(key)
        added.append(row)
    return added


def _snippet(text: str, start: int, end: int, pad: int = 70) -> str:
    left = max(0, start - pad)
    right = min(len(text), end + pad)
    return ("…" if left else "") + " ".join(text[left:right].split()) + ("…" if right < len(text) else "")


def detect_founded_year(text: str) -> int | None:
    this_year = date.today().year
    for match in FOUNDED_RE.finditer(text or ""):
        year = int(match.group(1))
        if 1850 <= year <= this_year:
            return year
    return None


def detect_web_signals(text: str, source_url: str = "") -> list[dict]:
    text = text or ""
    today = date.today().isoformat()
    signals = []

    founded = detect_founded_year(text)
    if founded and date.today().year - founded >= SUCCESSION_AGE_YEARS:
        match = FOUNDED_RE.search(text)
        signals.append(
            {
                "signal_type": "succession",
                "date": today,
                "headline": f"Founded in {founded} ({date.today().year - founded} years ago): founder-generation ownership is likely",
                "source": "Company website",
                "url": source_url,
                "evidence": _snippet(text, match.start(), match.end()),
            }
        )

    for signal_type, headline, pattern in WEB_RULES:
        match = pattern.search(text)
        if not match:
            continue
        signals.append(
            {
                "signal_type": signal_type,
                "date": today,
                "headline": f"{headline} (\"{match.group(0).strip()}\")",
                "source": "Company website",
                "url": source_url,
                "evidence": _snippet(text, match.start(), match.end()),
            }
        )
    return signals
