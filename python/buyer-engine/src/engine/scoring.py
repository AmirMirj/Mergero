from datetime import date

from matcher import rank_buyers, summarize_matches
from sources.record import to_profile

from .signal_engine import THEME, detect_triggers

TIMING_MAX = 40
FIT_BUYER_MAX = 25
FIT_BAND_POINTS = 10
URGENCY_PER_TYPE = 8
URGENCY_TYPES_CAP = 16
URGENCY_RECENT = 5
URGENCY_FOUNDER_CEO = 4
RECENT_DAYS = 183
# Mergero's hard minimum valuation is €3-5M: below €3M is out, €3-5M is borderline.
BAND_EUR = (3_000_000, 100_000_000)
FLOOR_FULL_EUR = 5_000_000
TIER_A = 80
TIER_B = 60

SECTOR_MULTIPLES = {
    "B2B SaaS & Digital Services": 10,
    "Software & Technical wholesale": 8,
    "Sustainable Tech & Software": 9,
    "Manufacturing & Industrial Automation": 7,
    "Industrial construction": 6,
    "Circular economy / Waste logistics": 7,
    "Healthcare & Facility services": 8,
    "Food & Beverage": 7,
}
DEFAULT_MULTIPLE = 7


def estimate_ev(company: dict) -> tuple[int | None, int]:
    multiple = SECTOR_MULTIPLES.get(company.get("sector") or "", DEFAULT_MULTIPLE)
    ebitda = company.get("ebitda_eur")
    return (ebitda * multiple if ebitda else None), multiple


def floor_status(ev: int | None) -> str:
    if ev is None:
        return "unknown"
    if ev < BAND_EUR[0]:
        return "below"
    if ev < FLOOR_FULL_EUR:
        return "borderline"
    return "above" if ev <= BAND_EUR[1] else "too_large"


def tier_for(score: int) -> str:
    if score >= TIER_A:
        return "A"
    if score >= TIER_B:
        return "B"
    return "C"


def score_prospect(record: dict, triggers: list[dict], buyers: list[dict]) -> dict:
    company = record.get("company") or {}
    explanation = []

    top = triggers[0] if triggers else None
    timing = round(TIMING_MAX * top["strength"]) if top else 0
    explanation.append(
        f"Timing {timing}/{TIMING_MAX}: strongest trigger is \"{top['label']}\"" if top
        else f"Timing 0/{TIMING_MAX}: no transaction trigger detected yet"
    )

    ranked = rank_buyers(buyers, to_profile(record)) if buyers else []
    best_buyers = [{
        "buyer_id": b["buyer_id"], "buyer_name": b["buyer_name"], "score": b["score"],
        "target_sector": b["target_sector"], "geographic_focus": b.get("geographic_focus"),
        "verdict": b.get("verdict"), "summary": b.get("summary"), "checks": b.get("checks"),
        "axes": b.get("axes"), "parts": b.get("parts"), "company_ebitda_eur": b.get("company_ebitda_eur"),
        "min_ebitda_eur": b.get("min_ebitda_eur"), "max_ebitda_eur": b.get("max_ebitda_eur"),
        "reasons": b.get("reasons") or [], "gaps": b.get("gaps") or [],
    } for b in ranked[:3]]
    best_score = ranked[0]["score"] if ranked else 0
    buyer_points = round(FIT_BUYER_MAX * best_score / 100)
    ev, multiple = estimate_ev(company)
    floor_check = floor_status(ev)
    in_band = floor_check in ("above", "borderline")
    band_points = {"above": FIT_BAND_POINTS, "borderline": FIT_BAND_POINTS // 2}.get(floor_check, 0)
    fit = buyer_points + band_points
    if ranked:
        explanation.append(f"Fit {fit}/{FIT_BUYER_MAX + FIT_BAND_POINTS}: best buyer {ranked[0]['buyer_name']} scores {best_score}/100")
    value = f"Estimated value €{ev / 1e6:.1f}M ({multiple}x EBITDA)" if ev is not None else ""
    explanation.append({
        "unknown": "EBITDA unknown, so the value can't be checked against Mergero's €3-5M minimum",
        "below": f"{value} is below Mergero's €3-5M minimum valuation",
        "borderline": f"{value} is at Mergero's €3-5M minimum, so borderline",
        "above": f"{value} clears Mergero's €3-5M minimum",
        "too_large": f"{value} is above the €100M range Mergero serves",
    }[floor_check])

    sell_types = {THEME[t["type"]] for t in triggers if t["side"] == "sell"}
    type_points = min(URGENCY_TYPES_CAP, URGENCY_PER_TYPE * len(sell_types))
    recent = any(t["age_days"] is not None and t["age_days"] < RECENT_DAYS for t in triggers)
    founder_ceo = (
        any(t["type"] in ("succession", "derived_succession") for t in triggers)
        and company.get("owner_name")
        and company.get("owner_name") == company.get("ceo_name")
    )
    urgency = type_points + (URGENCY_RECENT if recent else 0) + (URGENCY_FOUNDER_CEO if founder_ceo else 0)
    parts = []
    if sell_types:
        parts.append(f"sell-side triggers on {len(sell_types)} theme(s) ({', '.join(sorted(sell_types))})")
    if recent:
        parts.append("a trigger in the last 6 months")
    if founder_ceo:
        parts.append("the owner is still CEO")
    explanation.append(f"Urgency {urgency}/25: " + (", ".join(parts) if parts else "nothing pressing"))

    score = min(100, timing + fit + urgency)
    return {
        "score": score,
        "tier": tier_for(score),
        "timing": timing,
        "fit": fit,
        "urgency": urgency,
        "explanation": explanation,
        "best_buyers": best_buyers,
        "match_stats": summarize_matches(ranked),
        "ev_estimate": ev,
        "ev_multiple": multiple,
        "in_band": in_band,
        "floor_check": floor_check,
    }


def rank_prospects(profiles: dict[int, dict], buyers: list[dict], today: date | None = None) -> list[dict]:
    rows = []
    for company_id, rec in profiles.items():
        triggers = detect_triggers(rec, today)
        scored = score_prospect(rec, triggers, buyers)
        rows.append({"company_id": company_id, "record": rec, "triggers": triggers, "scored": scored})
    rows.sort(key=lambda r: r["scored"]["score"], reverse=True)
    return rows
