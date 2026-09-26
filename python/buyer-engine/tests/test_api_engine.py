import pytest
from fastapi.testclient import TestClient

import main
from sources import registry


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "LOG_DIR", tmp_path)
    monkeypatch.setattr(main, "DIALOGUES_PATH", tmp_path / "dialogues.jsonl")
    monkeypatch.setattr(registry, "ping", lambda: "live")
    main.HYPOTHESES.clear()
    return TestClient(main.app)


def test_full_path_from_ingest_to_mandate(client):
    run = client.post("/api/ingest", json={"live": False}).json()["data"]
    assert run["processed"] == 40 and run["failed"] == 0
    assert client.get("/api/ingest/runs").json()["count"] == 1

    prospects = client.get("/api/prospects").json()
    assert prospects["count"] == 40 and prospects["llm"] is False
    scores = [p["score"] for p in prospects["data"]]
    assert scores == sorted(scores, reverse=True)
    top = prospects["data"][0]
    assert top["tier"] == "A" and top["top_trigger"]
    cid = top["company_id"]

    detail = client.get(f"/api/prospects/{cid}").json()["data"]
    assert detail["hypothesis"]["why_now"] and detail["campaign"] is None
    assert detail["conversation"]["stage"] == "Prospect"

    detail = client.post(f"/api/prospects/{cid}/outreach").json()["data"]
    assert len(detail["campaign"]["sequence"]) == 4

    edited = client.patch(f"/api/prospects/{cid}/outreach/0", json={"body": "Edited body"}).json()["data"]
    assert edited["body"] == "Edited body"

    detail = client.post(f"/api/prospects/{cid}/outreach/0/send").json()["data"]
    assert detail["campaign"]["sequence"][0]["status"] == "sent"
    assert detail["conversation"]["stage"] == "Contacted"

    samples = client.get(f"/api/prospects/{cid}/sample-replies").json()["data"]
    reply_text = next(s["text"] for s in samples if s["category"] == "interested_now")
    res = client.post(f"/api/prospects/{cid}/replies", json={"text": reply_text}).json()
    q = res["qualification"]
    assert q["category"] == "interested_now"
    assert q["timing"] == "now" and q["potential_mandate"] is True and q["mandate_likelihood"] >= 70
    assert q["mandate_type"] == detail["hypothesis"]["mandate_type"]
    assert res["data"]["conversation"]["stage"] == "Qualified"
    listed = next(p for p in client.get("/api/prospects").json()["data"] if p["company_id"] == cid)
    assert listed["mandate_likelihood"] == q["mandate_likelihood"] and listed["timing"] == "now"

    res = client.post(f"/api/prospects/{cid}/handoff", json={"advisor": "Anna"}).json()
    assert res["handoff"]["advisor"] == "Anna" and res["handoff"]["hypothesis"]["headline"]
    assert res["data"]["conversation"]["stage"] == "Advisor handoff"

    client.post(f"/api/prospects/{cid}/mandate")
    funnel = client.get("/api/funnel").json()["data"]
    assert funnel == {"prospects": 40, "contacted": 1, "replied": 1, "qualified": 1, "handed_off": 1, "mandates": 1}

    logged = main.DIALOGUES_PATH.read_text()
    for event in ("ingest", "outreach_plan", "outreach_sent", "reply", "handoff", "mandate"):
        assert f'"event": "{event}"' in logged


def test_pipeline_summary_tracks_each_step(client):
    s = client.get("/api/pipeline-summary").json()["data"]
    assert set(s) == {"data", "signals", "scoring", "hypothesis", "outreach", "qualification", "handoff"}
    assert s["data"]["companies"] == 40 and s["data"]["signals"] > 0
    assert 0 < s["signals"]["with_triggers"] <= 40
    assert sum(s["scoring"].values()) == 40
    assert s["hypothesis"]["sell"] + s["hypothesis"]["buy"] == 40
    assert s["outreach"] == {"sequences": 0, "sent": 0}
    assert s["qualification"] == {"qualified": 0, "potential_mandates": 0}

    cid = client.get("/api/prospects").json()["data"][0]["company_id"]
    client.post(f"/api/prospects/{cid}/outreach")
    client.post(f"/api/prospects/{cid}/outreach/0/send")
    client.post(f"/api/prospects/{cid}/replies", json={"text": "Happy to talk, next week works."})
    client.post(f"/api/prospects/{cid}/handoff", json={"advisor": "A"})
    s = client.get("/api/pipeline-summary").json()["data"]
    assert s["outreach"] == {"sequences": 1, "sent": 1}
    assert s["qualification"] == {"qualified": 1, "potential_mandates": 1}
    assert s["handoff"] == {"handed_off": 1, "mandates": 0}


def test_not_interested_blocks_further_sends(client):
    cid = client.get("/api/prospects").json()["data"][0]["company_id"]
    client.post(f"/api/prospects/{cid}/outreach")
    client.post(f"/api/prospects/{cid}/replies", json={"text": "No thanks, not interested."})
    assert client.post(f"/api/prospects/{cid}/outreach/1/send").status_code == 409
    assert client.post(f"/api/prospects/{cid}/outreach").status_code == 409


def test_filters(client):
    rows = client.get("/api/prospects", params={"tier": "a"}).json()["data"]
    assert rows and all(r["tier"] == "A" for r in rows)
    rows = client.get("/api/prospects", params={"side": "sell"}).json()["data"]
    assert rows and all(r["side"] == "sell" for r in rows)


def test_unknown_ids(client):
    assert client.get("/api/prospects/9999").status_code == 404
    assert client.post("/api/prospects/9999/outreach").status_code == 404
    assert client.post("/api/prospects/9999/replies", json={"text": "hi"}).status_code == 404
    assert client.post("/api/prospects/9999/handoff", json={}).status_code == 404
    assert client.post("/api/prospects/1/outreach/0/send").status_code == 404, "no sequence yet"
    assert client.post("/api/prospects/1/replies", json={"text": ""}).status_code == 400


def test_existing_endpoints_unchanged(client):
    assert client.get("/api/buyers").json()["count"] == 6
    assert client.get("/api/companies").json()["count"] == 40
    assert client.get("/").status_code == 200


def _action(client, cid):
    return next(p for p in client.get("/api/prospects").json()["data"] if p["company_id"] == cid)["next_action"]


def test_next_action_moves_along_the_workflow(client):
    cid = client.get("/api/prospects").json()["data"][0]["company_id"]
    assert _action(client, cid)["key"] == "plan"
    detail = client.post(f"/api/prospects/{cid}/outreach").json()["data"]
    assert detail["next_action"]["key"] == "send"
    assert _action(client, cid) == {"key": "send", "label": "Send first message", "step": 5, "message_step": 0}
    client.post(f"/api/prospects/{cid}/outreach/0/send")
    assert _action(client, cid)["key"] == "log_reply"
    client.post(f"/api/prospects/{cid}/replies", json={"text": "Happy to talk next week."})
    assert _action(client, cid)["key"] == "handoff"
    client.post(f"/api/prospects/{cid}/handoff", json={})
    assert _action(client, cid) == {"key": "mandate", "label": "Engagement letter signed", "step": 7}
    row = next(p for p in client.get("/api/prospects").json()["data"] if p["company_id"] == cid)
    assert row["stage"] == "Advisor handoff" and row["stage_label"] == "First call booked"
    client.post(f"/api/prospects/{cid}/mandate")
    assert _action(client, cid)["key"] == "done"


def test_replanning_after_later_reply_clears_follow_up(client):
    cid = client.get("/api/prospects").json()["data"][1]["company_id"]
    client.post(f"/api/prospects/{cid}/outreach")
    client.post(f"/api/prospects/{cid}/outreach/0/send")
    client.post(f"/api/prospects/{cid}/replies", json={"text": "Not right now, maybe next year."})
    assert _action(client, cid)["key"] == "wait"
    detail = client.post(f"/api/prospects/{cid}/outreach").json()["data"]
    assert detail["conversation"]["follow_up_on"] is None and detail["next_action"]["key"] == "send"


def test_demo_reset_clears_campaigns_and_conversations(client):
    cid = client.get("/api/prospects").json()["data"][0]["company_id"]
    client.post(f"/api/prospects/{cid}/outreach")
    client.post(f"/api/prospects/{cid}/outreach/0/send")
    assert client.post("/api/demo/reset").json()["status"] == "success"
    s = client.get("/api/pipeline-summary").json()["data"]
    assert s["outreach"] == {"sequences": 0, "sent": 0} and s["handoff"] == {"handed_off": 0, "mandates": 0}
    assert _action(client, cid)["key"] == "plan"
