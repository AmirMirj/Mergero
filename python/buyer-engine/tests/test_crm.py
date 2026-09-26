from datetime import date, timedelta

import pytest

from engine import crm, llm, outreach_agent
from engine.crm import SAMPLE_REPLIES, funnel, get_conversation, handoff, qualify_reply, record_outbound, record_reply


@pytest.mark.parametrize("category", list(SAMPLE_REPLIES))
def test_sample_replies_classify_to_their_category(category):
    assert qualify_reply(SAMPLE_REPLIES[category])["category"] == category


@pytest.mark.parametrize("text,category", [
    ("Ei kiitos, ei kiinnosta.", "not_interested"),
    ("Kein Interesse, danke.", "not_interested"),
    ("Gerne, das klingt interessant.", "interested_now"),
    ("Vi är inte intresserade just nu.", "not_interested"),
    ("Please remove me from your list", "unsubscribe"),
    ("Maybe after the summer?", "interested_later"),
    ("Hmm.", "needs_advisor"),
])
def test_multilingual_rules(text, category):
    assert qualify_reply(text)["category"] == category


def test_interested_now_qualifies():
    record_outbound(1, {"channel": "Email", "subject": "s", "body": "b", "sent_at": "2026-09-26T10:00:00"})
    assert get_conversation(1)["stage"] == "Contacted"
    result = record_reply(1, SAMPLE_REPLIES["interested_now"])
    assert result["conversation"]["stage"] == "Qualified"
    assert [m["direction"] for m in result["conversation"]["thread"]] == ["out", "in"]


def test_interested_later_schedules_follow_up_from_timing():
    result = record_reply(2, SAMPLE_REPLIES["interested_later"], today=date(2026, 9, 26))
    assert result["conversation"]["stage"] == "Replied"
    assert result["qualification"]["timing"] == "6-12 months"
    assert result["conversation"]["follow_up_on"] == "2027-03-25"

    soon = record_reply(5, "Not right now, but after the summer works.", today=date(2026, 9, 26))
    assert soon["qualification"]["timing"] == "3-6 months"
    assert soon["conversation"]["follow_up_on"] == "2026-12-25"


@pytest.mark.parametrize("text,timing", [
    ("Could we meet next week?", "now"),
    ("Let's revisit after the summer.", "3-6 months"),
    ("Maybe next year.", "6-12 months"),
    ("Perhaps in two years.", "12+ months"),
    ("Palataan asiaan ensi vuonna.", "6-12 months"),
    ("Gerne, diese Woche passt.", "now"),
    ("Thanks for the note.", "unknown"),
])
def test_timing_extraction(text, timing):
    assert crm.extract_timing(text) == timing


def test_category_default_timing():
    assert qualify_reply(SAMPLE_REPLIES["interested_now"])["timing"] == "now"
    assert qualify_reply("Interesting, but not now.")["timing"] == "6-12 months"
    assert qualify_reply(SAMPLE_REPLIES["not_interested"])["timing"] == "unknown"


def test_likelihood_ordering_and_bounds():
    likelihood = {c: qualify_reply(t, prospect_score=60)["mandate_likelihood"] for c, t in SAMPLE_REPLIES.items()}
    assert likelihood["interested_now"] > likelihood["needs_advisor"] > likelihood["interested_later"] > likelihood["not_interested"]
    assert likelihood["unsubscribe"] == 0
    assert crm.mandate_likelihood("interested_now", "now", 100) == 90
    assert crm.mandate_likelihood("interested_now", "now", 1000) == 100
    assert crm.mandate_likelihood("not_interested", "12+ months", 0) == 0


def test_prospect_score_and_timing_move_likelihood():
    base = crm.mandate_likelihood("needs_advisor", "unknown", 50)
    assert crm.mandate_likelihood("needs_advisor", "unknown", 90) > base
    assert crm.mandate_likelihood("needs_advisor", "12+ months", 50) < base


def test_potential_mandate_threshold_and_type():
    hot = qualify_reply(SAMPLE_REPLIES["interested_now"], prospect_score=85, mandate_type="Succession sale")
    assert hot["potential_mandate"] is True and hot["mandate_likelihood"] >= 50
    assert hot["mandate_type"] == "Succession sale"
    cold = qualify_reply(SAMPLE_REPLIES["interested_later"], prospect_score=40)
    assert cold["potential_mandate"] is False and cold["mandate_likelihood"] < 50


def test_llm_invalid_timing_falls_back_to_rules(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setattr(llm, "_complete", lambda prompt, temperature=0: '{"category": "interested_later", "timing": "soonish", "reason": "r"}')
    q = qualify_reply("Let's revisit after the summer.", use_llm=True)
    assert q["source"] == "llm" and q["category"] == "interested_later" and q["timing"] == "3-6 months"
    monkeypatch.setattr(llm, "_complete", lambda prompt, temperature=0: '{"category": "interested_now", "timing": "12+ months", "reason": "r"}')
    assert qualify_reply("whatever", use_llm=True)["timing"] == "12+ months"


def test_not_interested_closes_and_stops_sequence():
    outreach_agent.save_campaign(3, {"sequence": [{"status": "sent"}, {"status": "drafted"}], "stopped": False, "stop_reason": None})
    result = record_reply(3, SAMPLE_REPLIES["not_interested"])
    assert result["conversation"]["closed"] and result["conversation"]["outcome"] == "not_interested"
    assert outreach_agent.CAMPAIGNS[3]["stopped"]
    assert outreach_agent.CAMPAIGNS[3]["sequence"][1]["status"] == "cancelled"


def test_handoff_package_and_stage():
    record_reply(4, SAMPLE_REPLIES["needs_advisor"])
    package = {"company": {"company_name": "X"}, "triggers": [], "score": {"score": 80}, "hypothesis": {"headline": "h"}}
    bundle = handoff(4, "Anna Advisor", package)
    for key in ("company", "triggers", "score", "hypothesis", "thread", "advisor", "suggested_next_action"):
        assert key in bundle
    assert bundle["suggested_next_action"] == crm.NEXT_ACTION["needs_advisor"]
    assert get_conversation(4)["stage"] == "Advisor handoff"


def test_funnel_counts():
    record_outbound(1, {"channel": "Email"})
    record_outbound(2, {"channel": "Email"})
    record_reply(2, SAMPLE_REPLIES["interested_now"])
    handoff(2, "A", {})
    crm.mark_mandate(2)
    assert funnel([1, 2, 3]) == {"prospects": 3, "contacted": 2, "replied": 1, "qualified": 1, "handed_off": 1, "mandates": 1}


def test_llm_classification_used_and_validated(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setattr(llm, "_complete", lambda prompt, temperature=0: '{"category": "interested_later", "reason": "Q1"}')
    assert qualify_reply("whatever", use_llm=True)["source"] == "llm"
    monkeypatch.setattr(llm, "_complete", lambda prompt, temperature=0: '{"category": "maybe", "reason": "?"}')
    result = qualify_reply(SAMPLE_REPLIES["interested_now"], use_llm=True)
    assert result["source"] == "rules" and result["category"] == "interested_now"


def _campaign(sent_days_ago=None, sent_steps=0, stopped=False):
    sent_at = (date(2026, 9, 26) - timedelta(days=sent_days_ago)).isoformat() + "T09:00:00+00:00" if sent_days_ago is not None else None
    sequence = [{"step": i, "day": day, "status": "sent" if i < sent_steps else "drafted", "sent_at": sent_at if i < sent_steps else None}
                for i, day in enumerate([0, 4, 10, 21])]
    return {"sequence": sequence, "stopped": stopped}


def _conv(**overrides):
    return {"stage": "Prospect", "closed": False, "follow_up_on": None, **overrides}


TODAY = date(2026, 9, 26)


def test_next_action_without_campaign_is_plan():
    assert crm.next_action(_conv(), None, TODAY) == {"key": "plan", "label": "Plan outreach", "step": 5}


def test_next_action_sends_first_message_then_waits_for_day_four():
    first = crm.next_action(_conv(), _campaign(), TODAY)
    assert first["key"] == "send" and first["label"] == "Send first message" and first["message_step"] == 0
    assert crm.next_action(_conv(stage="Contacted"), _campaign(sent_days_ago=1, sent_steps=1), TODAY)["key"] == "log_reply"
    due = crm.next_action(_conv(stage="Contacted"), _campaign(sent_days_ago=5, sent_steps=1), TODAY)
    assert due["key"] == "send" and due["label"] == "Send day-4 follow-up" and due["message_step"] == 1


def test_next_action_after_sequence_or_stop_is_log_reply():
    assert crm.next_action(_conv(stage="Contacted"), _campaign(sent_days_ago=30, sent_steps=4), TODAY)["key"] == "log_reply"
    assert crm.next_action(_conv(stage="Contacted"), _campaign(stopped=True), TODAY)["key"] == "log_reply"


def test_next_action_follow_up_due_and_not_yet_due():
    later = crm.next_action(_conv(stage="Replied", follow_up_on="2027-03-25"), _campaign(stopped=True), TODAY)
    assert later["key"] == "wait" and "2027-03-25" in later["label"]
    due = crm.next_action(_conv(stage="Replied", follow_up_on="2026-09-01"), _campaign(stopped=True), TODAY)
    assert due["key"] == "follow_up" and due["step"] == 5


@pytest.mark.parametrize("conv,key,step", [
    (_conv(stage="Qualified"), "handoff", 7),
    (_conv(stage="Advisor handoff"), "mandate", 7),
    (_conv(stage="Mandate"), "done", 7),
    (_conv(stage="Replied", closed=True), "closed", 6),
])
def test_next_action_late_stages(conv, key, step):
    action = crm.next_action(conv, _campaign(sent_days_ago=2, sent_steps=1), TODAY)
    assert action["key"] == key and action["step"] == step
