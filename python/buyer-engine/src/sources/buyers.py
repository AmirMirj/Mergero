import csv

from . import DATA_DIR

BUYERS_CSV = DATA_DIR / "buyers_criteria.csv"


def load_buyers() -> list[dict]:
    if not BUYERS_CSV.exists():
        return []
    buyers = []
    with BUYERS_CSV.open(newline="", encoding="utf-8") as handle:
        for idx, row in enumerate(csv.DictReader(handle)):
            buyers.append(
                {
                    "id": idx + 1,
                    "buyer_name": (row.get("buyer_name") or "").strip() or f"Fund {idx + 1}",
                    "target_sector": (row.get("target_sector") or "").strip(),
                    "min_ebitda_eur": int(float(row.get("min_ebitda_eur") or 0)),
                    "max_ebitda_eur": int(float(row.get("max_ebitda_eur") or 0)),
                    "geographic_focus": (row.get("geographic_focus") or "").strip(),
                }
            )
    return buyers
