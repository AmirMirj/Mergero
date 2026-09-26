import re

SECTOR_ALIASES = {
    "saas": ["saas", "cloud", "software", "digital", "subscription", "api", "b2b"],
    "software": ["saas", "cloud", "software", "digital", "wholesale", "technical"],
    "circular": ["circular", "waste", "recycle", "recycling", "logistics"],
    "construction": ["construction", "industrial", "build", "steel"],
    "manufacturing": ["manufacturing", "automation", "industrial", "engineering"],
    "telecom": ["telecom", "5g", "network", "infrastructure"],
    "retail": ["retail", "furniture", "consumer", "store"],
    "defense": ["defense", "aerospace", "radar", "security"],
    "sustainable": ["sustainable", "tech", "software", "green", "energy"],
}


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", (text or "").lower()))


def _parse_ebitda_eur(value) -> float | None:
    if value is None:
        return None
    text = str(value).lower().replace(",", "").replace(" ", "")
    if "confidential" in text or "pending" in text or "nda" in text:
        return None
    match = re.search(r"([\d.]+)", text)
    if not match:
        return None
    number = float(match.group(1))
    if "billion" in text or re.search(r"\db\b", text):
        return number * 1_000_000_000
    if "million" in text or re.search(r"\dm\b", text) or "€" in str(value) or "eur" in text:
        if number < 1000:
            return number * 1_000_000
        return number
    return number


def _sector_score(profile_sector: str, buyer_sector: str, products: str) -> tuple[int, str | None, str | None]:
    profile_tokens = _tokens(f"{profile_sector} {products}")
    buyer_tokens = _tokens(buyer_sector)
    overlap = profile_tokens & buyer_tokens
    alias_hits = 0
    for _, aliases in SECTOR_ALIASES.items():
        if any(a in profile_tokens for a in aliases) and any(a in buyer_tokens for a in aliases):
            alias_hits += 1
    if overlap or alias_hits:
        points = min(50, 20 + 10 * len(overlap) + 15 * alias_hits)
        return points, f"Sector matches what the buyer wants ({buyer_sector})", None
    return 8, None, f"Sector mismatch: buyer wants {buyer_sector}, company looks like {profile_sector or 'an unclear sector'}"


def _geo_score(geo_hint: str, buyer_geo: str) -> tuple[int, str | None, str | None]:
    hint = (geo_hint or "").lower()
    focus = (buyer_geo or "").lower()
    if not hint:
        return 8, None, f"Location not stated on the website (buyer focus: {buyer_geo})"
    nordics = any(k in hint for k in ["finland", "sweden", "nordic", "norway", "denmark", "helsinki"])
    dach = any(k in hint for k in ["germany", "dach", "austria", "switzerland", "gmbh"])
    europe = "europe" in hint or nordics or dach
    if "finland" in focus and "finland" in hint:
        return 20, f"Located in the buyer's region ({buyer_geo})", None
    if "nordic" in focus and nordics:
        return 20, f"Located in the buyer's region ({buyer_geo})", None
    if "dach" in focus and dach:
        return 20, f"Located in the buyer's region ({buyer_geo})", None
    if "europe" in focus and europe:
        return 16, f"European presence fits the buyer's focus ({buyer_geo})", None
    if europe and ("finland" in focus or "nordic" in focus or "europe" in focus):
        return 12, None, f"Only partly in the buyer's region ({buyer_geo})"
    return 4, None, f"Outside the buyer's region ({buyer_geo})"


def _ebitda_score(profile_ebitda, min_eur, max_eur) -> tuple[int, str | None, str | None]:
    parsed = _parse_ebitda_eur(profile_ebitda)
    try:
        lo = float(min_eur)
        hi = float(max_eur)
    except (TypeError, ValueError):
        return 10, None, None
    buyer_band = f"€{lo/1e6:.0f}–{hi/1e6:.0f}M"
    if parsed is None:
        return 10, None, f"EBITDA not public; buyer needs {buyer_band}"
    if lo <= parsed <= hi:
        return 20, f"EBITDA inside the buyer's range ({buyer_band})", None
    if parsed < lo * 0.5 or parsed > hi * 2:
        return 2, None, f"EBITDA {profile_ebitda} is far outside the buyer's range ({buyer_band})"
    return 8, None, f"EBITDA {profile_ebitda} is just outside the buyer's range ({buyer_band})"


def score_buyer(buyer: dict, profile: dict) -> dict:
    sector_pts, sector_reason, sector_gap = _sector_score(
        profile.get("sector", ""),
        buyer.get("target_sector", ""),
        profile.get("products", ""),
    )
    geo_pts, geo_reason, geo_gap = _geo_score(
        profile.get("geographic_hint", ""),
        buyer.get("geographic_focus", ""),
    )
    ebitda_pts, ebitda_reason, ebitda_gap = _ebitda_score(
        profile.get("ebitda"),
        buyer.get("min_ebitda_eur"),
        buyer.get("max_ebitda_eur"),
    )
    verified = bool(profile.get("verified"))
    verified_pts = 10 if verified else 4
    verified_reason = "Sector confirmed on the company's own website" if verified else None
    verified_gap = None if verified else "Sector unclear from the website"
    score = min(100, sector_pts + geo_pts + ebitda_pts + verified_pts)
    reasons = [r for r in (sector_reason, geo_reason, ebitda_reason, verified_reason) if r]
    gaps = [g for g in (sector_gap, geo_gap, ebitda_gap, verified_gap) if g]
    region_ok = "yes" if geo_pts >= 16 else "partial" if geo_pts == 12 else "unknown" if geo_pts == 8 else "no"
    size_ok = "yes" if ebitda_pts >= 20 else "unknown" if ebitda_pts == 10 else "partial" if ebitda_pts == 8 else "no"
    checks = {
        "sector": {"ok": "yes" if sector_pts >= 20 else "no", "label": buyer.get("target_sector") or "sector",
                   "detail": sector_reason or sector_gap or ""},
        "region": {"ok": region_ok, "label": buyer.get("geographic_focus") or "region",
                   "detail": geo_reason or geo_gap or ""},
        "size": {"ok": size_ok, "label": _band_label(buyer.get("min_ebitda_eur"), buyer.get("max_ebitda_eur")),
                 "detail": ebitda_reason or ebitda_gap or ""},
    }
    verdict = "strong" if score >= 75 else "possible" if score >= 55 else "weak"
    parsed_ebitda = _parse_ebitda_eur(profile.get("ebitda"))
    return {
        "buyer_id": buyer.get("id"),
        "buyer_name": buyer.get("buyer_name"),
        "target_sector": buyer.get("target_sector"),
        "geographic_focus": buyer.get("geographic_focus"),
        "min_ebitda_eur": buyer.get("min_ebitda_eur"),
        "max_ebitda_eur": buyer.get("max_ebitda_eur"),
        "score": score,
        "verdict": verdict,
        "summary": _summary(checks),
        "checks": checks,
        "axes": {
            "sector": min(100, round(100 * sector_pts / 50)),
            "region": min(100, round(100 * geo_pts / 20)),
            "size": min(100, round(100 * ebitda_pts / 20)),
        },
        "parts": {
            "sector": sector_pts,
            "region": geo_pts,
            "size": ebitda_pts,
            "verified": verified_pts,
        },
        "company_ebitda_eur": parsed_ebitda,
        "reasons": reasons,
        "gaps": gaps,
        "in_mandate_band": ebitda_pts >= 8,
    }


def _band_label(lo, hi) -> str:
    try:
        return f"€{float(lo)/1e6:.0f}–{float(hi)/1e6:.0f}M EBITDA"
    except (TypeError, ValueError):
        return "size band"


def _summary(checks: dict) -> str:
    sector = {"yes": "same kind of company", "no": "different sector"}.get(checks["sector"]["ok"], "sector unclear")
    region = {"yes": "in their region", "partial": "only partly in their region",
              "unknown": "location not on the site", "no": "outside their region"}[checks["region"]["ok"]]
    size = {"yes": "right size", "partial": "size is close", "unknown": "size not public",
            "no": "outside their size range"}[checks["size"]["ok"]]
    return f"{sector[0].upper() + sector[1:]}, {region}. {size[0].upper() + size[1:]}."


def rank_buyers(buyers: list[dict], profile: dict) -> list[dict]:
    ranked = [score_buyer(buyer, profile) for buyer in buyers]
    ranked.sort(key=lambda row: row["score"], reverse=True)
    return ranked


def summarize_matches(ranked: list[dict]) -> dict:
    """Mean, median, spread and how much the top buyer stands out."""
    scores = [int(row["score"]) for row in ranked if row.get("score") is not None]
    n = len(scores)
    if not n:
        return {
            "n": 0, "best": 0, "mean": 0, "median": 0, "stdev": 0,
            "min": 0, "max": 0, "lift": 0, "strong": 0, "possible": 0, "weak": 0,
            "read": "No buyer mandates to compare.", "scores": [],
        }
    mean = sum(scores) / n
    ordered = sorted(scores)
    mid = n // 2
    median = float(ordered[mid] if n % 2 else (ordered[mid - 1] + ordered[mid]) / 2)
    stdev = (sum((s - mean) ** 2 for s in scores) / n) ** 0.5
    strong = sum(1 for s in scores if s >= 75)
    possible = sum(1 for s in scores if 55 <= s < 75)
    weak = n - strong - possible
    best = max(scores)
    lift = best - median
    if strong == 0 and possible == 0:
        read = "No buyer in the book is a fit."
    elif strong == 1 and lift >= 15:
        read = "One buyer stands out from the rest."
    elif strong >= 2:
        read = "Several buyers are a strong fit."
    elif possible and not strong:
        read = "Possible fits only — no strong mandate yet."
    else:
        read = "A few buyers are close; none dominate."
    return {
        "n": n,
        "best": best,
        "mean": round(mean, 1),
        "median": round(median, 1),
        "stdev": round(stdev, 1),
        "min": min(scores),
        "max": best,
        "lift": round(lift, 1),
        "strong": strong,
        "possible": possible,
        "weak": weak,
        "read": read,
        "scores": scores,
    }
