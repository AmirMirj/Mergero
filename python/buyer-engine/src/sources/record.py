from datetime import datetime, timezone

from scraper import scrape_company_profile

from .registry import lookup_fi, registry_signals
from .signals import add_live_signals, detect_founded_year, detect_web_signals, signals_for

SEED_FIELDS = (
    "company_name", "country", "website", "business_id", "sector", "founded_year",
    "revenue_eur", "ebitda_eur", "employees", "ownership_type", "owner_name", "ceo_name",
)
REGISTRY_FIELDS = {
    "legal_name": "legal_name",
    "founded_year": "founded_year",
    "registered_on": "registered_on",
    "industry": "industry",
    "company_form": "company_form",
    "city": "city",
    "business_id": "business_id",
}

# Last live enrichment per company_id, so later reads show the enriched record without refetching.
ENRICHMENTS: dict[int, dict] = {}


def _empty(value) -> bool:
    return value is None or value == ""


def _enrich_live(company: dict) -> dict:
    registry = None
    if company.get("country") == "FI" and (company.get("business_id") or company.get("company_name")):
        registry = lookup_fi(business_id=company.get("business_id") or None, name=None if company.get("business_id") else company["company_name"])

    website = None
    if company.get("website"):
        website = scrape_company_profile(company["website"])

    new_signals = registry_signals(registry or {})
    excerpt = (website or {}).get("page_text_excerpt") or ""
    if website and website.get("fetched"):
        texts = website.get("page_texts") or []
        if texts:
            for page in texts:
                new_signals += detect_web_signals(page.get("text") or "", page.get("url") or website.get("source_url") or "")
                excerpt = excerpt or (page.get("text") or "")
        else:
            new_signals += detect_web_signals(excerpt, website.get("source_url") or "")
    if website:
        website = {k: v for k, v in website.items() if k not in ("page_texts", "page_text_excerpt")}
    added = add_live_signals(company["company_id"], new_signals)

    enrichment = {
        "registry": registry,
        "website": website or None,
        "website_founded_year": detect_founded_year(excerpt) if website else None,
        "new_signals": added,
        "enriched_at": datetime.now(timezone.utc).isoformat(),
    }
    ENRICHMENTS[company["company_id"]] = enrichment
    return enrichment


def build_record(company: dict, enrich: bool = False) -> dict:
    merged = dict(company)
    provenance = {field: "seed" for field in SEED_FIELDS if not _empty(company.get(field))}
    sources_used = ["seed"]

    enrichment = _enrich_live(company) if enrich else ENRICHMENTS.get(company["company_id"])
    registry = (enrichment or {}).get("registry") or {}
    website = (enrichment or {}).get("website") or {}

    if registry.get("status") == "ok":
        sources_used.append("registry")
        for target, key in REGISTRY_FIELDS.items():
            if not _empty(registry.get(key)):
                merged[target] = registry[key]
                provenance[target] = "registry"

    if website.get("fetched"):
        sources_used.append("website")
        if _empty(merged.get("founded_year")) and enrichment.get("website_founded_year"):
            merged["founded_year"] = enrichment["website_founded_year"]
            provenance["founded_year"] = "website"
        if website.get("verified"):
            merged["website_sector"] = website.get("sector")
            merged["products"] = website.get("products")
            merged["customers"] = website.get("customers")
            merged["evidence"] = website.get("evidence") or []
            provenance.update(website_sector="website", products="website", customers="website")
            if _empty(merged.get("sector")):
                merged["sector"] = website.get("sector")
                provenance["sector"] = "website"
        if website.get("geographic_hint"):
            merged["geographic_hint"] = website["geographic_hint"]
            provenance["geographic_hint"] = "website"
        if _empty(merged.get("business_id")):
            fi = next((i["value"] for i in website.get("business_ids") or [] if i.get("type") == "FI_YTUNNUS"), None)
            if fi:
                merged["business_id"] = fi
                provenance["business_id"] = "website"

    signals = signals_for(company["company_id"])
    if signals:
        sources_used.insert(1, "signals")

    return {
        "company": merged,
        "signals": signals,
        "provenance": provenance,
        "sources_used": sources_used,
        "registry": registry or None,
        "website": website or None,
        "enriched_at": (enrichment or {}).get("enriched_at"),
        "new_signals": (enrichment or {}).get("new_signals", []) if enrich else [],
    }


def to_profile(record: dict) -> dict:
    """Shape a company record like a scraper profile so the existing buyer matcher can score it."""
    company = record["company"]
    ebitda = company.get("ebitda_eur")
    geo = " ".join(filter(None, [company.get("country_name", "").lower(), company.get("region", "").lower(), company.get("geographic_hint", "")]))
    website = record.get("website") or {}
    return {
        "company_name": company.get("legal_name") or company.get("company_name"),
        "sector": company.get("sector") or "Unverified Sector",
        "products": company.get("products") or company.get("sector") or "Pending Analysis",
        "customers": company.get("customers") or "Pending Analysis",
        "ebitda": f"€{ebitda / 1e6:.1f}M" if ebitda else "Pending Audit",
        "verified": bool(website.get("verified")),
        "fetched": bool(website.get("fetched")),
        "evidence": company.get("evidence") or [],
        "source_url": company.get("website") or "",
        "geographic_hint": geo,
        "company_id": company.get("company_id"),
    }
