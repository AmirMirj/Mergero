import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from sources import record as record_module
from sources.companies import load_companies

LIVE_WORKERS = 4

# Latest ingested record per company_id, and a history of ingestion runs.
PROFILES: dict[int, dict] = {}
RUNS: list[dict] = []


def has_live_source(company: dict) -> bool:
    return company.get("country") == "FI" or bool(company.get("website"))


def _ingest_one(company: dict, live: bool) -> tuple[dict, dict | None]:
    enrich = live and has_live_source(company)
    try:
        rec = record_module.build_record(company, enrich=enrich)
    except Exception as exc:
        return {"company_id": company["company_id"], "company_name": company["company_name"], "status": "failed", "error": str(exc)}, None
    if not enrich:
        status = "ok"
    elif {"registry", "website"} & set(rec["sources_used"]):
        status = "enriched"
    else:
        status = "unavailable"
    return {
        "company_id": company["company_id"],
        "company_name": company["company_name"],
        "status": status,
        "new_signals": len(rec.get("new_signals") or []),
        "sources_used": rec["sources_used"],
    }, rec


def run_ingestion(live: bool = False) -> dict:
    started = time.time()
    started_at = datetime.now(timezone.utc).isoformat()
    companies = load_companies()
    if live:
        with ThreadPoolExecutor(max_workers=LIVE_WORKERS) as pool:
            results = list(pool.map(lambda c: _ingest_one(c, True), companies))
    else:
        results = [_ingest_one(c, False) for c in companies]

    statuses = []
    for status, rec in results:
        statuses.append(status)
        if rec is not None:
            PROFILES[status["company_id"]] = rec

    run = {
        "run_id": len(RUNS) + 1,
        "mode": "live" if live else "seed",
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "duration_s": round(time.time() - started, 2),
        "processed": len(statuses),
        "enriched": sum(1 for s in statuses if s["status"] == "enriched"),
        "failed": sum(1 for s in statuses if s["status"] in ("failed", "unavailable")),
        "new_signals": sum(s.get("new_signals", 0) for s in statuses),
        "companies": statuses,
    }
    RUNS.append(run)
    return run


def ensure_profiles() -> dict[int, dict]:
    if not PROFILES:
        run_ingestion(live=False)
    return PROFILES


def refresh_profile(company_id: int, rec: dict) -> None:
    PROFILES[company_id] = rec
