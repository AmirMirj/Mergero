from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import sys

# Vercel imports this file as `src.main`, so sibling modules are not on the path by default.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from scraper import scrape_company_profile
from matcher import rank_buyers, summarize_matches
from outreach import STAGES, ic_note, owner_warmup, sell_side_warmup
from sources import registry
from sources.buyers import load_buyers
from sources.companies import get_company, load_companies
from sources.record import build_record, to_profile
from sources.signals import SIGNAL_LABELS, SIGNAL_TYPES, LIVE_SIGNALS, load_signals, signals_for
from engine import crm, ingest, llm, outreach_agent
from engine.hypothesis import build_hypothesis
from engine.scoring import rank_prospects, score_prospect
from engine.signal_engine import detect_triggers

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"
# Vercel's filesystem is read-only except /tmp.
LOG_DIR = Path("/tmp") if os.environ.get("VERCEL") else DATA_DIR
DIALOGUES_PATH = LOG_DIR / "dialogues.jsonl"

app = FastAPI(title="Mergero Mandate Origination Desk")

MATCHES: list[dict] = []
NEXT_MATCH_ID = 1

TARGETS_DB = [
    {
        "id": 1,
        "company": "Nordic Cloud Oy",
        "region": "Nordics",
        "channel": "Email",
        "ceo": "Mikael Lindström",
        "revenue_split": "85% SaaS ARR, 15% Custom Dev",
        "top_clients": "Top 3 clients account for 42% of ARR",
        "valuation_est": "€4.2M",
        "status": "Ready for Warm-Up",
    },
    {
        "id": 2,
        "company": "Bavarian Logistics IT GmbH",
        "region": "DACH",
        "channel": "LinkedIn / Call",
        "ceo": "Stefan Weber",
        "revenue_split": "70% Enterprise Software, 30% Maintenance",
        "top_clients": "Diversified industrial base",
        "valuation_est": "€5.0M",
        "status": "Ready for Warm-Up",
    },
    {
        "id": 3,
        "company": "Savonia Solutions AB",
        "region": "Nordics",
        "channel": "Email",
        "ceo": "Elina Virtanen",
        "revenue_split": "90% Recurring Cloud Subscriptions",
        "top_clients": "Top 5 clients account for 30% of revenue",
        "valuation_est": "€3.8M",
        "status": "Ready for Warm-Up",
    },
]
NEXT_TARGET_ID = 4


def scrape_public(target: str) -> dict:
    profile = scrape_company_profile(target)
    profile.pop("page_text_excerpt", None)
    profile.pop("page_texts", None)
    return profile


def log_dialogue(event: str, payload: dict) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **payload,
    }
    with DIALOGUES_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def dialogue_count() -> int:
    if not DIALOGUES_PATH.exists():
        return 0
    with DIALOGUES_PATH.open("r", encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def profile_mix(profile: dict) -> str:
    products = profile.get("products") if profile.get("products") != "Pending Analysis" else ""
    customers = profile.get("customers") if profile.get("customers") != "Pending Analysis" else ""
    if products and customers:
        return f"{products} / {customers}"
    return products or customers or "Not screened yet"


def advance_stage(deal: dict, minimum: str) -> None:
    if STAGES.index(minimum) > STAGES.index(deal.get("stage") or STAGES[0]):
        deal["stage"] = minimum


def serialize_match(deal: dict) -> dict:
    profile = deal.get("profile") or {}
    match = deal.get("match") or {}
    return {
        "id": deal["id"],
        "buyer": deal.get("buyer_name"),
        "buyer_id": deal.get("buyer_id"),
        "target": profile.get("company_name") or deal.get("target") or "Target",
        "mix": profile_mix(profile),
        "sector": profile.get("sector") or deal.get("sector") or "",
        "ebitda": profile.get("ebitda") or deal.get("ebitda") or "",
        "stage": deal.get("stage") or STAGES[0],
        "score": match.get("score"),
        "reasons": match.get("reasons") or [],
        "gaps": match.get("gaps") or [],
        "proposal": deal.get("proposal") or "",
        "owner_name": deal.get("owner_name") or "",
        "source_url": profile.get("source_url") or "",
        "verified": bool(profile.get("verified")),
        "evidence": profile.get("evidence") or [],
    }


@app.get("/")
def root():
    index = WEB_DIR / "index.html"
    if not index.exists():
        return JSONResponse({"error": "web/index.html missing"}, status_code=404)
    return FileResponse(index)


@app.get("/api/buyers")
def get_buyers():
    buyers = load_buyers()
    return {"status": "success", "count": len(buyers), "data": buyers}


@app.get("/api/deals")
def get_deals():
    return {"status": "success", "count": len(MATCHES), "data": [serialize_match(d) for d in MATCHES]}


@app.post("/api/deals")
async def create_deal(request: Request):
    global NEXT_MATCH_ID
    body = await request.json()
    buyer_name = (body.get("buyer") or body.get("buyer_name") or "").strip()
    target = (body.get("target") or "").strip()
    if not buyer_name or not target:
        return JSONResponse({"status": "error", "message": "buyer and target are required"}, status_code=400)
    buyers = load_buyers()
    buyer = next((b for b in buyers if b["buyer_name"].lower() == buyer_name.lower()), None)
    profile = {
        "company_name": target,
        "sector": body.get("sector") or (buyer["target_sector"] if buyer else "Unverified Sector"),
        "products": body.get("products") or "Pending Analysis",
        "customers": body.get("customers") or "Pending Analysis",
        "ebitda": body.get("ebitda") or "Pending Audit",
        "verified": False,
        "source_url": body.get("source_url") or "",
        "geographic_hint": buyer["geographic_focus"] if buyer else "",
    }
    match = None
    if buyer:
        ranked = rank_buyers([buyer], profile)
        match = ranked[0] if ranked else None
    deal = {
        "id": NEXT_MATCH_ID,
        "buyer_id": buyer["id"] if buyer else None,
        "buyer_name": buyer_name,
        "profile": profile,
        "match": match or {},
        "stage": STAGES[0],
        "proposal": ic_note(buyer_name, profile, match),
    }
    NEXT_MATCH_ID += 1
    MATCHES.insert(0, deal)
    log_dialogue("deal_created", {"buyer": buyer_name, "company": target, "score": (match or {}).get("score"), "stage": deal["stage"]})
    return {"status": "success", "data": serialize_match(deal)}


@app.patch("/api/deals/{deal_id}")
async def patch_deal(deal_id: int, request: Request):
    body = await request.json()
    deal = next((d for d in MATCHES if d["id"] == deal_id), None)
    if not deal:
        return JSONResponse({"status": "error", "message": "Deal not found"}, status_code=404)
    stage = body.get("stage")
    if stage:
        if stage not in STAGES:
            return JSONResponse({"status": "error", "message": f"Invalid stage. Use: {STAGES}"}, status_code=400)
        deal["stage"] = stage
    if "proposal" in body:
        deal["proposal"] = body["proposal"] or ""
    if "owner_name" in body:
        deal["owner_name"] = (body["owner_name"] or "").strip()
        if deal["owner_name"]:
            advance_stage(deal, "Owner identified")
    log_dialogue("stage_updated", {"id": deal_id, "buyer": deal.get("buyer_name"), "company": deal["profile"].get("company_name"), "stage": deal["stage"]})
    return {"status": "success", "data": serialize_match(deal)}


@app.delete("/api/deals/{deal_id}")
def delete_deal(deal_id: int):
    global MATCHES
    before = len(MATCHES)
    MATCHES = [d for d in MATCHES if d["id"] != deal_id]
    if len(MATCHES) == before:
        return JSONResponse({"status": "error", "message": "Deal not found"}, status_code=404)
    return {"status": "success"}


@app.post("/api/scrape")
async def scrape_target(request: Request):
    body = await request.json()
    url = body.get("url")
    if not url:
        return {"status": "error", "message": "No URL provided"}
    scraped_data = scrape_public(url)
    log_dialogue("scrape", {"company": scraped_data.get("company_name"), "source_url": scraped_data.get("source_url")})
    return {"status": "success", "data": scraped_data}


@app.post("/api/match")
async def match_profile(request: Request):
    body = await request.json()
    profile = body.get("profile") or {}
    if body.get("url") and not profile.get("company_name"):
        profile = scrape_public(body["url"])
        log_dialogue("scrape", {"company": profile.get("company_name"), "source_url": profile.get("source_url")})
    if not profile:
        return JSONResponse({"status": "error", "message": "profile or url required"}, status_code=400)
    ranked = rank_buyers(load_buyers(), profile)
    log_dialogue(
        "match",
        {
            "company": profile.get("company_name"),
            "score": ranked[0]["score"] if ranked else None,
            "buyer": ranked[0]["buyer_name"] if ranked else None,
        },
    )
    return {"status": "success", "profile": profile, "matches": ranked, "stats": summarize_matches(ranked)}


@app.post("/api/deals/from-match")
async def deal_from_match(request: Request):
    global NEXT_MATCH_ID
    body = await request.json()
    profile = body.get("profile") or {}
    buyer_id = body.get("buyer_id")
    buyers = load_buyers()
    buyer = next((b for b in buyers if b["id"] == buyer_id), None)
    if not buyer:
        return JSONResponse({"status": "error", "message": "Unknown buyer_id"}, status_code=404)
    ranked = rank_buyers([buyer], profile)
    match = ranked[0] if ranked else {}
    proposal = ic_note(buyer["buyer_name"], profile, match)
    deal = {
        "id": NEXT_MATCH_ID,
        "buyer_id": buyer["id"],
        "buyer_name": buyer["buyer_name"],
        "profile": profile,
        "match": match,
        "stage": STAGES[0],
        "proposal": proposal,
    }
    NEXT_MATCH_ID += 1
    MATCHES.insert(0, deal)
    log_dialogue(
        "deal_from_match",
        {
            "buyer": buyer["buyer_name"],
            "company": profile.get("company_name"),
            "score": match.get("score"),
            "stage": deal["stage"],
        },
    )
    return {"status": "success", "data": serialize_match(deal)}


@app.post("/api/deals/{deal_id}/outreach")
async def generate_deal_outreach(deal_id: int, request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    deal = next((d for d in MATCHES if d["id"] == deal_id), None)
    if not deal:
        return JSONResponse({"status": "error", "message": "Deal not found"}, status_code=404)
    kind = (body.get("kind") or "ic").lower()
    profile = deal["profile"]
    match = deal.get("match") or {}
    if body.get("owner_name"):
        deal["owner_name"] = body["owner_name"].strip()
        advance_stage(deal, "Owner identified")
    if kind == "owner":
        message = owner_warmup(profile, match, ceo=deal.get("owner_name") or "there")
        advance_stage(deal, "Warm-up drafted")
    else:
        message = ic_note(deal["buyer_name"], profile, match)
    deal["proposal"] = message
    log_dialogue(
        "outreach",
        {
            "buyer": deal["buyer_name"],
            "company": profile.get("company_name"),
            "score": match.get("score"),
            "stage": deal["stage"],
            "message": message,
        },
    )
    return {"status": "success", "kind": kind, "outreach_message": message, "data": serialize_match(deal)}


@app.get("/api/targets")
def get_targets():
    return {"status": "success", "data": TARGETS_DB}


@app.post("/api/targets")
async def add_target(request: Request):
    global NEXT_TARGET_ID
    body = await request.json()
    profile = body.get("profile") or {}
    company = body.get("company") or profile.get("company_name")
    if not company:
        return JSONResponse({"status": "error", "message": "company required"}, status_code=400)
    hint = (profile.get("geographic_hint") or "").lower()
    region = body.get("region") or ("DACH" if any(k in hint for k in ["germany", "dach", "gmbh"]) else "Nordics")
    target = {
        "id": NEXT_TARGET_ID,
        "company": company,
        "region": region,
        "channel": body.get("channel") or "Email",
        "ceo": body.get("ceo") or "Owner",
        "revenue_split": profile_mix(profile) if profile else (body.get("revenue_split") or "Live scraped mix"),
        "top_clients": profile.get("customers") or body.get("top_clients") or "Pending owner confirmation",
        "valuation_est": body.get("valuation_est") or "€3–5M band",
        "status": "Ready for Warm-Up",
        "source_url": profile.get("source_url") or body.get("source_url") or "",
    }
    NEXT_TARGET_ID += 1
    TARGETS_DB.insert(0, target)
    log_dialogue("sell_side_target", {"company": company, "region": region})
    return {"status": "success", "data": target}


@app.post("/api/generate-outreach/{target_id}")
def generate_humanized_outreach(target_id: int):
    target = next((t for t in TARGETS_DB if t["id"] == target_id), None)
    if not target:
        return JSONResponse({"error": "Target not found"}, status_code=404)
    message = sell_side_warmup(target)
    target["status"] = "Warm-up drafted"
    log_dialogue("sell_side_outreach", {"company": target["company"], "channel": target["channel"], "message": message})
    return {"status": "success", "target": target["company"], "channel": target["channel"], "outreach_message": message}


def company_summary(company: dict) -> dict:
    signals = signals_for(company["company_id"])
    return {
        **company,
        "signal_count": len(signals),
        "signal_types": sorted({s["signal_type"] for s in signals}),
        "latest_signal": signals[0] if signals else None,
    }


@app.get("/api/sources")
def get_sources():
    companies = load_companies()
    signals = load_signals()
    with_website = sum(1 for c in companies if c.get("website"))
    finnish = sum(1 for c in companies if c.get("country") == "FI")
    return {
        "status": "success",
        "data": [
            {"key": "buyers", "name": "Buyer mandates", "type": "internal", "count": len(load_buyers()), "status": "loaded",
             "detail": "Active buy-side mandates and their criteria"},
            {"key": "companies", "name": "Company universe", "type": "internal", "count": len(companies), "status": "loaded",
             "detail": f"{sum(1 for c in companies if c.get('data_origin') == 'real')} real companies, "
                       f"{sum(1 for c in companies if c.get('data_origin') == 'illustrative')} illustrative"},
            {"key": "signals", "name": "External signals", "type": "public", "count": len(signals), "status": "loaded",
             "detail": f"{sum(len(v) for v in LIVE_SIGNALS.values())} detected live, the rest from the signals dataset"},
            {"key": "registry", "name": "Finnish Trade Register (PRH)", "type": "live", "count": finnish, "status": registry.ping(),
             "detail": "Free open API: legal name, registration date, industry, name history"},
            {"key": "website", "name": "Company websites", "type": "live", "count": with_website, "status": "on demand",
             "detail": "Polite crawl of the company's own site: robots.txt, sitemap, a few useful pages, sourced quotes"},
        ],
    }


@app.get("/api/companies")
def get_companies(country: str = "", sector: str = "", signal: str = ""):
    rows = [company_summary(c) for c in load_companies()]
    if country:
        rows = [r for r in rows if r["country"].lower() == country.lower()]
    if sector:
        rows = [r for r in rows if sector.lower() in (r.get("sector") or "").lower()]
    if signal:
        rows = [r for r in rows if signal in r["signal_types"]]
    return {
        "status": "success",
        "count": len(rows),
        "signal_types": [{"key": k, "label": SIGNAL_LABELS[k]} for k in SIGNAL_TYPES],
        "data": rows,
    }


@app.get("/api/companies/{company_id}")
def get_company_record(company_id: int):
    company = get_company(company_id)
    if not company:
        return JSONResponse({"status": "error", "message": "Company not found"}, status_code=404)
    record = build_record(company)
    return {"status": "success", "data": record, "profile": to_profile(record)}


@app.post("/api/companies/{company_id}/enrich")
def enrich_company(company_id: int):
    company = get_company(company_id)
    if not company:
        return JSONResponse({"status": "error", "message": "Company not found"}, status_code=404)
    record = build_record(company, enrich=True)
    if ingest.PROFILES:
        ingest.refresh_profile(company_id, record)
    log_dialogue(
        "enrich",
        {
            "company": company["company_name"],
            "sources_used": record["sources_used"],
            "new_signals": [s["headline"] for s in record["new_signals"]],
        },
    )
    return {"status": "success", "data": record, "profile": to_profile(record)}


# ---------- prospect engine (workflow steps 2-7) ----------

HYPOTHESES: dict[tuple, dict] = {}


async def read_json(request: Request) -> dict:
    try:
        return await request.json()
    except Exception:
        return {}


def prospect_bundle(company_id: int) -> dict | None:
    profiles = ingest.ensure_profiles()
    rec = profiles.get(company_id)
    if not rec:
        return None
    triggers = detect_triggers(rec)
    scored = score_prospect(rec, triggers, load_buyers())
    key = (company_id, triggers[0]["type"] if triggers else None, llm.enabled())
    if key not in HYPOTHESES:
        HYPOTHESES[key] = build_hypothesis(rec, triggers, scored, use_llm=llm.enabled())
    return {"record": rec, "triggers": triggers, "scored": scored, "hypothesis": HYPOTHESES[key]}


def prospect_detail(company_id: int, bundle: dict) -> dict:
    return {
        "company_id": company_id,
        "company": bundle["record"]["company"],
        "provenance": bundle["record"]["provenance"],
        "triggers": bundle["triggers"],
        "scored": bundle["scored"],
        "hypothesis": bundle["hypothesis"],
        "campaign": outreach_agent.CAMPAIGNS.get(company_id),
        "conversation": crm.get_conversation(company_id),
        "next_action": crm.next_action(crm.get_conversation(company_id), outreach_agent.CAMPAIGNS.get(company_id)),
        "stage_labels": [crm.STAGE_LABELS[s] for s in crm.CRM_STAGES],
    }


def not_found():
    return JSONResponse({"status": "error", "message": "Prospect not found"}, status_code=404)


@app.post("/api/ingest")
async def post_ingest(request: Request):
    body = await read_json(request)
    run = ingest.run_ingestion(live=bool(body.get("live")))
    HYPOTHESES.clear()
    log_dialogue("ingest", {k: run[k] for k in ("run_id", "mode", "processed", "enriched", "failed", "new_signals", "duration_s")})
    return {"status": "success", "data": run}


@app.get("/api/ingest/runs")
def get_ingest_runs():
    runs = [{k: v for k, v in run.items() if k != "companies"} for run in reversed(ingest.RUNS)]
    return {"status": "success", "count": len(runs), "data": runs}


@app.get("/api/prospects")
def get_prospects(tier: str = "", side: str = ""):
    rows = []
    for row in rank_prospects(ingest.ensure_profiles(), load_buyers()):
        top = row["triggers"][0] if row["triggers"] else None
        hyp = build_hypothesis(row["record"], row["triggers"], row["scored"])
        company = row["record"]["company"]
        conversation = crm.get_conversation(row["company_id"])
        rows.append({
            "company_id": row["company_id"],
            "company_name": company.get("legal_name") or company.get("company_name"),
            "country": company.get("country"),
            "country_name": company.get("country_name"),
            "sector": company.get("sector"),
            "data_origin": company.get("data_origin"),
            "score": row["scored"]["score"],
            "tier": row["scored"]["tier"],
            "timing": row["scored"]["timing"],
            "fit": row["scored"]["fit"],
            "urgency": row["scored"]["urgency"],
            "top_trigger": top,
            "top_buyer": (row["scored"].get("best_buyers") or [None])[0],
            "mandate_type": hyp["mandate_type"],
            "side": hyp["side"],
            "stage": conversation["stage"],
            "stage_label": crm.STAGE_LABELS[conversation["stage"]],
            "closed": conversation["closed"],
            "mandate_likelihood": (conversation.get("last_qualification") or {}).get("mandate_likelihood"),
            "timing": (conversation.get("last_qualification") or {}).get("timing"),
            "follow_up_on": conversation.get("follow_up_on"),
            "next_action": crm.next_action(conversation, outreach_agent.CAMPAIGNS.get(row["company_id"])),
        })
    if tier:
        rows = [r for r in rows if r["tier"] == tier.upper()]
    if side:
        rows = [r for r in rows if r["side"] == side.lower()]
    return {"status": "success", "count": len(rows), "llm": llm.enabled(), "data": rows}


@app.get("/api/prospects/{company_id}")
def get_prospect(company_id: int):
    bundle = prospect_bundle(company_id)
    if not bundle:
        return not_found()
    return {"status": "success", "data": prospect_detail(company_id, bundle)}


@app.post("/api/prospects/{company_id}/outreach")
def create_outreach(company_id: int):
    bundle = prospect_bundle(company_id)
    if not bundle:
        return not_found()
    if crm.get_conversation(company_id)["closed"]:
        return JSONResponse({"status": "error", "message": "Conversation is closed"}, status_code=409)
    plan = outreach_agent.plan_outreach(bundle["record"], bundle["hypothesis"], bundle["scored"], use_llm=llm.enabled())
    outreach_agent.save_campaign(company_id, plan)
    crm.get_conversation(company_id)["follow_up_on"] = None
    log_dialogue("outreach_plan", {"company_id": company_id, "channel": plan["channel"], "steps": len(plan["sequence"])})
    return {"status": "success", "data": prospect_detail(company_id, bundle)}


@app.patch("/api/prospects/{company_id}/outreach/{step}")
async def edit_outreach_step(company_id: int, step: int, request: Request):
    body = await read_json(request)
    campaign = outreach_agent.CAMPAIGNS.get(company_id)
    if not campaign or not 0 <= step < len(campaign["sequence"]):
        return not_found()
    outreach_agent.update_step(company_id, step, body.get("body") or "")
    return {"status": "success", "data": campaign["sequence"][step]}


@app.post("/api/prospects/{company_id}/outreach/{step}/send")
def send_outreach_step(company_id: int, step: int):
    bundle = prospect_bundle(company_id)
    if not bundle:
        return not_found()
    try:
        entry = outreach_agent.send_step(company_id, step)
    except KeyError as exc:
        return JSONResponse({"status": "error", "message": str(exc).strip("'")}, status_code=404)
    except IndexError as exc:
        return JSONResponse({"status": "error", "message": str(exc)}, status_code=404)
    except ValueError as exc:
        return JSONResponse({"status": "error", "message": str(exc)}, status_code=409)
    crm.record_outbound(company_id, entry)
    log_dialogue("outreach_sent", {"company_id": company_id, "step": step, "channel": entry["channel"], "simulated": True})
    return {"status": "success", "data": prospect_detail(company_id, bundle)}


@app.get("/api/prospects/{company_id}/sample-replies")
def get_sample_replies(company_id: int):
    if not prospect_bundle(company_id):
        return not_found()
    return {"status": "success", "data": [{"category": k, "label": crm.CATEGORY_LABELS[k], "text": v} for k, v in crm.SAMPLE_REPLIES.items()]}


@app.post("/api/prospects/{company_id}/replies")
async def post_reply(company_id: int, request: Request):
    bundle = prospect_bundle(company_id)
    if not bundle:
        return not_found()
    text = ((await read_json(request)).get("text") or "").strip()
    if not text:
        return JSONResponse({"status": "error", "message": "Reply text is required"}, status_code=400)
    result = crm.record_reply(
        company_id, text, use_llm=llm.enabled(),
        prospect_score=bundle["scored"]["score"], mandate_type=bundle["hypothesis"]["mandate_type"],
    )
    q = result["qualification"]
    log_dialogue("reply", {"company_id": company_id, "category": q["category"], "timing": q["timing"],
                           "mandate_likelihood": q["mandate_likelihood"], "stage": result["conversation"]["stage"]})
    return {"status": "success", "qualification": result["qualification"], "data": prospect_detail(company_id, bundle)}


@app.post("/api/prospects/{company_id}/handoff")
async def post_handoff(company_id: int, request: Request):
    bundle = prospect_bundle(company_id)
    if not bundle:
        return not_found()
    advisor = ((await read_json(request)).get("advisor") or "").strip() or "Mergero advisor"
    package = {
        "company": bundle["record"]["company"],
        "triggers": bundle["triggers"],
        "score": {k: bundle["scored"][k] for k in ("score", "tier", "timing", "fit", "urgency", "explanation")},
        "hypothesis": bundle["hypothesis"],
    }
    handoff = crm.handoff(company_id, advisor, package)
    log_dialogue("handoff", {"company_id": company_id, "advisor": advisor})
    return {"status": "success", "handoff": handoff, "data": prospect_detail(company_id, bundle)}


@app.post("/api/prospects/{company_id}/mandate")
def post_mandate(company_id: int):
    bundle = prospect_bundle(company_id)
    if not bundle:
        return not_found()
    crm.mark_mandate(company_id)
    log_dialogue("mandate", {"company_id": company_id})
    return {"status": "success", "data": prospect_detail(company_id, bundle)}


@app.get("/api/pipeline-summary")
def get_pipeline_summary():
    profiles = ingest.ensure_profiles()
    ranked = rank_prospects(profiles, load_buyers())
    tiers = {"A": 0, "B": 0, "C": 0}
    sides = {"sell": 0, "buy": 0}
    for row in ranked:
        tiers[row["scored"]["tier"]] += 1
        sides[build_hypothesis(row["record"], row["triggers"], row["scored"])["side"]] += 1
    campaigns = [outreach_agent.CAMPAIGNS[cid] for cid in profiles if cid in outreach_agent.CAMPAIGNS]
    qualifications = [
        q for cid in profiles
        for q in [(crm.CONVERSATIONS.get(cid) or {}).get("last_qualification")] if q
    ]
    funnel = crm.funnel(list(profiles.keys()))
    return {
        "status": "success",
        "data": {
            "data": {"companies": len(profiles), "signals": sum(len(r["record"].get("signals") or []) for r in ranked),
                     "runs": len(ingest.RUNS)},
            "signals": {"with_triggers": sum(1 for r in ranked if r["triggers"]),
                        "triggers": sum(len(r["triggers"]) for r in ranked)},
            "scoring": tiers,
            "hypothesis": sides,
            "outreach": {"sequences": len(campaigns),
                         "sent": sum(1 for c in campaigns for s in c["sequence"] if s["status"] == "sent")},
            "qualification": {"qualified": len(qualifications),
                              "potential_mandates": sum(1 for q in qualifications if q["potential_mandate"])},
            "handoff": {"handed_off": funnel["handed_off"], "mandates": funnel["mandates"]},
        },
    }


@app.post("/api/demo/reset")
def post_demo_reset():
    outreach_agent.CAMPAIGNS.clear()
    crm.CONVERSATIONS.clear()
    log_dialogue("demo_reset", {})
    return {"status": "success"}


@app.get("/api/funnel")
def get_funnel():
    return {"status": "success", "data": crm.funnel(list(ingest.ensure_profiles().keys()))}


@app.get("/api/dialogues")
def get_dialogues():
    count = dialogue_count()
    return {"status": "success", "count": count}


@app.get("/api/metrics")
def get_metrics():
    buyers = load_buyers()
    outreach_ready = sum(1 for d in MATCHES if d.get("stage") in ("Warm-up drafted", "Outreach ready", "Mandate conversation"))
    return {
        "status": "success",
        "buyers": len(buyers),
        "matches": len(MATCHES),
        "outreach_ready": outreach_ready,
        "dialogues": dialogue_count(),
    }


if WEB_DIR.exists():
    app.mount("/web", StaticFiles(directory=str(WEB_DIR)), name="web")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
