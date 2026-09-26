from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"

COUNTRY_NAMES = {
    "FI": "Finland",
    "SE": "Sweden",
    "NO": "Norway",
    "DK": "Denmark",
    "DE": "Germany",
    "AT": "Austria",
    "CH": "Switzerland",
}

REGION_BY_COUNTRY = {
    "FI": "Nordics",
    "SE": "Nordics",
    "NO": "Nordics",
    "DK": "Nordics",
    "DE": "DACH",
    "AT": "DACH",
    "CH": "DACH",
}
