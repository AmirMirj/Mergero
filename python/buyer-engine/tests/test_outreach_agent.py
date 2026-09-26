import pytest

from engine import outreach_agent
from engine import llm
from engine.hypothesis import OWNER_ANGLE
from engine.outreach_agent import choose_channel, first_touch_issues, plan_outreach, save_campaign, send_step, stop_campaign

HYP = {"owner_angle": "Owners who have built a company over 40 years often start thinking about the next chapter.",
       "suggested_buyers": [{"buyer_name": "Kotera Group", "score": 88}, {"buyer_name": "CapMan", "score": 40}]}


def rec(**company):
    base = {"company_name": "Test Oy", "sector": "Industrial construction", "region": "Nordics",
            "ownership_type": "family", "owner_name": "Kari Kivikko", "ceo_name": "Jussi Kivikko"}
    base.update(company)
    return {"company": base}


def test_channel_rules():
    assert choose_channel(rec()["company"])["channel"] == "Email + LinkedIn"
    assert choose_channel(rec(region="DACH")["company"])["channel"] == "LinkedIn + phone"
    assert choose_channel(rec(ownership_type="pe", region="DACH")["company"])["channel"] == "Email to investment partner"


def test_sequence_shape():
    plan = plan_outreach(rec(), HYP)
    assert [s["day"] for s in plan["sequence"]] == [0, 4, 10, 21]
    assert [s["channel"] for s in plan["sequence"]] == ["Email", "Email", "LinkedIn", "Email"]
    assert all(s["status"] == "drafted" for s in plan["sequence"])
    assert plan["contact_name"] == "Kari Kivikko"


def test_first_message_has_why_now_and_no_scores():
    body = plan_outreach(rec(), HYP)["sequence"][0]["body"]
    assert HYP["owner_angle"] in body
    assert body.startswith("Hi Kari,")
    assert "score" not in body.lower() and "/100" not in body and "tier" not in body.lower()


def test_buyer_line_counts_only_fitting_buyers():
    body = plan_outreach(rec(), HYP)["sequence"][0]["body"]
    assert "A buyer in our network is currently looking for companies like Test Oy." in body
    weak = {**HYP, "suggested_buyers": [{"buyer_name": "CapMan", "score": 40}]}
    weak_body = plan_outreach(rec(), weak)["sequence"][0]["body"]
    assert "currently looking for companies like" not in weak_body
    assert "Buyers in our network are actively looking at Industrial construction companies" in weak_body


def test_dach_sequence_is_fully_german():
    hyp = {**HYP, "mandate_type": "Succession sale"}
    sequence = plan_outreach(rec(region="DACH", owner_name="Stefan Weber", founded_year=1996), hyp)["sequence"]
    body = sequence[0]["body"]
    assert body.startswith("Guten Tag Stefan Weber,") and "vertrauliches Gespräch von 20 Minuten" in body
    assert "30 Jahre" in body and "Ein Käufer aus unserem Netzwerk sucht" in body
    assert [s["channel"] for s in sequence] == ["LinkedIn", "Phone", "Email", "Email"]
    for step in sequence:
        assert "Owners" not in step["body"] and "We currently" not in step["body"] and "following up" not in step["body"].lower()


def test_send_marks_step_and_stop_blocks_sending():
    save_campaign(1, plan_outreach(rec(), HYP))
    entry = send_step(1, 0)
    assert entry["status"] == "sent" and entry["sent_at"]
    stop_campaign(1, "Not interested")
    assert outreach_agent.CAMPAIGNS[1]["sequence"][1]["status"] == "cancelled"
    with pytest.raises(ValueError):
        send_step(1, 1)
    with pytest.raises(KeyError):
        send_step(999, 0)


def test_first_touch_leads_with_demand_and_small_ask():
    body = plan_outreach(rec(), HYP)["sequence"][0]["body"]
    lines = [line for line in body.split("\n") if line.strip()]
    assert lines[1].startswith("A buyer in our network")
    assert "minority stake" in body and "20-minute confidential conversation" in body


@pytest.mark.parametrize("mandate", [m for m in OWNER_ANGLE if m != "Add-on acquisition programme"])
@pytest.mark.parametrize("region", ["Nordics", "DACH"])
def test_first_touch_never_talks_about_selling(mandate, region):
    hyp = {**HYP, "mandate_type": mandate, "owner_angle": OWNER_ANGLE[mandate].format(age="30 years")}
    for weak in (False, True):
        h = {**hyp, "suggested_buyers": []} if weak else hyp
        body = plan_outreach(rec(region=region, sector="Software & Technical wholesale", founded_year=1996), h)["sequence"][0]["body"]
        assert first_touch_issues(body) == [], body


def test_first_touch_issues_detects_banned_words():
    assert first_touch_issues("Thinking of selling? A quick valuation, then an exit.") == ["exit", "selling", "valuation"]
    assert first_touch_issues("Ein Verkauf und eine Bewertung") == ["bewertung", "verkauf"]
    assert first_touch_issues("We serve technical wholesale companies") == []


def test_llm_rewrite_that_mentions_selling_falls_back_to_template(monkeypatch):
    monkeypatch.setattr(llm, "rewrite", lambda instruction, text: ("Have you thought about selling your company?", "llm"))
    step = plan_outreach(rec(), HYP, use_llm=True)["sequence"][0]
    assert step["source"] == "template" and "selling" not in step["body"]
    monkeypatch.setattr(llm, "rewrite", lambda instruction, text: ("Hi Kari, buyers are looking at companies like yours.", "llm"))
    step = plan_outreach(rec(), HYP, use_llm=True)["sequence"][0]
    assert step["source"] == "llm" and step["body"].startswith("Hi Kari, buyers")
