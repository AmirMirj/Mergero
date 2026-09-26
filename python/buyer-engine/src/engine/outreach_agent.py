import re
from datetime import date, datetime, timezone

from . import llm

SEQUENCE_DAYS = (0, 4, 10, 21)
FITTING_BUYER_SCORE = 55
ANGLE_DE = {
    "Succession sale": "Wer ein Unternehmen über {age} aufgebaut hat, denkt oft schon lange vor jeder Veränderung über das nächste Kapitel nach, und es hilft, die Optionen früh zu kennen.",
    "Secondary buyout (PE exit)": "Nach der bisherigen Haltedauer könnte jetzt ein guter Moment sein zu sehen, wonach strategische Käufer und andere Investoren heute suchen.",
    "Growth partner / minority stake": "Bei Ihrem Wachstum holen manche Eigentümer für den nächsten Schritt einen Partner an Bord, ohne die Kontrolle abzugeben.",
    "Ownership transition review": "Ein Führungswechsel ist oft ein guter Anlass, über die Pläne für die nächsten Jahre nachzudenken.",
    "Add-on acquisition programme": "Herzlichen Glückwunsch zur jüngsten Übernahme. Wir sehen mehrere Off-Market-Kandidaten, die zu einer Buy-and-Build-Strategie passen könnten.",
    "default": "Wir teilen regelmäßig mit Eigentümern, wonach Käufer in ihrer Branche suchen, ganz ohne Prozess.",
}
NUM_EN = {2: "Two", 3: "Three", 4: "Four", 5: "Five"}
NUM_DE = {2: "Zwei", 3: "Drei", 4: "Vier", 5: "Fünf"}
SOFT_DOOR = ("Nothing needs to change: some owners start with a growth partner or a minority stake, "
             "others simply want to understand their options for the next few years.")
SMALL_ASK = "Would a 20-minute confidential conversation be useful? No commitment, no documents."
# Mergero's rule: owners usually haven't considered selling, so a first touch never talks about selling or valuation.
FIRST_TOUCH_BANNED = re.compile(r"\b(sell\w*|sale|sales process|exit\w*|valuations?|m&a|verkauf\w*|bewertung\w*)\b", re.IGNORECASE)


def first_touch_issues(text: str) -> list[str]:
    return sorted({m.group(0).lower() for m in FIRST_TOUCH_BANNED.finditer(text or "")})

# Outreach sequences per company_id.
CAMPAIGNS: dict[int, dict] = {}


def _first_name(full_name: str) -> str:
    parts = (full_name or "").split()
    return parts[0] if parts else ""


def choose_channel(company: dict) -> dict:
    ownership = (company.get("ownership_type") or "").lower()
    region = company.get("region") or ""
    if ownership == "pe":
        return {"channel": "Email to investment partner", "tone": "Direct and deal-focused",
                "step_channels": ["Email", "Email", "Email", "Email"], "style": "pe"}
    if region == "DACH":
        return {"channel": "LinkedIn + phone", "tone": "Formal (Sie), brief, buyer-demand-led",
                "step_channels": ["LinkedIn", "Phone", "Email", "Email"], "style": "dach"}
    return {"channel": "Email + LinkedIn", "tone": "Direct and short, buyer-demand-led, 20-minute ask",
            "step_channels": ["Email", "Email", "LinkedIn", "Email"], "style": "nordic"}


def _greeting(style: str, contact: str) -> str:
    if style == "dach":
        return f"Guten Tag {contact}," if contact else "Guten Tag,"
    first = _first_name(contact)
    return f"Hi {first}," if first else "Hi,"


def _dach_bodies(company: dict, hypothesis: dict, greet: str, buyers: int) -> list[tuple[str, str]]:
    name = company.get("legal_name") or company.get("company_name") or "Ihr Unternehmen"
    founded = company.get("founded_year")
    age = f"{date.today().year - founded} Jahre" if founded else "viele Jahre"
    angle = ANGLE_DE.get(hypothesis.get("mandate_type"), ANGLE_DE["default"]).format(age=age)
    if buyers == 1:
        buyer_line = f"Ein Käufer aus unserem Netzwerk sucht derzeit gezielt nach Unternehmen wie {name}."
    elif buyers:
        buyer_line = f"{NUM_DE.get(buyers, buyers)} Käufer aus unserem Netzwerk suchen derzeit gezielt nach Unternehmen wie {name}."
    else:
        buyer_line = f"Käufer aus unserem Netzwerk suchen derzeit aktiv nach Unternehmen in Ihrer Branche, und {name} ist uns aufgefallen."
    return [
        ("LinkedIn-Nachricht", f"{greet}\n\n{buyer_line} {angle}\n\n"
                               "Hätten Sie Zeit für ein vertrauliches Gespräch von 20 Minuten? Ganz unverbindlich."),
        ("Telefonleitfaden (60 Sekunden)", "Kurz vorstellen (Mergero) und auf die LinkedIn-Nachricht Bezug nehmen.\n"
                                           f"Aufhänger: {buyer_line}\n"
                                           f"Eine Frage: Wie sehen Ihre Pläne für {name} in den nächsten Jahren aus?\n"
                                           "Ziel: ein vertrauliches Gespräch von 20 Minuten vereinbaren."),
        (f"{name}: Käuferinteresse", f"{greet}\n\nich hatte Ihnen kürzlich auf LinkedIn geschrieben. Ich habe eine kurze, anonymisierte "
                                     "Übersicht zusammengestellt, wonach Käufer bei Unternehmen wie Ihrem derzeit suchen. "
                                     "Soll ich sie Ihnen unverbindlich zusenden?"),
        ("Abschluss", f"{greet}\n\nich möchte Ihr Postfach nicht überfüllen, daher ist dies vorerst meine letzte Nachricht. "
                      "Wenn der Zeitpunkt später besser passt, antworten Sie einfach."),
    ]


def _bodies(company: dict, hypothesis: dict, style: str, contact: str) -> list[tuple[str, str]]:
    name = company.get("legal_name") or company.get("company_name") or "your company"
    sector = company.get("sector") or "your sector"
    angle = hypothesis["owner_angle"]
    greet = _greeting(style, contact)
    buyers = sum(1 for b in hypothesis.get("suggested_buyers") or [] if (b.get("score") or 0) >= FITTING_BUYER_SCORE)
    if style == "dach":
        return _dach_bodies(company, hypothesis, greet, buyers)

    if style == "pe":
        if buyers == 1:
            buyer_line = "We currently hold an active buyer mandate that fits companies like this."
        elif buyers:
            buyer_line = f"We currently hold {buyers} active buyer mandates that fit companies like this."
        else:
            buyer_line = ""
        opener = (f"{greet}\n\nI'm reaching out about {name}. {angle}\n\n"
                  f"{buyer_line} We run off-market processes across the Nordics and DACH.\n\n"
                  "Would a short call on exit routes and what buyers are paying today be useful?")
        return [
            (f"{name}: buyer interest", opener),
            ("Following up", f"{greet}\n\nFollowing up on my note about {name}. Happy to share which buyer types are most active right now."),
            ("Recent transactions", f"{greet}\n\nI put together a short, anonymised view of recent {sector} transactions. Happy to share it."),
            ("Closing the loop", f"{greet}\n\nThis is my last note for now. If the timing is better later, just reply."),
        ]

    if buyers == 1:
        buyer_line = f"A buyer in our network is currently looking for companies like {name}."
    elif buyers:
        buyer_line = f"{NUM_EN.get(buyers, buyers)} buyers in our network are currently looking for companies like {name}."
    else:
        buyer_line = f"Buyers in our network are actively looking at {sector} companies in the Nordics, and {name} stood out."
    soft_door = "" if hypothesis.get("mandate_type") == "Growth partner / minority stake" else f"{SOFT_DOOR}\n\n"
    opener = f"{greet}\n\n{buyer_line} {angle}\n\n{soft_door}{SMALL_ASK}"
    return [
        (f"Buyer interest in companies like {name}", opener),
        ("A quick follow-up", f"{greet}\n\nA quick follow-up on my note about {name}. The buyers we work with tend to move early, "
                              "often a year or two before an owner decides anything, so an early conversation keeps every option open.\n\n"
                              "Happy to work around your calendar."),
        ("LinkedIn note", f"{greet} I put together a short, anonymised view of what buyers are looking for in {sector} right now. "
                          "Happy to share it, no strings attached."),
        ("Closing the loop", f"{greet}\n\nI don't want to crowd your inbox, so this is my last note for now. "
                             "If the timing is better later, just reply and we'll pick it up."),
    ]


def plan_outreach(record: dict, hypothesis: dict, scored: dict | None = None, use_llm: bool = False) -> dict:
    company = record.get("company") or {}
    choice = choose_channel(company)
    contact = company.get("owner_name") or company.get("ceo_name") or ""
    if choice["style"] == "pe":
        contact = company.get("ceo_name") or ""
    owner_facing = choice["style"] != "pe"

    sequence = []
    for i, ((subject, body), day, channel) in enumerate(zip(_bodies(company, hypothesis, choice["style"], contact), SEQUENCE_DAYS, choice["step_channels"])):
        source = "template"
        if use_llm and i == 0:
            rewritten, source = llm.rewrite(
                "Personalise this first outreach message to a company owner. Keep it under 120 words, warm and specific, "
                "in the same language. Open with the buyer demand. Never mention selling, a sale, an exit or a valuation: "
                "the owner has probably not considered selling. Keep the 20-minute confidential conversation as the ask. "
                "Never mention scores, ratings or internal analysis.", body)
            if owner_facing and first_touch_issues(rewritten):
                source = "template"
            else:
                body = rewritten
        sequence.append({"step": i, "day": day, "channel": channel, "subject": subject, "body": body,
                         "status": "drafted", "sent_at": None, "source": source})

    return {"channel": choice["channel"], "tone": choice["tone"], "contact_name": contact,
            "sequence": sequence, "stopped": False, "stop_reason": None}


def save_campaign(company_id: int, plan: dict) -> dict:
    CAMPAIGNS[company_id] = plan
    return plan


def send_step(company_id: int, step: int) -> dict:
    """Simulated send: marks the step as sent. Nothing leaves the system."""
    campaign = CAMPAIGNS.get(company_id)
    if not campaign:
        raise KeyError("No outreach sequence yet")
    if campaign["stopped"]:
        raise ValueError(f"Sequence stopped: {campaign['stop_reason']}")
    if not 0 <= step < len(campaign["sequence"]):
        raise IndexError("Unknown step")
    entry = campaign["sequence"][step]
    entry["status"] = "sent"
    entry["sent_at"] = datetime.now(timezone.utc).isoformat()
    return entry


def update_step(company_id: int, step: int, body: str) -> dict:
    entry = CAMPAIGNS[company_id]["sequence"][step]
    entry["body"] = body
    return entry


def stop_campaign(company_id: int, reason: str) -> None:
    campaign = CAMPAIGNS.get(company_id)
    if not campaign:
        return
    campaign["stopped"] = True
    campaign["stop_reason"] = reason
    for entry in campaign["sequence"]:
        if entry["status"] == "drafted":
            entry["status"] = "cancelled"
