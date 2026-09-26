STAGES = [
    "Screened",
    "Owner identified",
    "Warm-up drafted",
    "Outreach ready",
    "Mandate conversation",
]


def _first_name(ceo: str) -> str:
    parts = (ceo or "there").split()
    return parts[0] if parts else "there"


def _mix(profile: dict, fallback: str = "") -> str:
    products = profile.get("products") if profile.get("products") != "Pending Analysis" else ""
    customers = profile.get("customers") if profile.get("customers") != "Pending Analysis" else ""
    if products and customers:
        return f"{products}; customers: {customers}"
    return products or customers or fallback or "undisclosed mix"


def _region_from_profile(profile: dict, explicit: str | None = None) -> str:
    if explicit:
        return explicit
    hint = (profile.get("geographic_hint") or "").lower()
    if any(k in hint for k in ["germany", "dach", "austria", "switzerland", "gmbh"]):
        return "DACH"
    return "Nordics"


def owner_warmup(profile: dict, match: dict | None = None, ceo: str = "there", region: str | None = None) -> str:
    company = profile.get("company_name") or "your company"
    mix = _mix(profile, fallback="-")
    mix = "" if mix == "-" else mix
    region = _region_from_profile(profile, region)
    name = _first_name(ceo)
    if region == "DACH":
        greet = f"Guten Tag {ceo}," if ceo and ceo != "there" else "Guten Tag,"
        return (
            f"{greet}\n\n"
            f"Käufer aus unserem Netzwerk suchen derzeit gezielt nach spezialisierten Unternehmen wie {company}. "
            f"Es muss sich nichts ändern: Manche Eigentümer beginnen mit einem Wachstumspartner oder einer Minderheitsbeteiligung, "
            f"andere möchten einfach ihre Optionen für die nächsten Jahre kennen.\n\n"
            f"Hätten Sie Zeit für ein vertrauliches Gespräch von 20 Minuten? Ganz unverbindlich."
        )
    given = f", with your mix ({mix})," if mix else ""
    return (
        f"Hi {name},\n\n"
        f"Buyers in our network are currently looking for {profile.get('sector') or 'specialist'} companies like {company}{given} "
        f"in the Nordics.\n\n"
        f"Nothing needs to change: some owners start with a growth partner or a minority stake, others simply want to "
        f"understand their options for the next few years.\n\n"
        f"Would a 20-minute confidential conversation be useful? No commitment, no documents."
    )


def ic_note(buyer_name: str, profile: dict, match: dict | None = None) -> str:
    company = profile.get("company_name") or "Target"
    mix = _mix(profile)
    score = match.get("score") if match else None
    reasons = match.get("reasons") if match else []
    gaps = match.get("gaps") if match else []
    reason_lines = "\n".join(f"- {r}" for r in (reasons or ["Public-site screen completed"]))
    gap_lines = "\n".join(f"- {g}" for g in (gaps or ["None flagged"]))
    score_bit = f" Match score {score}/100." if score is not None else ""
    return (
        f"Investment committee note — {buyer_name} / {company}\n\n"
        f"Live web screen of {profile.get('source_url') or 'the corporate site'}.{score_bit}\n"
        f"Sector: {profile.get('sector')}. EBITDA signal: {profile.get('ebitda')}. Mix: {mix}.\n\n"
        f"Why this fit:\n{reason_lines}\n\n"
        f"Gaps to confirm with the owner:\n{gap_lines}\n\n"
        f"Ask: approve a confidential owner warm-up. Off-market only; Mergero on the buy-side."
    )


def sell_side_warmup(target: dict) -> str:
    profile = {
        "company_name": target.get("company"),
        "sector": "software",
        "products": target.get("revenue_split"),
        "customers": target.get("top_clients"),
        "geographic_hint": target.get("region"),
    }
    return owner_warmup(profile, ceo=target.get("ceo") or "there", region=target.get("region"))
