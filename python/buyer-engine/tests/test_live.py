import os

import pytest

from scraper import scrape_company_profile
from sources import registry
from sources.signals import detect_web_signals

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("RUN_LIVE") != "1", reason="set RUN_LIVE=1 to call real external services"),
]


def test_prh_lookup_matrix42():
    result = registry.lookup_fi(business_id="1509667-4")
    assert result["status"] == "ok"
    assert result["legal_name"] == "Matrix42 Oy"
    assert any(p["name"] == "Efecte Oy" for p in result["previous_names"])


def test_prh_lookup_by_name():
    result = registry.lookup_fi(name="Futurice Oy")
    assert result["status"] == "ok"
    assert result["business_id"] == "1623507-4"


def test_real_website_scrape_and_signals():
    profile = scrape_company_profile("https://www.futurice.com")
    assert profile["fetched"]
    assert profile["page_text_excerpt"]
    assert isinstance(detect_web_signals(profile["page_text_excerpt"], profile["source_url"]), list)
