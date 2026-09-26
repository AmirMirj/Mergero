from datetime import date, timedelta

import pytest

from engine.signal_engine import BASE, SIDE, decay, detect_triggers

TODAY = date(2026, 9, 26)


def rec(company=None, signals=None):
    return {"company": company or {}, "signals": signals or []}


def sig(kind, days_ago, headline="x"):
    return {"signal_type": kind, "date": (TODAY - timedelta(days=days_ago)).isoformat(), "headline": headline, "source": "test"}


def test_recency_half_life():
    fresh = detect_triggers(rec(signals=[sig("succession", 0)]), TODAY)[0]
    old = detect_triggers(rec(signals=[sig("succession", 365)]), TODAY)[0]
    assert fresh["strength"] == pytest.approx(BASE["succession"])
    assert old["strength"] == pytest.approx(fresh["strength"] / 2, rel=0.01)
    assert decay(730) == pytest.approx(0.25)


def test_triggers_sorted_strongest_first():
    triggers = detect_triggers(rec(signals=[sig("growth", 10), sig("succession", 10)]), TODAY)
    assert [t["type"] for t in triggers] == ["succession", "growth"]


def test_derived_succession_for_old_family_firm_only():
    old_family = detect_triggers(rec({"ownership_type": "family", "founded_year": 1975}), TODAY)
    assert [t["type"] for t in old_family] == ["derived_succession"]
    assert "1975" in old_family[0]["evidence"]

    young_founder = detect_triggers(rec({"ownership_type": "founder", "founded_year": 2015}), TODAY)
    assert young_founder == []

    old_pe = detect_triggers(rec({"ownership_type": "pe", "founded_year": 1975}), TODAY)
    assert old_pe == []


def test_pe_exit_window_after_four_years():
    pe = {"ownership_type": "pe"}
    long_hold = detect_triggers(rec(pe, [sig("ownership_change", 365 * 5)]), TODAY)
    assert "pe_exit" in [t["type"] for t in long_hold]
    short_hold = detect_triggers(rec(pe, [sig("ownership_change", 365 * 2)]), TODAY)
    assert "pe_exit" not in [t["type"] for t in short_hold]


def test_growth_plus_capital_need_derives_growth_capital():
    triggers = detect_triggers(rec(signals=[sig("growth", 30), sig("capital_need", 30)]), TODAY)
    assert "growth_capital" in [t["type"] for t in triggers]


def test_side_mapping():
    assert SIDE["succession"] == "sell" and SIDE["pe_exit"] == "sell" and SIDE["capital_need"] == "sell"
    assert SIDE["acquisition"] == "buy"
    assert SIDE["growth"] == "either"
    t = detect_triggers(rec(signals=[sig("acquisition", 5)]), TODAY)[0]
    assert t["side"] == "buy"
