import pytest
from fastapi.testclient import TestClient

import main
from sources import record, registry


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "LOG_DIR", tmp_path)
    monkeypatch.setattr(main, "DIALOGUES_PATH", tmp_path / "dialogues.jsonl")
    monkeypatch.setattr(registry, "ping", lambda: "live")
    return TestClient(main.app)


def test_sources_lists_five(client):
    res = client.get("/api/sources").json()
    keys = [s["key"] for s in res["data"]]
    assert keys == ["buyers", "companies", "signals", "registry", "website"]
    counts = {s["key"]: s["count"] for s in res["data"]}
    assert counts["buyers"] == 6 and counts["companies"] >= 30 and counts["signals"] > 0
    assert next(s for s in res["data"] if s["key"] == "registry")["status"] == "live"


def test_companies_signal_filter(client):
    res = client.get("/api/companies", params={"signal": "succession"}).json()
    assert res["count"] > 0
    assert all("succession" in c["signal_types"] for c in res["data"])
    assert {s["key"] for s in res["signal_types"]} >= {"succession", "growth"}


def test_companies_country_filter(client):
    res = client.get("/api/companies", params={"country": "de"}).json()
    assert res["count"] > 0 and all(c["country"] == "DE" for c in res["data"])


def test_company_record_and_404(client):
    res = client.get("/api/companies/5")
    assert res.status_code == 200
    body = res.json()
    assert body["data"]["company"]["company_name"] == "Pohjan Kierrätys Oy"
    assert body["profile"]["company_id"] == 5
    assert client.get("/api/companies/99999").status_code == 404
    assert client.post("/api/companies/99999/enrich").status_code == 404


def test_enrich_endpoint_with_mocks(client, monkeypatch, prh_payload):
    parsed = {"status": "ok", **registry.parse_company(prh_payload["companies"][0])}
    monkeypatch.setattr(record, "lookup_fi", lambda **kw: parsed)
    monkeypatch.setattr(record, "scrape_company_profile", lambda url: {
        "fetched": True, "verified": True, "sector": "SaaS & Cloud Software", "products": "x", "customers": "y",
        "evidence": ["saas"], "source_url": url, "geographic_hint": "finland", "page_text_excerpt": "We are hiring.",
    })
    res = client.post("/api/companies/33/enrich").json()
    assert res["data"]["sources_used"] == ["seed", "signals", "registry", "website"]
    assert {s["signal_type"] for s in res["data"]["new_signals"]} == {"ownership_change", "growth"}
    assert main.DIALOGUES_PATH.read_text().count('"event": "enrich"') == 1

    listed = client.get("/api/companies").json()["data"]
    assert next(c for c in listed if c["company_id"] == 33)["signal_count"] == 2


def test_screen_company_profile_against_buyers(client):
    profile = client.get("/api/companies/5").json()["profile"]
    res = client.post("/api/match", json={"profile": profile}).json()
    assert len(res["matches"]) == 6
    assert res["matches"][0]["buyer_name"] == "H.I.G. Capital"
    assert res["stats"]["n"] == 6 and res["stats"]["best"] == res["matches"][0]["score"]
    assert "parts" in res["matches"][0]


def test_existing_endpoints_unchanged(client):
    assert client.get("/api/buyers").json()["count"] == 6
    assert client.get("/").status_code == 200
    assert client.get("/api/metrics").json()["buyers"] == 6
