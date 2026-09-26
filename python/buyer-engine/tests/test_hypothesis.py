import pytest

from engine import hypothesis as hyp_module
from engine import llm
from engine.hypothesis import build_hypothesis

COMPANY = {"company_name": "Test Oy", "founded_year": 1980, "sector": "Industrial construction"}
SCORED = {"best_buyers": [{"buyer_id": 3, "buyer_name": "Kotera Group", "score": 88}], "ev_estimate": 30_000_000}


def trig(kind, label="Label", date="2026-05-01", evidence="evidence", side="sell"):
    return {"type": kind, "label": label, "strength": 0.9, "date": date, "age_days": 100, "evidence": evidence,
            "source": "t", "side": side}


@pytest.mark.parametrize("kind,mandate,side", [
    ("succession", "Succession sale", "sell"),
    ("derived_succession", "Succession sale", "sell"),
    ("pe_exit", "Secondary buyout (PE exit)", "sell"),
    ("capital_need", "Growth partner / minority stake", "sell"),
    ("growth_capital", "Growth partner / minority stake", "sell"),
    ("acquisition", "Add-on acquisition programme", "buy"),
])
def test_dominant_trigger_sets_mandate(kind, mandate, side):
    h = build_hypothesis({"company": COMPANY}, [trig(kind)], SCORED)
    assert h["mandate_type"] == mandate and h["side"] == side
    assert h["source"] == "template"


def test_no_trigger_is_relationship_build():
    h = build_hypothesis({"company": COMPANY}, [], SCORED)
    assert h["mandate_type"].startswith("Relationship build")
    assert h["why_now"] == []


def test_why_now_cites_dates_and_buyers_match_scoring():
    triggers = [trig("succession", "Succession", "2026-04-15", "Owner (66) mentioned retirement"),
                trig("acquisition", "Acquisition", "2025-09-30", "Bought a competitor", "buy")]
    h = build_hypothesis({"company": COMPANY}, triggers, SCORED)
    assert "2026-04-15" in h["why_now"][0] and "retirement" in h["why_now"][0]
    assert "2025-09-30" in h["why_now"][1]
    assert h["suggested_buyers"] == SCORED["best_buyers"]
    assert h["ev_range"] == "€24-36M"
    assert "46 years" in h["owner_angle"]


def test_unknown_ev_range():
    h = build_hypothesis({"company": COMPANY}, [], {"best_buyers": [], "ev_estimate": None})
    assert "Unknown" in h["ev_range"]


def test_llm_used_when_key_set(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setattr(llm, "_complete", lambda prompt, temperature=0.4: "Polished text")
    h = build_hypothesis({"company": COMPANY}, [trig("succession")], SCORED, use_llm=True)
    assert h["source"] == "llm" and h["headline"] == "Polished text"
    assert h["mandate_type"] == "Succession sale", "structured fields always come from the rules"


def test_llm_error_falls_back_to_template(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test")

    def boom(prompt, temperature=0.4):
        raise RuntimeError("api down")

    monkeypatch.setattr(llm, "_complete", boom)
    h = build_hypothesis({"company": COMPANY}, [trig("succession")], SCORED, use_llm=True)
    assert h["source"] == "template" and h["headline"].startswith("Succession sale for Test Oy")


def test_llm_off_without_key():
    assert llm.enabled() is False
    assert llm.rewrite("x", "draft") == ("draft", "template")
    assert llm.classify("hello", ["a"]) is None
    assert hyp_module.llm is llm
