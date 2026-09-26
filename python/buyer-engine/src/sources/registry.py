import time
from datetime import date

import requests

PRH_URL = "https://avoindata.prh.fi/opendata-ytj-api/v3/companies"
TIMEOUT_S = 6
RECENT_RENAME_YEARS = 3
ENGLISH = "3"
FINNISH = "1"

_CACHE: dict[str, dict] = {}
_PING = {"checked_at": 0.0, "status": "unknown"}
PING_TTL_S = 300


def _describe(item: dict | None, lang: str = ENGLISH) -> str:
    for entry in (item or {}).get("descriptions") or []:
        if entry.get("languageCode") == lang:
            return entry.get("description") or ""
    return ""


def _current(items: list[dict]) -> list[dict]:
    return [i for i in items or [] if not i.get("endDate")]


def parse_company(raw: dict) -> dict:
    names = raw.get("names") or []
    legal = [n for n in _current(names) if n.get("type") == "1"]
    previous = sorted(
        [n for n in names if n.get("type") == "1" and n.get("endDate")],
        key=lambda n: n.get("endDate") or "",
        reverse=True,
    )
    forms = _current(raw.get("companyForms") or [])
    city = ""
    for address in raw.get("addresses") or []:
        for office in address.get("postOffices") or []:
            if office.get("languageCode") == FINNISH and office.get("city"):
                city = office["city"].title()
                break
        if city:
            break
    registered_on = raw.get("registrationDate") or (raw.get("businessId") or {}).get("registrationDate") or ""
    return {
        "business_id": (raw.get("businessId") or {}).get("value", ""),
        "legal_name": legal[0]["name"] if legal else (names[0]["name"] if names else ""),
        "registered_on": registered_on,
        "founded_year": int(registered_on[:4]) if registered_on[:4].isdigit() else None,
        "industry": _describe(raw.get("mainBusinessLine")),
        "company_form": _describe(forms[0]) if forms else "",
        "city": city,
        "active": not raw.get("endDate"),
        "previous_names": [{"name": n["name"], "until": n.get("endDate")} for n in previous],
    }


def _pick(companies: list[dict], name: str | None) -> dict | None:
    active = [c for c in companies if not c.get("endDate")] or companies
    if name:
        wanted = name.strip().lower()
        for company in active:
            if any(n.get("name", "").lower() == wanted for n in _current(company.get("names") or [])):
                return company
    return active[0] if active else None


def lookup_fi(business_id: str | None = None, name: str | None = None) -> dict:
    if not business_id and not name:
        return {"status": "not_found"}
    key = f"id:{business_id}" if business_id else f"name:{name.strip().lower()}"
    if key in _CACHE:
        return _CACHE[key]
    params = {"businessId": business_id} if business_id else {"name": name}
    try:
        response = requests.get(PRH_URL, params=params, timeout=TIMEOUT_S)
        response.raise_for_status()
        payload = response.json()
    except Exception:
        return {"status": "unavailable"}
    _PING.update(checked_at=time.time(), status="live")
    raw = _pick(payload.get("companies") or [], name)
    result = {"status": "ok", **parse_company(raw)} if raw else {"status": "not_found"}
    _CACHE[key] = result
    return result


def registry_signals(record: dict, source_url: str = "") -> list[dict]:
    """Turn registry facts into signals: a recent legal rename usually follows an acquisition or merger."""
    if record.get("status") != "ok":
        return []
    cutoff = date.today().year - RECENT_RENAME_YEARS
    signals = []
    for previous in record.get("previous_names") or []:
        until = previous.get("until") or ""
        if until[:4].isdigit() and int(until[:4]) >= cutoff:
            signals.append(
                {
                    "signal_type": "ownership_change",
                    "date": until,
                    "headline": f"Registered name changed from {previous['name']} to {record['legal_name']}",
                    "source": "Finnish Trade Register (PRH)",
                    "url": source_url or f"https://tietopalvelu.ytj.fi/yritys/{record['business_id']}",
                }
            )
    return signals


def ping() -> str:
    if time.time() - _PING["checked_at"] < PING_TTL_S:
        return _PING["status"]
    try:
        response = requests.get(PRH_URL, params={"businessId": "1509667-4"}, timeout=3)
        status = "live" if response.ok else "offline"
    except Exception:
        status = "offline"
    _PING.update(checked_at=time.time(), status=status)
    return status
