from datetime import date, datetime, timedelta, timezone

from . import llm
from .outreach_agent import stop_campaign

CRM_STAGES = ["Prospect", "Contacted", "Replied", "Qualified", "Advisor handoff", "Mandate"]
# Mergero's own mandate path: first touch, reply, warm-up, first advisor call, engagement letter after 2-4 meetings.
STAGE_LABELS = {
    "Prospect": "Not contacted",
    "Contacted": "First touch sent",
    "Replied": "Owner replied",
    "Qualified": "Warm-up",
    "Advisor handoff": "First call booked",
    "Mandate": "Engagement letter signed",
}
CATEGORIES = ["interested_now", "interested_later", "needs_advisor", "not_interested", "unsubscribe"]
CATEGORY_LABELS = {
    "interested_now": "Interested now",
    "interested_later": "Interested later",
    "needs_advisor": "Needs an advisor",
    "not_interested": "Not interested",
    "unsubscribe": "Unsubscribe",
}
TIMINGS = ["now", "3-6 months", "6-12 months", "12+ months", "unknown"]
TIMING_RULES = [
    ("now", ["this week", "next week", "this month", "asap", "tällä viikolla", "ensi viikolla", "diese woche",
             "nächste woche", "denna vecka", "nästa vecka"]),
    ("3-6 months", ["next quarter", "in a few months", "after the summer", "syksyllä", "muutaman kuukauden",
                    "nach dem sommer", "in ein paar monaten", "efter sommaren"]),
    ("6-12 months", ["next year", "ensi vuonna", "nächstes jahr", "nästa år"]),
    ("12+ months", ["in two years", "a few years", "parin vuoden", "in ein paar jahren", "om några år"]),
]
DEFAULT_TIMING = {"interested_now": "now", "interested_later": "6-12 months"}
FOLLOW_UP_DAYS = {"now": 14, "3-6 months": 90, "6-12 months": 180, "12+ months": 365}
LIKELIHOOD_BASE = {"interested_now": 70, "needs_advisor": 55, "interested_later": 35, "not_interested": 5, "unsubscribe": 0}
POTENTIAL_MANDATE_AT = 50

# Checked in this order, so "not interested" wins over "interested".
RULES = [
    ("unsubscribe", ["unsubscribe", "remove me", "stop emailing", "do not contact", "abmelden", "keine weiteren e-mails",
                     "älä lähetä", "avregistrera", "sluta mejla"]),
    ("not_interested", ["not interested", "no thanks", "no thank you", "not for sale", "ei kiitos", "ei kiinnosta",
                        "emme ole myymässä", "kein interesse", "nicht interessiert", "nicht zu verkaufen",
                        "inte intresserad", "nej tack"]),
    ("interested_later", ["next quarter", "next year", "not right now", "not now", "in a few months", "after the summer",
                          "later this year", "ensi vuonna", "myöhemmin", "nächstes jahr", "später", "nästa år", "senare"]),
    ("needs_advisor", ["call me", "give me a call", "ring me", "speak to an advisor", "talk to someone", "by phone",
                       "soita", "rufen sie mich an", "ring mig", "our cfo", "our lawyer"]),
    ("interested_now", ["happy to talk", "happy to meet", "let's meet", "lets meet", "sounds good", "coffee", "interested",
                        "tell me more", "kiinnostaa", "sopii", "gerne", "interessiert", "intresserad", "gärna"]),
]
NEXT_ACTION = {
    "interested_now": "Book the first call with an advisor this week",
    "interested_later": "Pause the sequence and follow up on the scheduled date",
    "needs_advisor": "An advisor calls the owner within 24 hours",
    "not_interested": "Close politely; revisit only if a new trigger appears",
    "unsubscribe": "Remove from all outreach",
}

SAMPLE_REPLIES = {
    "interested_now": "Thanks for reaching out, happy to talk. Coffee next Tuesday works for me.",
    "interested_later": "Interesting, but not right now. Let's pick this up next year.",
    "needs_advisor": "I'd rather discuss this by phone, please call me on Thursday.",
    "not_interested": "Ei kiitos, emme ole myymässä yritystä.",
    "unsubscribe": "Bitte abmelden, keine weiteren E-Mails.",
}

# Conversation state per company_id.
CONVERSATIONS: dict[int, dict] = {}


def get_conversation(company_id: int) -> dict:
    return CONVERSATIONS.setdefault(company_id, {
        "stage": "Prospect", "thread": [], "follow_up_on": None, "closed": False, "outcome": None,
        "last_category": None, "last_qualification": None, "handoff": None,
    })


def advance(conversation: dict, stage: str) -> None:
    if CRM_STAGES.index(stage) > CRM_STAGES.index(conversation["stage"]):
        conversation["stage"] = stage


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def extract_timing(text: str) -> str:
    lowered = (text or "").lower()
    for timing, phrases in TIMING_RULES:
        if any(p in lowered for p in phrases):
            return timing
    return "unknown"


def mandate_likelihood(category: str, timing: str, prospect_score: int | None) -> int:
    value = LIKELIHOOD_BASE[category]
    if prospect_score is not None:
        value += (prospect_score - 50) / 5
    if timing == "now":
        value += 10
    elif timing == "12+ months":
        value -= 10
    if category == "unsubscribe":
        value = 0
    return int(round(max(0, min(100, value))))


def _classify(text: str, use_llm: bool) -> dict:
    if use_llm:
        result = llm.classify(text, CATEGORIES, timings=TIMINGS)
        if result:
            return {"category": result["category"], "confidence": 0.9, "timing": result.get("timing"),
                    "reason": result["reason"] or "Classified by the language model", "source": "llm"}
    lowered = (text or "").lower()
    for category, phrases in RULES:
        hit = next((p for p in phrases if p in lowered), None)
        if hit:
            return {"category": category, "confidence": 0.8, "timing": None,
                    "reason": f"Reply contains \"{hit}\"", "source": "rules"}
    return {"category": "needs_advisor", "confidence": 0.3, "timing": None,
            "reason": "No clear pattern, so a person should read it", "source": "rules"}


def qualify_reply(text: str, prospect_score: int | None = None, mandate_type: str | None = None, use_llm: bool = False) -> dict:
    """Answer the three qualification questions: interested? timing? potential mandate?"""
    result = _classify(text, use_llm)
    category = result["category"]
    timing = result["timing"] if result["timing"] in TIMINGS else extract_timing(text)
    if timing == "unknown":
        timing = DEFAULT_TIMING.get(category, "unknown")
    likelihood = mandate_likelihood(category, timing, prospect_score)
    return {
        **result,
        "label": CATEGORY_LABELS[category],
        "timing": timing,
        "mandate_likelihood": likelihood,
        "potential_mandate": likelihood >= POTENTIAL_MANDATE_AT,
        "mandate_type": mandate_type,
        "next_action": NEXT_ACTION[category],
    }


def record_outbound(company_id: int, entry: dict) -> dict:
    conversation = get_conversation(company_id)
    conversation["thread"].append({"direction": "out", "at": entry.get("sent_at") or _now(), "channel": entry.get("channel"),
                                   "subject": entry.get("subject"), "text": entry.get("body")})
    advance(conversation, "Contacted")
    return conversation


def record_reply(company_id: int, text: str, use_llm: bool = False, today: date | None = None,
                 prospect_score: int | None = None, mandate_type: str | None = None) -> dict:
    conversation = get_conversation(company_id)
    qualification = qualify_reply(text, prospect_score=prospect_score, mandate_type=mandate_type, use_llm=use_llm)
    conversation["thread"].append({"direction": "in", "at": _now(), "text": text, "qualification": qualification})
    conversation["last_category"] = qualification["category"]
    conversation["last_qualification"] = qualification
    advance(conversation, "Replied")

    category = qualification["category"]
    if category in ("interested_now", "needs_advisor"):
        advance(conversation, "Qualified")
    elif category == "interested_later":
        days = FOLLOW_UP_DAYS.get(qualification["timing"], FOLLOW_UP_DAYS["6-12 months"])
        conversation["follow_up_on"] = ((today or date.today()) + timedelta(days=days)).isoformat()
        stop_campaign(company_id, "Owner asked to reconnect later")
    else:
        conversation["closed"] = True
        conversation["outcome"] = category
        stop_campaign(company_id, CATEGORY_LABELS[category])
    return {"conversation": conversation, "qualification": qualification}


def handoff(company_id: int, advisor: str, package: dict) -> dict:
    conversation = get_conversation(company_id)
    category = conversation.get("last_category")
    bundle = {
        **package,
        "advisor": advisor,
        "thread": list(conversation["thread"]),
        "suggested_next_action": NEXT_ACTION.get(category) or "Call the owner to open the conversation",
        "handed_off_at": _now(),
    }
    conversation["handoff"] = bundle
    advance(conversation, "Advisor handoff")
    return bundle


def mark_mandate(company_id: int) -> dict:
    conversation = get_conversation(company_id)
    advance(conversation, "Mandate")
    conversation["outcome"] = "mandate"
    return conversation


# Drawer step each action belongs to: 5 Outreach, 6 Qualification, 7 Handoff and mandate.
def _action(key: str, label: str, step: int) -> dict:
    return {"key": key, "label": label, "step": step}


def _due_step(campaign: dict, today: date) -> dict | None:
    """The next drafted message, if its day in the sequence has arrived."""
    drafted = next((s for s in campaign["sequence"] if s["status"] == "drafted"), None)
    if not drafted:
        return None
    first_sent = next((s["sent_at"] for s in campaign["sequence"] if s["status"] == "sent" and s["sent_at"]), None)
    if drafted["day"] == 0 or not first_sent:
        return drafted
    start = datetime.fromisoformat(first_sent).date()
    return drafted if (today - start).days >= drafted["day"] else None


def next_action(conversation: dict, campaign: dict | None, today: date | None = None) -> dict:
    """The single thing to do next for a prospect."""
    today = today or date.today()
    stage = conversation["stage"]
    if stage == "Mandate":
        return _action("done", "Mandate won", 7)
    if conversation["closed"]:
        return _action("closed", "Closed", 6)
    if stage == "Advisor handoff":
        return _action("mandate", "Engagement letter signed", 7)
    if stage == "Qualified":
        return _action("handoff", "Book first call with advisor", 7)
    if conversation.get("follow_up_on"):
        if date.fromisoformat(conversation["follow_up_on"]) <= today:
            return _action("follow_up", "Follow up with the owner", 5)
        return _action("wait", f"Follow up on {conversation['follow_up_on']}", 6)
    if not campaign:
        return _action("plan", "Plan outreach", 5)
    due = None if campaign["stopped"] else _due_step(campaign, today)
    if due:
        label = "Send first message" if due["day"] == 0 else f"Send day-{due['day']} follow-up"
        return {**_action("send", label, 5), "message_step": due["step"]}
    return _action("log_reply", "Log owner reply", 6)


def funnel(company_ids: list[int]) -> dict:
    def reached(stage: str) -> int:
        idx = CRM_STAGES.index(stage)
        return sum(1 for cid in company_ids if CRM_STAGES.index(CONVERSATIONS.get(cid, {}).get("stage", "Prospect")) >= idx)

    return {
        "prospects": len(company_ids),
        "contacted": reached("Contacted"),
        "replied": reached("Replied"),
        "qualified": reached("Qualified"),
        "handed_off": reached("Advisor handoff"),
        "mandates": reached("Mandate"),
    }
