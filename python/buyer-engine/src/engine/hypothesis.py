from datetime import date

from . import llm

MANDATES = {
    "succession": ("Succession sale", "sell"),
    "derived_succession": ("Succession sale", "sell"),
    "pe_exit": ("Secondary buyout (PE exit)", "sell"),
    "ownership_change": ("Secondary buyout (PE exit)", "sell"),
    "capital_need": ("Growth partner / minority stake", "sell"),
    "growth_capital": ("Growth partner / minority stake", "sell"),
    "growth": ("Growth partner / minority stake", "sell"),
    "management_change": ("Ownership transition review", "sell"),
    "acquisition": ("Add-on acquisition programme", "buy"),
}
NO_TRIGGER = ("Relationship build (no trigger yet)", "sell")

WHY_MERGERO = {
    "sell": ("Mergero already holds active buyer mandates that fit this profile. The owner can learn, confidentially and "
             "at their own pace, what these buyers value, with softer options than a full sale (growth capital, a minority stake)."),
    "buy": ("The company is acquiring. Mergero can run a buy-side programme that screens off-market "
            "add-on targets across the Nordics and DACH against its criteria."),
}

QUESTIONS = {
    "Succession sale": ["Is there a family or management successor?", "What timeline does the owner have in mind?",
                        "Full sale, or staying on for a transition period?"],
    "Secondary buyout (PE exit)": ["When does the fund's exit window open?", "Is a trade buyer or another sponsor preferred?",
                                   "Which KPIs does management want to show buyers?"],
    "Growth partner / minority stake": ["How much capital, and for what?", "Is a minority stake acceptable, or only growth debt?",
                                        "Which markets are next?"],
    "Ownership transition review": ["Why the leadership change now?", "What does the board want the next 3 years to look like?",
                                    "Is an ownership change being discussed?"],
    "Add-on acquisition programme": ["Which capabilities or regions should add-ons bring?", "What deal size and valuation range?",
                                     "Who decides internally, and how fast?"],
    "Relationship build (no trigger yet)": ["What are the owner's plans for the next 3-5 years?",
                                            "Would it help to hear what buyers in the sector are looking for?"],
}

# First-touch wording for owners: no "sell", "exit" or "valuation" (Mergero's messaging rule).
OWNER_ANGLE = {
    "Succession sale": "Owners who have built a company over {age} often start thinking about the next chapter well before anything changes, and it helps to know early which options are open.",
    "Secondary buyout (PE exit)": "With the current holding period, it may be a good moment to see what trade buyers and other investors are looking for today.",
    "Growth partner / minority stake": "With the growth you are showing, some owners bring in a partner for the next step while staying fully in charge.",
    "Ownership transition review": "Leadership changes are often a natural moment to think about plans for the next few years.",
    "Add-on acquisition programme": "Congratulations on the recent acquisition. We see a number of off-market add-on candidates that could fit a buy-and-build strategy.",
    "Relationship build (no trigger yet)": "We regularly share with owners what buyers in their sector are looking for, with no process in mind.",
}


def _ev_range(ev: int | None) -> str:
    if not ev:
        return "Unknown until financials are confirmed"
    return f"€{ev * 0.8 / 1e6:.0f}-{ev * 1.2 / 1e6:.0f}M"


def _why_now_line(trigger: dict) -> str:
    when = f" ({trigger['date']})" if trigger.get("date") else ""
    return f"{trigger['label']}{when}: {trigger['evidence']}"


def build_hypothesis(record: dict, triggers: list[dict], scored: dict, use_llm: bool = False) -> dict:
    company = record.get("company") or {}
    name = company.get("legal_name") or company.get("company_name") or "The company"
    dominant = triggers[0] if triggers else None
    mandate_type, side = MANDATES.get(dominant["type"], NO_TRIGGER) if dominant else NO_TRIGGER

    founded = company.get("founded_year")
    age = f"{date.today().year - founded} years" if founded else "many years"

    headline = f"{mandate_type} for {name}" + (f": {dominant['label'].lower()}" if dominant else "")
    why_mergero = WHY_MERGERO[side]
    source = "template"
    if use_llm:
        headline, h_src = llm.rewrite("Rewrite this one-line M&A hypothesis headline to be crisp (max 15 words).", headline)
        why_mergero, w_src = llm.rewrite("Rewrite this in two persuasive sentences for an advisor's internal brief.", why_mergero)
        source = "llm" if "llm" in (h_src, w_src) else "template"

    return {
        "mandate_type": mandate_type,
        "side": side,
        "headline": headline,
        "why_now": [_why_now_line(t) for t in triggers[:3]],
        "why_mergero": why_mergero,
        "owner_angle": OWNER_ANGLE[mandate_type].format(age=age),
        "suggested_buyers": scored.get("best_buyers") or [],
        "questions_for_owner": QUESTIONS[mandate_type],
        "ev_range": _ev_range(scored.get("ev_estimate")),
        "source": source,
    }
