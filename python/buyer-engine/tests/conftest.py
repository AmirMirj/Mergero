import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from engine import crm, ingest, outreach_agent  # noqa: E402
from sources import record, registry, signals  # noqa: E402

STATE = [signals.LIVE_SIGNALS, record.ENRICHMENTS, registry._CACHE, ingest.PROFILES, ingest.RUNS,
         outreach_agent.CAMPAIGNS, crm.CONVERSATIONS]


@pytest.fixture(autouse=True)
def clean_live_state(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    for store in STATE:
        store.clear()
    yield
    for store in STATE:
        store.clear()


class FakeResponse:
    def __init__(self, payload=None, status_code=200):
        self._payload = payload or {}
        self.status_code = status_code
        self.ok = status_code < 400

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(f"HTTP {self.status_code}")


PRH_MATRIX42 = {
    "totalResults": 1,
    "companies": [
        {
            "businessId": {"value": "1509667-4", "registrationDate": "1999-01-08"},
            "names": [
                {"name": "Matrix42 Oy", "type": "1", "registrationDate": "2025-05-12", "version": 1},
                {"name": "Efecte Oy", "type": "1", "registrationDate": "2024-12-13", "endDate": "2025-05-12", "version": 2},
                {"name": "Bitmount", "type": "3", "registrationDate": "2003-03-28", "version": 1},
            ],
            "mainBusinessLine": {"type": "62010", "descriptions": [
                {"languageCode": "3", "description": "Computer programming activities"},
                {"languageCode": "1", "description": "Ohjelmistojen suunnittelu ja valmistus"},
            ]},
            "companyForms": [{"type": "16", "descriptions": [{"languageCode": "3", "description": "Limited company"}]}],
            "addresses": [{"type": 1, "postOffices": [{"city": "ESPOO", "languageCode": "1"}]}],
            "registrationDate": "1998-12-29",
        }
    ],
}


@pytest.fixture
def prh_payload():
    return PRH_MATRIX42


@pytest.fixture
def fake_response():
    return FakeResponse
