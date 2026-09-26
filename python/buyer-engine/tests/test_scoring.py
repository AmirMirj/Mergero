from datetime import date, timedelta

from engine import ingest
from engine.scoring import TIER_A, TIER_B, floor_status, rank_prospects, score_prospect, tier_for
from engine.signal_engine import detect_triggers
from sources.buyers import load_buyers
from sources.companies import get_company
from sources.record import build_record

TODAY = date(2026, 9, 26)


def company(**overrides):
    base = {"company_id": 900, "company_name": "Test Oy", "country": "FI", "country_name": "Finland", "region": "Nordics",
            "sector": "Circular economy / Waste logistics", "ebitda_eur": 9_000_000, "ownership_type": "founder",
            "founded_year": 2010, "owner_name": "Aku Ankka", "ceo_name": "Aku Ankka"}
    base.update(overrides)
    return base


def record_for(comp, signals=()):
    return {"company": comp, "signals": list(signals), "provenance": {}, "sources_used": ["seed"]}


def test_components_within_caps():
    ingest.run_ingestion()
    for row in rank_prospects(ingest.PROFILES, load_buyers()):
        s = row["scored"]
        assert 0 <= s["timing"] <= 40 and 0 <= s["fit"] <= 35 and 0 <= s["urgency"] <= 25
        assert s["score"] == min(100, s["timing"] + s["fit"] + s["urgency"]) <= 100


def test_recent_succession_outranks_no_signals():
    buyers = load_buyers()
    hot = record_for(company(), [{"signal_type": "succession", "date": (TODAY - timedelta(days=20)).isoformat(),
                                  "headline": "Owner retiring", "source": "t"}])
    cold = record_for(company(company_id=901))
    hot_score = score_prospect(hot, detect_triggers(hot, TODAY), buyers)
    cold_score = score_prospect(cold, detect_triggers(cold, TODAY), buyers)
    assert hot_score["score"] > cold_score["score"]
    assert hot_score["urgency"] > cold_score["urgency"] == 0
    assert any("owner is still CEO" in line for line in hot_score["explanation"])


def test_tier_thresholds():
    assert tier_for(TIER_A) == "A" and tier_for(TIER_A - 1) == "B"
    assert tier_for(TIER_B) == "B" and tier_for(TIER_B - 1) == "C"


def test_unknown_ebitda_gets_no_band_points():
    rec = record_for(company(ebitda_eur=None))
    scored = score_prospect(rec, [], load_buyers())
    assert scored["ev_estimate"] is None and scored["in_band"] is False
    assert any("EBITDA unknown" in line for line in scored["explanation"])
    in_band = score_prospect(record_for(company()), [], load_buyers())
    assert in_band["in_band"] is True
    assert in_band["fit"] - scored["fit"] >= 10, "band points plus the buyer's EBITDA criterion"


def test_best_buyers_top_three_sorted():
    rec = build_record(get_company(5))
    scored = score_prospect(rec, detect_triggers(rec, TODAY), load_buyers())
    scores = [b["score"] for b in scored["best_buyers"]]
    assert len(scores) == 3 and scores == sorted(scores, reverse=True)
    assert scored["best_buyers"][0]["buyer_name"] == "H.I.G. Capital"
    top = scored["best_buyers"][0]
    assert set(top["axes"]) == {"sector", "region", "size"}
    assert all(0 <= top["axes"][k] <= 100 for k in top["axes"])
    assert "min_ebitda_eur" in top and "company_ebitda_eur" in top
    assert top["parts"]["sector"] >= 20
    assert scored["match_stats"]["n"] == 6 and scored["match_stats"]["best"] == top["score"]


def test_mergero_valuation_floor():
    assert floor_status(None) == "unknown"
    assert floor_status(2_900_000) == "below"
    assert floor_status(4_000_000) == "borderline"
    assert floor_status(5_000_000) == "above"
    assert floor_status(150_000_000) == "too_large"
    buyers = load_buyers()
    small = score_prospect(record_for(company(ebitda_eur=350_000)), [], buyers)
    borderline = score_prospect(record_for(company(ebitda_eur=600_000)), [], buyers)
    assert small["floor_check"] == "below" and small["in_band"] is False
    assert any("below Mergero's €3-5M minimum" in line for line in small["explanation"])
    assert borderline["floor_check"] == "borderline" and borderline["in_band"] is True
    assert any("borderline" in line for line in borderline["explanation"])
