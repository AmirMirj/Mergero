from datetime import date

from sources.signals import SIGNAL_LABELS

BASE = {
    "succession": 1.0,
    "ownership_change": 0.8,
    "capital_need": 0.75,
    "management_change": 0.6,
    "acquisition": 0.6,
    "growth": 0.45,
}
HALF_LIFE_DAYS = 365
SIDE = {
    "succession": "sell",
    "ownership_change": "sell",
    "capital_need": "sell",
    "management_change": "sell",
    "acquisition": "buy",
    "growth": "either",
    "derived_succession": "sell",
    "pe_exit": "sell",
    "growth_capital": "sell",
}
THEME = {
    "succession": "succession",
    "derived_succession": "succession",
    "ownership_change": "ownership",
    "pe_exit": "ownership",
    "capital_need": "capital",
    "growth_capital": "capital",
    "growth": "capital",
    "management_change": "management",
    "acquisition": "acquisition",
}
SUCCESSION_MIN_AGE = 25
PE_HOLD_YEARS = 4


def decay(age_days: int) -> float:
    return 0.5 ** (max(0, age_days) / HALF_LIFE_DAYS)


def _parse(value: str | None) -> date | None:
    try:
        return date.fromisoformat((value or "")[:10])
    except ValueError:
        return None


def _explicit(signal: dict, today: date) -> dict | None:
    kind = signal.get("signal_type")
    if kind not in BASE:
        return None
    when = _parse(signal.get("date"))
    age_days = (today - when).days if when else None
    strength = BASE[kind] * (decay(age_days) if age_days is not None else 0.5)
    return {
        "type": kind,
        "label": SIGNAL_LABELS.get(kind, kind),
        "strength": round(strength, 3),
        "date": signal.get("date") or None,
        "age_days": age_days,
        "evidence": signal.get("headline") or "",
        "source": signal.get("source") or "",
        "side": SIDE[kind],
        "derived": False,
    }


def _derived(company: dict, signals: list[dict], today: date) -> list[dict]:
    triggers = []
    founded = company.get("founded_year")
    ownership = (company.get("ownership_type") or "").lower()

    if ownership in ("founder", "family") and founded and today.year - founded >= SUCCESSION_MIN_AGE:
        age = today.year - founded
        triggers.append({
            "type": "derived_succession",
            "label": "Founder-generation succession likely",
            "strength": round(min(0.65, 0.4 + 0.01 * (age - SUCCESSION_MIN_AGE)), 3),
            "date": None,
            "age_days": None,
            "evidence": f"{ownership.title()}-owned and founded in {founded} ({age} years ago)",
            "source": "Derived from profile",
            "side": SIDE["derived_succession"],
            "derived": True,
        })

    if ownership == "pe":
        entries = [_parse(s.get("date")) for s in signals if s.get("signal_type") == "ownership_change"]
        entries = [d for d in entries if d]
        if entries:
            entered = min(entries)
            years = (today - entered).days / 365.25
            if years >= PE_HOLD_YEARS:
                triggers.append({
                    "type": "pe_exit",
                    "label": "PE holding period ending, exit window",
                    "strength": round(min(1.0, 0.7 + 0.1 * (years - PE_HOLD_YEARS)), 3),
                    "date": entered.isoformat(),
                    "age_days": None,
                    "evidence": f"PE owner since {entered.year} ({years:.1f} years; typical hold is 4-6)",
                    "source": "Derived from ownership signal",
                    "side": SIDE["pe_exit"],
                    "derived": True,
                })

    kinds = {s.get("signal_type") for s in signals}
    if {"growth", "capital_need"} <= kinds:
        triggers.append({
            "type": "growth_capital",
            "label": "Growth capital or partner needed",
            "strength": 0.7,
            "date": None,
            "age_days": None,
            "evidence": "Growing fast and publicly looking for capital",
            "source": "Derived from signals",
            "side": SIDE["growth_capital"],
            "derived": True,
        })
    return triggers


def detect_triggers(record: dict, today: date | None = None) -> list[dict]:
    today = today or date.today()
    signals = record.get("signals") or []
    triggers = [t for t in (_explicit(s, today) for s in signals) if t]
    triggers += _derived(record.get("company") or {}, signals, today)
    triggers.sort(key=lambda t: t["strength"], reverse=True)
    return triggers
