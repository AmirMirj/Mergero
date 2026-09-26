import re
from datetime import date

import requests

from sources import COUNTRY_NAMES, record, registry
from sources.buyers import load_buyers
from sources.companies import get_company, load_companies
from sources.record import build_record, to_profile
from sources.signals import SIGNAL_TYPES, _load_csv, detect_web_signals, signals_for

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------- seed datasets ----------

def test_seed_companies_load_with_types():
    companies = load_companies()
    assert len(companies) >= 30
    ids = [c["company_id"] for c in companies]
    assert len(ids) == len(set(ids))
    for c in companies:
        assert c["country"] in COUNTRY_NAMES
        assert c["data_origin"] in ("real", "illustrative")
        assert c["ebitda_eur"] is None or isinstance(c["ebitda_eur"], int)
        if c["data_origin"] == "illustrative":
            assert isinstance(c["ebitda_eur"], int) and c["ebitda_eur"] > 0


def test_real_companies_carry_no_invented_figures():
    for c in load_companies():
        if c["data_origin"] == "real":
            assert c["business_id"], c["company_name"]
            assert c["ebitda_eur"] is None and c["revenue_eur"] is None
            assert not signals_for(c["company_id"]), f"{c['company_name']} should only get live signals"


def test_signals_reference_known_companies():
    known = {c["company_id"] for c in load_companies()}
    rows = _load_csv()
    assert rows
    for s in rows:
        assert s["company_id"] in known
        assert s["signal_type"] in SIGNAL_TYPES
        assert ISO_DATE.match(s["date"]), s
        date.fromisoformat(s["date"])
        assert s["headline"] and s["source"]


def test_buyers_still_load():
    buyers = load_buyers()
    assert len(buyers) == 6
    assert all(isinstance(b["min_ebitda_eur"], int) for b in buyers)


def test_get_company_unknown_is_none():
    assert get_company(99999) is None


# ---------- web signal detection ----------

def test_detects_founding_acquisition_and_ceo():
    text = (
        "Founded in 1987 in Tampere, we build automation systems. "
        "In March the group has acquired Nordic Sensors AB. "
        "The board appointed Maria Svensson as the new CEO of the company."
    )
    found = {s["signal_type"]: s for s in detect_web_signals(text, "https://example.com")}
    assert set(found) == {"succession", "acquisition", "management_change"}
    assert "1987" in found["succession"]["headline"]
    assert "acquired" in found["acquisition"]["evidence"]
    assert all(s["source"] == "Company website" and s["url"] == "https://example.com" for s in found.values())


def test_young_company_is_not_a_succession_signal():
    year = date.today().year - 5
    assert detect_web_signals(f"Established in {year}, we are a fast-growing start-up.") == []


def test_neutral_text_has_no_signals():
    assert detect_web_signals("We make great software for accountants and their clients.") == []
    assert detect_web_signals("") == []


# ---------- registry client ----------

def test_lookup_fi_parses_prh(monkeypatch, prh_payload, fake_response):
    calls = []

    def fake_get(url, params=None, timeout=None):
        calls.append(params)
        return fake_response(prh_payload)

    monkeypatch.setattr(registry.requests, "get", fake_get)
    result = registry.lookup_fi(business_id="1509667-4")
    assert result["status"] == "ok"
    assert result["legal_name"] == "Matrix42 Oy"
    assert result["founded_year"] == 1998
    assert result["city"] == "Espoo"
    assert result["industry"] == "Computer programming activities"
    assert result["company_form"] == "Limited company"
    assert result["previous_names"][0]["name"] == "Efecte Oy"

    registry.lookup_fi(business_id="1509667-4")
    assert len(calls) == 1, "second lookup should come from the cache"


def test_lookup_fi_unavailable_on_timeout(monkeypatch):
    def boom(*args, **kwargs):
        raise requests.Timeout("slow")

    monkeypatch.setattr(registry.requests, "get", boom)
    assert registry.lookup_fi(business_id="1509667-4") == {"status": "unavailable"}


def test_lookup_fi_not_found(monkeypatch, fake_response):
    monkeypatch.setattr(registry.requests, "get", lambda *a, **k: fake_response({"totalResults": 0, "companies": []}))
    assert registry.lookup_fi(name="No Such Company Oy")["status"] == "not_found"


def test_recent_rename_becomes_ownership_signal(prh_payload):
    parsed = {"status": "ok", **registry.parse_company(prh_payload["companies"][0])}
    signals = registry.registry_signals(parsed)
    assert len(signals) == 1
    assert signals[0]["signal_type"] == "ownership_change"
    assert "Efecte Oy" in signals[0]["headline"] and "Matrix42 Oy" in signals[0]["headline"]


# ---------- record builder ----------

def _fake_site(sector_verified=True, text="Established in 1990. We're hiring engineers."):
    return {
        "fetched": True,
        "verified": sector_verified,
        "sector": "SaaS & Cloud Software",
        "products": "B2B cloud subscriptions & software",
        "customers": "Businesses and enterprises",
        "evidence": ["saas", "cloud"],
        "source_url": "https://www.matrix42.com",
        "geographic_hint": "finland europe",
        "page_text_excerpt": text,
    }


def test_build_record_without_enrich_uses_seed_only():
    rec = build_record(get_company(5))
    assert rec["sources_used"] == ["seed", "signals"]
    assert rec["provenance"]["ebitda_eur"] == "seed"
    assert rec["registry"] is None and rec["website"] is None
    assert len(rec["signals"]) == 2


def test_build_record_enrich_merges_sources_with_provenance(monkeypatch, prh_payload):
    parsed = {"status": "ok", **registry.parse_company(prh_payload["companies"][0])}
    monkeypatch.setattr(record, "lookup_fi", lambda **kw: parsed)
    monkeypatch.setattr(record, "scrape_company_profile", lambda url: _fake_site())

    rec = build_record(get_company(33), enrich=True)
    assert rec["sources_used"] == ["seed", "signals", "registry", "website"]
    p = rec["provenance"]
    assert p["company_name"] == "seed" and p["sector"] == "seed"
    assert p["legal_name"] == "registry" and p["founded_year"] == "registry" and p["city"] == "registry"
    assert p["website_sector"] == "website" and p["geographic_hint"] == "website"
    assert rec["company"]["founded_year"] == 1998
    types = sorted(s["signal_type"] for s in rec["signals"])
    assert types == ["growth", "ownership_change", "succession"]
    assert "page_text_excerpt" not in rec["website"]

    again = build_record(get_company(33))
    assert again["provenance"]["legal_name"] == "registry", "enrichment should persist for later reads"
    assert len(again["signals"]) == 3


def test_enrich_twice_does_not_duplicate_signals(monkeypatch):
    monkeypatch.setattr(record, "lookup_fi", lambda **kw: {"status": "unavailable"})
    monkeypatch.setattr(record, "scrape_company_profile", lambda url: _fake_site())
    first = build_record(get_company(34), enrich=True)
    second = build_record(get_company(34), enrich=True)
    assert len(first["new_signals"]) == 2
    assert second["new_signals"] == []
    assert len(second["signals"]) == 2


def test_seed_values_kept_when_live_sources_are_empty(monkeypatch):
    monkeypatch.setattr(record, "lookup_fi", lambda **kw: {"status": "unavailable"})
    monkeypatch.setattr(record, "scrape_company_profile", lambda url: {"fetched": False, "verified": False})
    company = get_company(38)
    rec = build_record(company, enrich=True)
    assert rec["sources_used"] == ["seed"]
    assert rec["company"]["sector"] == company["sector"]
    assert rec["provenance"]["sector"] == "seed"
    assert rec["provenance"]["business_id"] == "seed"


def test_to_profile_is_scoreable():
    profile = to_profile(build_record(get_company(5)))
    assert profile["company_name"] == "Pohjan Kierrätys Oy"
    assert profile["ebitda"] == "€9.1M"
    assert "finland" in profile["geographic_hint"]
    assert profile["company_id"] == 5
