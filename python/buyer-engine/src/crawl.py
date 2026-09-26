"""Polite company-website crawler, adapted from the mergerochocolate research bot.

Stays on the company's own site. Honours robots.txt, uses the sitemap, picks a few
useful pages (about, products, news, reports), and keeps only quotes that are
really on the page. No headless browser and no language model.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from html import unescape
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

USER_AGENT = "MergeroResearchBot/0.1 (+https://mergero.com)"
MAX_PAGES = 8
DELAY_S = 0.35
BUDGET_S = 20
TIMEOUT_S = 8
MAX_BYTES = 1_500_000
MAX_TEXT = 8000
MAX_CANDIDATES = 400

ASSET = re.compile(
    r"\.(?:pdf|jpe?g|png|gif|webp|svg|ico|zip|docx?|xlsx?|pptx?|css|js|mjs|woff2?|ttf|mp[34])(?:$|\?)",
    re.I,
)
JUNK = re.compile(
    r"/(?:tags?|author|feed|rss|comments|wp-admin|wp-json|cart|checkout|login|signin|search|haku|suche)(?:/|$)",
    re.I,
)
SKIP = re.compile(
    r"privacy|cookie|gdpr|tietosuoja|datenschutz|terms|agb|disclaimer|sitemap|accessibility",
    re.I,
)
HOME_ALIAS = re.compile(r"/(?:home|etusivu|start|startseite|forside|hjem|index(?:\.\w+)?)\/?$", re.I)
TRACKING = re.compile(r"^(?:utm_\w+|fbclid|gclid|_ga|_gl)$", re.I)
LANG_SEG = re.compile(r"^([a-z]{2})(?:[-_][a-z]{2})?$", re.I)

QUOTAS = {
    "offering": 2,
    "customers": 1,
    "direction": 2,
    "footprint": 1,
    "news": 2,
    "reports": 1,
    "people": 1,
}

# Slug / link-text keywords, ASCII-folded. Longer matches score more.
KW = {
    "offering": "products services solutions what-we-do offering portfolio tuotteet palvelut ratkaisut "
                "produkt tjanster losningar tjenester leistungen angebot",
    "customers": "customers clients references case-studies industries asiakkaat referenssit kundcase "
                 "referenzen projekte",
    "direction": "about about-us company who-we-are our-story history strategy vision meista yritys "
                 "om-oss uber-uns unternehmen",
    "footprint": "contact locations offices find-us yhteystiedot toimipisteet kontakt standort",
    "news": "news newsroom press media blog ajankohtaista uutiset tiedotteet nyheter presse",
    "reports": "investors annual-report financial results sijoittajat vuosikertomus tilinpaatos "
               "arsredovisning geschaftsbericht jahresabschluss",
    "people": "team management leadership board johto hallitus ledning vorstand",
}

GEO_KEYS = (
    "finland", "sweden", "norway", "denmark", "nordic", "helsinki",
    "germany", "austria", "switzerland", "dach", "gmbh", "europe",
)

# --- URL helpers ---

def fold(text: str) -> str:
    repl = (("ä", "a"), ("ö", "o"), ("å", "a"), ("ø", "o"), ("æ", "ae"), ("ü", "u"), ("ß", "ss"))
    out = (text or "").lower()
    for src, dst in repl:
        out = out.replace(src, dst)
    return out


def tokens(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", fold(text)).strip()


def to_url(href: str, base: str | None = None):
    try:
        raw = urljoin(base, href) if base else href
        parsed = urlparse(raw)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return None
        return parsed
    except Exception:
        return None


def bare(host: str) -> str:
    return (host or "").lower().split(":")[0].removeprefix("www.")


def same_host(a, b) -> bool:
    return bare(getattr(a, "netloc", "") or a) == bare(getattr(b, "netloc", "") or b)


def canon(parsed, root=None):
    query = "&".join(
        part for part in (parsed.query or "").split("&")
        if part and not TRACKING.match(part.split("=", 1)[0])
    )
    host = root.netloc if root and same_host(parsed, root) else parsed.netloc
    scheme = root.scheme if root and same_host(parsed, root) else parsed.scheme
    path = parsed.path.rstrip("/") or "/"
    return urlunparse((scheme, host, path, "", query, ""))


def path_of(url: str) -> str:
    return urlparse(url).path or "/"


def is_home(parsed) -> bool:
    segs = [s for s in parsed.path.split("/") if s]
    if segs and LANG_SEG.match(segs[0]) and len(segs) == 1:
        return True
    return (not segs) or bool(HOME_ALIAS.search(parsed.path))


def lang_of(parsed) -> str | None:
    first = next((s for s in parsed.path.split("/") if s), "")
    m = LANG_SEG.match(first)
    return m.group(1).lower() if m else None


def kw_score(text: str, keywords: str) -> int:
    hay = f" {tokens(text)} "
    score = 0
    for word in keywords.split():
        if f" {word.replace('-', ' ')} " in hay or f" {word} " in hay:
            score += len(word)
    return score


def categorize(url: str, anchor: str = "") -> str:
    parsed = to_url(url)
    if not parsed:
        return "other"
    if is_home(parsed):
        return "home"
    if SKIP.search(fold(parsed.path)):
        return "other"
    segs = tokens(parsed.path.replace("/", " "))
    best, top = "other", 0
    for cat, words in KW.items():
        s = kw_score(segs, words) * 2 + kw_score(anchor, words)
        if s > top:
            best, top = cat, s
    return best


def rate(url: str, anchor: str = "", home: bool = False) -> tuple[str, float]:
    parsed = to_url(url)
    cat = categorize(url, anchor)
    segs = [s for s in (parsed.path if parsed else "").split("/") if s]
    prio = (2 if home else 0) - max(0, len(segs) - 1) * 0.6
    if parsed and parsed.query:
        prio -= 1
    prio += min(kw_score(parsed.path if parsed else "", KW.get(cat, "")), 20) / 8
    return cat, prio


# --- robots.txt ---

def load_robots(root: str, fetch) -> dict:
    robots_url = urljoin(root, "/robots.txt")
    info = {"url": robots_url, "found": False, "sitemaps": [], "blocked": False, "delay": DELAY_S, "error": None}
    parser = RobotFileParser()
    parser.set_url(robots_url)
    try:
        res = fetch(robots_url, accept="text/plain,*/*;q=0.5", polite=False)
    except Exception as exc:
        info["error"] = str(exc)
        return info
    if res.get("status") in (429, 500, 502, 503):
        info["blocked"] = True
        info["error"] = f"robots.txt unreachable (HTTP {res['status']}); treated as disallow-all"
        return info
    if not res.get("ok") or (res.get("text") or "").lstrip().startswith("<"):
        return info
    text = res["text"]
    parser.parse(text.splitlines())
    info["found"] = True
    info["sitemaps"] = re.findall(r"(?im)^sitemap:\s*(\S+)", text)
    delay = re.search(r"(?im)^crawl-delay:\s*([\d.]+)", text)
    if delay:
        info["delay"] = min(max(float(delay.group(1)), DELAY_S), 10)
    if not parser.can_fetch(USER_AGENT, urljoin(root, "/")):
        info["blocked"] = True
        info["error"] = "robots.txt disallows MergeroResearchBot"
    info["_parser"] = parser
    return info


def robots_allow(info: dict, url: str) -> bool:
    if info.get("blocked"):
        return False
    parser = info.get("_parser")
    if not parser:
        return True
    return parser.can_fetch(USER_AGENT, url)


# --- HTML ---

def parse_page(html: str, page_url: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    title = ""
    og = soup.find("meta", attrs={"property": "og:site_name"}) or soup.find("meta", attrs={"property": "og:title"})
    if og and og.get("content"):
        title = og["content"].strip()
    if not title and soup.title:
        title = soup.title.get_text(" ", strip=True).split("|")[0].split("–")[0].split("-")[0].strip()
    lang = (soup.html.get("lang") if soup.html else None) or ""
    lang = lang[:2].lower() if lang else None

    ld = []
    for tag in soup.find_all("script", attrs={"type": re.compile(r"ld\+json", re.I)}):
        raw = (tag.string or tag.get_text() or "").strip()
        try:
            data = json.loads(raw)
        except Exception:
            continue
        stack = data if isinstance(data, list) else [data]
        for node in stack:
            if isinstance(node, dict):
                ld.append(node)
                graph = node.get("@graph")
                if isinstance(graph, list):
                    ld.extend(n for n in graph if isinstance(n, dict))

    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        abs_url = urljoin(page_url, href)
        if not abs_url.startswith("http"):
            continue
        links.append({"url": abs_url, "anchor": a.get_text(" ", strip=True)[:120]})

    for tag in soup(["script", "style", "noscript", "template", "svg", "iframe", "nav", "button"]):
        tag.decompose()
    for tag in soup.select("header, footer, [role=banner], [role=contentinfo], [role=navigation]"):
        tag.decompose()
    for tag in soup.select("[id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i]"):
        if tag.name not in ("html", "body", "main") and len(tag.get_text()) < 4000:
            tag.decompose()

    main = soup.find("main") or soup.find(attrs={"role": "main"}) or soup.find("article") or soup.body or soup
    text = " ".join(main.get_text(" ", strip=True).split())[:MAX_TEXT]
    body_words = len((soup.body.get_text(" ", strip=True) if soup.body else text).split())
    scripts = html.lower().count("<script")
    root_empty = bool(re.search(r'id=["\'](?:app|root|__next|__nuxt)["\']', html, re.I)) and body_words < 80
    return {
        "title": title,
        "lang": lang,
        "links": links,
        "ld": ld,
        "text": text,
        "words": len(text.split()),
        "js_only": root_empty or (body_words < 20 and scripts > 2),
        "footer": "",
    }


def merge_org(nodes: list[dict]) -> dict | None:
    def types(n):
        raw = n.get("@type") or []
        return [str(t).rsplit("/", 1)[-1] for t in (raw if isinstance(raw, list) else [raw])]

    orgs = [n for n in nodes if any("Organization" in t or t.endswith("Business") for t in types(n))]
    if not orgs:
        return None

    def val(v):
        if v is None:
            return None
        if isinstance(v, list):
            return val(v[0]) if v else None
        if isinstance(v, dict):
            return val(v.get("name") or v.get("@value") or v.get("value"))
        return str(v).strip() or None

    out = {"name": None, "legalName": None, "foundingDate": None, "numberOfEmployees": None, "vatID": None, "sameAs": []}
    for n in orgs:
        for key in ("name", "legalName", "foundingDate", "vatID"):
            out[key] = out[key] or val(n.get(key))
        emp = n.get("numberOfEmployees")
        if out["numberOfEmployees"] is None:
            out["numberOfEmployees"] = emp.get("value") if isinstance(emp, dict) else val(emp)
        same = n.get("sameAs") or []
        out["sameAs"].extend(val(x) for x in (same if isinstance(same, list) else [same]) if val(x))
    out["sameAs"] = list(dict.fromkeys(out["sameAs"]))
    return out if out["name"] or out["legalName"] else None


# --- business IDs ---

def _fi_ok(digits: str) -> bool:
    weights = [7, 9, 10, 5, 8, 4, 2]
    s = sum(w * int(d) for w, d in zip(weights, digits[:7])) % 11
    return s != 1 and int(digits[7]) == (0 if s == 0 else 11 - s)


def _no_ok(digits: str) -> bool:
    weights = [3, 2, 7, 6, 5, 4, 3, 2]
    s = sum(w * int(d) for w, d in zip(weights, digits[:8])) % 11
    return s != 1 and int(digits[8]) == (0 if s == 0 else 11 - s)


def find_ids(text: str) -> list[dict]:
    out, seen = [], set()

    def add(kind, value, raw):
        key = (kind, value)
        if key in seen:
            return
        seen.add(key)
        out.append({"type": kind, "value": value, "raw": re.sub(r"\s+", " ", raw)[:80]})

    for m in re.finditer(r"\b(?:y-?tunnus|business\s*id|company\s*id)[^\d]{0,20}(\d{7}-\d)\b", text or "", re.I):
        if _fi_ok(m.group(1).replace("-", "")):
            add("FI_YTUNNUS", m.group(1), m.group(0))
    for m in re.finditer(r"\b(\d{7}-\d)\b", text or ""):
        if _fi_ok(m.group(1).replace("-", "")):
            add("FI_YTUNNUS", m.group(1), m.group(0))
    for m in re.finditer(r"\b(?:org(?:anisasjons)?\.?\s*-?\s*(?:nr|nummer))[^\d]{0,12}(\d{9})\b", text or "", re.I):
        if _no_ok(m.group(1)):
            add("NO_ORGNR", m.group(1), m.group(0))
    for m in re.finditer(r"\bCVR[^\d]{0,10}(\d{8})\b", text or "", re.I):
        add("DK_CVR", m.group(1), m.group(0))
    for m in re.finditer(r"\b(HR[AB])\s*:?\s*(\d{1,6})\b", text or ""):
        add("DE_HR", f"{m.group(1)} {m.group(2)}", m.group(0))
    return out


# --- fetch ---

class Fetcher:
    def __init__(self, delay=DELAY_S, timeout=TIMEOUT_S, budget=BUDGET_S):
        self.delay = delay
        self.timeout = timeout
        self.deadline = time.monotonic() + budget
        self.last_end = 0.0
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"})
        self.reads = 0
        self.fails = 0

    def left(self) -> float:
        return self.deadline - time.monotonic()

    def get(self, url: str, accept: str | None = None, polite: bool = True) -> dict:
        if polite and self.last_end:
            wait = self.last_end + self.delay - time.monotonic()
            if wait > 0:
                time.sleep(min(wait, max(0, self.left())))
        if self.left() < 0.4:
            return {"ok": False, "error": "time budget exhausted", "url": url}
        headers = {"Accept": accept} if accept else {}
        try:
            res = self.session.get(url, timeout=min(self.timeout, max(1, self.left())), headers=headers, allow_redirects=True)
            self.reads += 1
            ctype = res.headers.get("content-type", "")
            if int(res.headers.get("content-length") or 0) > MAX_BYTES:
                return {"ok": False, "status": res.status_code, "error": "response larger than 1.5 MB", "url": res.url}
            raw = res.content[: MAX_BYTES + 1]
            if len(raw) > MAX_BYTES:
                return {"ok": False, "status": res.status_code, "error": "response larger than 1.5 MB", "url": res.url}
            text = raw.decode(res.encoding or "utf-8", errors="replace")
            return {"ok": res.ok, "status": res.status_code, "type": ctype, "url": res.url, "text": text,
                    "error": None if res.ok else f"HTTP {res.status_code}"}
        except Exception as exc:
            self.fails += 1
            return {"ok": False, "error": str(exc), "url": url}
        finally:
            self.last_end = time.monotonic()


def parse_sitemap(xml: str) -> tuple[bool, list[str]]:
    locs = [unescape(m) for m in re.findall(r"<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+)", xml or "", re.I)]
    return bool(re.search(r"<sitemapindex[\s>]", xml or "", re.I)), locs


def sourced_facts(pages: list[dict]) -> list[dict]:
    """Keep a short quote only when it really appears on the page it cites."""
    rules = [
        ("events", re.compile(r".{0,40}\b(?:has acquired|acquired|acquires|acquisition of|merger with)\b.{0,40}", re.I)),
        ("people", re.compile(r".{0,40}\b(?:new ceo|named ceo|appointed[^.]{0,40}\bceo\b)\b.{0,40}", re.I)),
        ("direction", re.compile(r".{0,30}\b(?:founded|established|since|perustettu|grundad|gegründet)\s+(?:in\s+)?((?:18|19|20)\d{2})\b.{0,30}", re.I)),
        ("events", re.compile(r".{0,40}\b(?:we'?re hiring|we are hiring|open positions|record year|record growth)\b.{0,40}", re.I)),
    ]
    facts, seen = [], set()
    for page in pages:
        text = page.get("text") or ""
        for category, pattern in rules:
            match = pattern.search(text)
            if not match:
                continue
            quote = " ".join(match.group(0).split())
            key = (page["url"], quote.lower())
            if key in seen or quote.lower() not in text.lower():
                continue
            seen.add(key)
            facts.append({
                "category": category,
                "claim": quote,
                "quote": quote,
                "url": page["url"],
                "verified": "quote",
            })
    return facts[:12]


def crawl_site(website: str, max_pages: int = MAX_PAGES, delay: float = DELAY_S,
               budget: float = BUDGET_S, timeout: float = TIMEOUT_S) -> dict:
    out = {
        "ok": False, "error": None, "root": "", "robots": {"found": False, "sitemaps": [], "blocked": False},
        "pages": [], "business_ids": [], "jsonld": None, "documents": [], "social": {},
        "languages": [], "warnings": [], "js_only": False,
        "stats": {"discovered": 0, "fetched": 0, "kept": 0, "ms": 0},
        "combined_text": "",
    }
    raw = (website or "").strip()
    if raw and not re.match(r"^https?://", raw, re.I):
        raw = "https://" + raw
    start = to_url(raw)
    if not start:
        out["error"] = "Invalid website URL"
        return out
    t0 = time.monotonic()
    fetcher = Fetcher(delay=delay, timeout=timeout, budget=budget)
    root = urlunparse((start.scheme, start.netloc, "/", "", "", ""))

    robots = load_robots(root, fetcher.get)
    out["robots"] = {k: robots[k] for k in ("found", "sitemaps", "blocked") if k in robots}
    if robots.get("error"):
        out["error"] = robots["error"]
        if robots.get("blocked"):
            out["robots"]["blocked"] = True
            out["stats"]["ms"] = int((time.monotonic() - t0) * 1000)
            out["stats"]["fetched"] = fetcher.reads
            return out
    fetcher.delay = robots.get("delay") or delay

    home = fetcher.get(canon(start))
    if not home.get("ok"):
        out["error"] = home.get("error") or "Homepage could not be read"
        out["stats"]["ms"] = int((time.monotonic() - t0) * 1000)
        out["stats"]["fetched"] = fetcher.reads
        return out

    root_parsed = urlparse(home["url"])
    root = urlunparse((root_parsed.scheme, root_parsed.netloc, "/", "", "", ""))
    out["root"] = root
    out["ok"] = True
    parsed_home = parse_page(home["text"], home["url"])
    out["js_only"] = parsed_home["js_only"]
    if parsed_home["js_only"]:
        out["warnings"].append("Homepage looks client-side rendered; reading the raw HTML only (no headless browser).")

    pages = [{
        "url": home["url"], "category": "home", "title": parsed_home["title"],
        "text": parsed_home["text"], "words": parsed_home["words"],
        "hash": hashlib.sha1(parsed_home["text"].encode()).hexdigest()[:16],
    }]
    ld_nodes = list(parsed_home["ld"])
    hashes = {pages[0]["hash"]}
    fetched_keys = {canon(urlparse(home["url"]))}
    docs = []
    pool: dict[str, dict] = {}

    def add_cand(href, anchor="", home_link=False):
        parsed = to_url(href, root)
        if not parsed or not same_host(parsed, root_parsed):
            return
        if ASSET.search(parsed.path):
            if parsed.path.lower().endswith(".pdf"):
                docs.append({"url": canon(parsed, root_parsed), "category": "reports" if "report" in fold(href + anchor) else "other",
                             "year": next((int(y) for y in re.findall(r"20\d{2}", href + anchor) if 1990 <= int(y) <= 2030), None)})
            return
        if JUNK.search(parsed.path) or SKIP.search(fold(parsed.path)):
            return
        key = canon(parsed, root_parsed)
        if key in fetched_keys or key in pool or len(pool) >= MAX_CANDIDATES:
            return
        cat, prio = rate(key, anchor, home=home_link)
        pool[key] = {"url": key, "anchor": anchor, "cat": cat, "prio": prio}

    for link in parsed_home["links"]:
        add_cand(link["url"], link["anchor"], home_link=True)

    sitemap_urls = list(robots.get("sitemaps") or [])[:3]
    sitemap_urls += [urljoin(root, "/sitemap.xml"), urljoin(root, "/sitemap_index.xml")]
    locs = []
    for sm_url in dict.fromkeys(sitemap_urls):
        if fetcher.left() < 3:
            break
        if not robots_allow(robots, sm_url) and sm_url not in (robots.get("sitemaps") or []):
            continue
        res = fetcher.get(sm_url, accept="application/xml,text/xml;q=0.9,*/*;q=0.5")
        if not res.get("ok"):
            continue
        index, found = parse_sitemap(res["text"])
        if index:
            for child in found[:5]:
                if fetcher.left() < 3:
                    break
                child_res = fetcher.get(child, accept="application/xml,text/xml;q=0.9,*/*;q=0.5")
                if child_res.get("ok"):
                    _, child_locs = parse_sitemap(child_res["text"])
                    locs.extend(child_locs)
        else:
            locs.extend(found)
    if not locs and not robots.get("sitemaps"):
        out["warnings"].append("No sitemap found; discovery relied on homepage links")
    for loc in locs[:800]:
        add_cand(loc)

    picked = []
    counts = {}
    ranked = sorted(pool.values(), key=lambda c: -c["prio"])
    for cat, quota in QUOTAS.items():
        for cand in ranked:
            if counts.get(cat, 0) >= quota or len(picked) >= max_pages - 1:
                break
            if cand["cat"] == cat and cand["url"] not in picked and robots_allow(robots, cand["url"]):
                picked.append(cand["url"])
                counts[cat] = counts.get(cat, 0) + 1
    for cand in ranked:
        if len(picked) >= max_pages - 1:
            break
        if cand["url"] not in picked and robots_allow(robots, cand["url"]) and cand["prio"] > -1:
            picked.append(cand["url"])

    for url in picked:
        if fetcher.left() < 1.5 or fetcher.fails >= 6:
            out["warnings"].append("Stopped early (time budget or repeated errors)")
            break
        if not robots_allow(robots, url):
            continue
        res = fetcher.get(url)
        if not res.get("ok"):
            continue
        parsed = parse_page(res["text"], res["url"])
        digest = hashlib.sha1(parsed["text"].encode()).hexdigest()[:16]
        if parsed["words"] < 8 or digest in hashes:
            continue
        hashes.add(digest)
        fetched_keys.add(canon(urlparse(res["url"]), root_parsed))
        pages.append({
            "url": res["url"], "category": pool.get(url, {}).get("cat") or categorize(res["url"]),
            "title": parsed["title"], "text": parsed["text"], "words": parsed["words"], "hash": digest,
        })
        ld_nodes.extend(parsed["ld"])
        for link in parsed["links"]:
            add_cand(link["url"], link["anchor"])

    org = merge_org(ld_nodes)
    ids = []
    for page in pages:
        if page["category"] in ("home", "footprint", "direction"):
            for item in find_ids(page["text"]):
                if (item["type"], item["value"]) not in {(i["type"], i["value"]) for i in ids}:
                    ids.append(item)
    if org and org.get("vatID"):
        for item in find_ids(f"VAT {org['vatID']}"):
            if (item["type"], item["value"]) not in {(i["type"], i["value"]) for i in ids}:
                ids.append(item)

    combined = "\n\n".join(f"{p['title']}\n{p['text']}" for p in pages)
    out.update({
        "pages": pages,
        "business_ids": ids,
        "jsonld": org,
        "documents": docs[:20],
        "social": {k: v for k, v in {
            "linkedin": next((u for u in (org or {}).get("sameAs", []) if "linkedin.com" in u), None),
        }.items() if v},
        "languages": list(dict.fromkeys(p.get("lang") for p in [{"lang": parsed_home["lang"]}] if p.get("lang"))),
        "facts": sourced_facts(pages),
        "combined_text": combined[:20000],
    })
    out["stats"] = {
        "discovered": len(pool) + 1,
        "fetched": fetcher.reads,
        "kept": len(pages),
        "ms": int((time.monotonic() - t0) * 1000),
    }
    return out
