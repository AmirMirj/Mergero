from matcher import score_buyer, summarize_matches


BUYER = {
    "id": 1, "buyer_name": "Kotera Group", "target_sector": "Industrial construction",
    "geographic_focus": "Nordics", "min_ebitda_eur": 5_000_000, "max_ebitda_eur": 20_000_000,
}


def profile(**overrides):
    base = {
        "sector": "Industrial construction", "products": "Industrial construction & contracting",
        "geographic_hint": "finland nordic", "ebitda": "€9.0M", "verified": True,
    }
    base.update(overrides)
    return base


def test_strong_match_has_three_yes_checks():
    m = score_buyer(BUYER, profile())
    assert m["score"] >= 75 and m["verdict"] == "strong"
    assert m["checks"]["sector"]["ok"] == "yes"
    assert m["checks"]["region"]["ok"] == "yes"
    assert m["checks"]["size"]["ok"] == "yes"
    assert "same kind of company" in m["summary"].lower()
    assert "in their region" in m["summary"].lower()
    assert "right size" in m["summary"].lower()
    assert m["axes"]["sector"] >= 70 and m["axes"]["region"] == 100 and m["axes"]["size"] == 100
    assert m["company_ebitda_eur"] == 9_000_000
    assert m["parts"]["sector"] + m["parts"]["region"] + m["parts"]["size"] + m["parts"]["verified"] == m["score"]


def test_wrong_sector_and_missing_size_are_explained():
    m = score_buyer(BUYER, profile(sector="Food & Beverage", products="snacks", ebitda="Confidential / NDA"))
    assert m["checks"]["sector"]["ok"] == "no"
    assert m["checks"]["size"]["ok"] == "unknown"
    assert "different sector" in m["summary"].lower()
    assert "size not public" in m["summary"].lower()
    assert m["verdict"] in ("possible", "weak")


def test_far_outside_size_band():
    m = score_buyer(BUYER, profile(ebitda="€80M"))
    assert m["checks"]["size"]["ok"] == "no"
    assert "outside their size range" in m["summary"].lower()


def test_summarize_matches_flags_a_standout():
    ranked = [
        {"score": 90, "verdict": "strong"},
        {"score": 52, "verdict": "weak"},
        {"score": 52, "verdict": "weak"},
        {"score": 48, "verdict": "weak"},
    ]
    s = summarize_matches(ranked)
    assert s["n"] == 4 and s["best"] == 90 and s["median"] == 52
    assert s["strong"] == 1 and s["weak"] == 3
    assert s["lift"] == 38
    assert s["scores"] == [90, 52, 52, 48]
    assert "stands out" in s["read"]


def test_summarize_matches_empty():
    assert summarize_matches([])["n"] == 0
