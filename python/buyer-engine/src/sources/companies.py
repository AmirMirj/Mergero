import csv
from functools import lru_cache

from . import COUNTRY_NAMES, DATA_DIR, REGION_BY_COUNTRY

COMPANIES_CSV = DATA_DIR / "companies.csv"
INT_FIELDS = ("founded_year", "revenue_eur", "ebitda_eur", "employees")


def _to_int(value: str | None) -> int | None:
    value = (value or "").strip()
    if not value:
        return None
    return int(float(value))


@lru_cache(maxsize=1)
def _load() -> tuple[dict, ...]:
    if not COMPANIES_CSV.exists():
        return ()
    rows = []
    with COMPANIES_CSV.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            company = {key: (value or "").strip() for key, value in row.items()}
            company["company_id"] = int(company["company_id"])
            for field in INT_FIELDS:
                company[field] = _to_int(company.get(field))
            company["country_name"] = COUNTRY_NAMES.get(company["country"], company["country"])
            company["region"] = REGION_BY_COUNTRY.get(company["country"], "")
            rows.append(company)
    return tuple(rows)


def load_companies() -> list[dict]:
    return [dict(row) for row in _load()]


def get_company(company_id: int) -> dict | None:
    return next((dict(row) for row in _load() if row["company_id"] == company_id), None)
