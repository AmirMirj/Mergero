from engine import ingest
from sources import record


def test_seed_run_processes_everything():
    run = ingest.run_ingestion()
    assert run["mode"] == "seed"
    assert run["processed"] == 40 and run["failed"] == 0 and run["enriched"] == 0
    assert len(ingest.PROFILES) == 40
    assert all(c["status"] == "ok" for c in run["companies"])


def test_live_run_counts_enriched_and_failed(monkeypatch):
    def fake_build(company, enrich=False):
        if not enrich:
            return {"company": company, "signals": [], "provenance": {}, "sources_used": ["seed"], "new_signals": []}
        if company["company_id"] == 33:
            raise RuntimeError("boom")
        if company["company_id"] == 34:
            return {"company": company, "signals": [], "provenance": {}, "sources_used": ["seed"], "new_signals": []}
        return {"company": company, "signals": [], "provenance": {}, "sources_used": ["seed", "registry"],
                "new_signals": [{"signal_type": "growth"}]}

    monkeypatch.setattr(record, "build_record", fake_build)
    run = ingest.run_ingestion(live=True)
    by_id = {c["company_id"]: c["status"] for c in run["companies"]}
    live_ids = [cid for cid, status in by_id.items() if status != "ok"]
    assert by_id[33] == "failed" and by_id[34] == "unavailable"
    assert run["failed"] == 2
    assert run["enriched"] == len(live_ids) - 2
    assert run["new_signals"] == run["enriched"]
    assert 33 not in ingest.PROFILES, "a failed company keeps no fresh profile"
    assert by_id[2] == "ok", "a German company without a website has no live source to enrich from"


def test_runs_accumulate_and_ensure_profiles_is_lazy():
    assert ingest.ensure_profiles() and len(ingest.RUNS) == 1
    ingest.ensure_profiles()
    assert len(ingest.RUNS) == 1, "ensure_profiles only ingests once"
    ingest.run_ingestion()
    assert [r["run_id"] for r in ingest.RUNS] == [1, 2]
