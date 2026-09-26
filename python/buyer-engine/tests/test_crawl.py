from crawl import categorize, crawl_site, find_ids, parse_page, parse_sitemap, sourced_facts, _fi_ok


class FakeResponse:
    def __init__(self, text, url, status=200, content_type="text/html"):
        self.text = text
        self.content = text.encode()
        self.status_code = status
        self.url = url
        self.ok = 200 <= status < 300
        self.encoding = "utf-8"
        self.headers = {"content-type": content_type, "content-length": str(len(self.content))}


PAGES = {
    "https://acme.test/robots.txt": (
        "User-agent: *\nAllow: /\nDisallow: /secret\nSitemap: https://acme.test/sitemap.xml\n",
        "text/plain",
    ),
    "https://acme.test/sitemap.xml": (
        "<urlset><loc>https://acme.test/about</loc><loc>https://acme.test/news</loc>"
        "<loc>https://acme.test/secret</loc></urlset>",
        "application/xml",
    ),
    "https://acme.test": (
        """<html lang="en"><head><title>Acme Oy</title>
        <meta property="og:site_name" content="Acme Oy">
        <script type="application/ld+json">{"@type":"Organization","name":"Acme Oy","foundingDate":"1990"}</script>
        </head><body><main>
        <h1>Industrial automation software</h1>
        <p>We build cloud software for factories in Finland and Germany.</p>
        <a href="/about">About us</a><a href="/news">News</a>
        </main></body></html>""",
        "text/html",
    ),
    "https://acme.test/about": (
        """<html><head><title>About</title></head><body><main>
        <p>Acme Oy was founded in 1990. Business ID 1509667-4.</p>
        <p>We design manufacturing and automation systems.</p>
        </main></body></html>""",
        "text/html",
    ),
    "https://acme.test/news": (
        """<html><head><title>News</title></head><body><main>
        <p>Acme has acquired Nordic Pumps. We are hiring engineers in Helsinki.</p>
        </main></body></html>""",
        "text/html",
    ),
    "https://acme.test/secret": ("<html><body>internal</body></html>", "text/html"),
}


def fake_get(self, url, timeout=None, headers=None, allow_redirects=True):
    key = url.rstrip("/") if url.rstrip("/") in PAGES else url
    if key not in PAGES and url.endswith("/"):
        key = url.rstrip("/")
    if key not in PAGES:
        return FakeResponse("missing", url, status=404)
    text, ctype = PAGES[key]
    return FakeResponse(text, key if not key.endswith(".xml") and not key.endswith(".txt") else url, content_type=ctype)


def test_categorize_paths():
    assert categorize("https://acme.test/about-us", "About us") == "direction"
    assert categorize("https://acme.test/products/pumps") == "offering"
    assert categorize("https://acme.test/news/2024") == "news"
    assert categorize("https://acme.test/") == "home"


def test_business_id_checksums():
    assert _fi_ok("15096674")
    assert not _fi_ok("15096670")
    assert find_ids("Business ID 1509667-4")[0] == {"type": "FI_YTUNNUS", "value": "1509667-4", "raw": "Business ID 1509667-4"}
    assert find_ids("HRB 12345")[0]["type"] == "DE_HR"


def test_parse_page_keeps_main_drops_nav():
    html = "<html><nav>Menu</nav><main><h1>Hello software</h1><p>Cloud platform</p></main><footer>legal</footer></html>"
    parsed = parse_page(html, "https://acme.test/")
    assert "Hello software" in parsed["text"] and "Menu" not in parsed["text"]
    assert parsed["words"] >= 2


def test_sourced_facts_need_a_real_quote():
    pages = [{"url": "https://acme.test/news", "text": "Today Acme has acquired Nordic Pumps in Tampere."}]
    facts = sourced_facts(pages)
    assert facts and facts[0]["verified"] == "quote"
    assert "has acquired" in facts[0]["quote"].lower()
    assert facts[0]["url"] == "https://acme.test/news"
    assert sourced_facts([{"url": "https://x", "text": "Nothing interesting here."}]) == []


def test_parse_sitemap_index_and_urlset():
    index, locs = parse_sitemap("<sitemapindex><sitemap><loc>https://a/s.xml</loc></sitemap></sitemapindex>")
    assert index is True and locs == ["https://a/s.xml"]
    index, locs = parse_sitemap("<urlset><loc>https://a/about</loc></urlset>")
    assert index is False and locs == ["https://a/about"]


def test_crawl_reads_sitemap_pages_and_skips_robots_disallow(monkeypatch):
    monkeypatch.setattr("crawl.requests.Session.get", fake_get)
    monkeypatch.setattr("crawl.DELAY_S", 0)
    result = crawl_site("https://acme.test", delay=0, budget=10, timeout=2)
    assert result["ok"]
    urls = [p["url"] for p in result["pages"]]
    assert any(u.rstrip("/").endswith("acme.test") for u in urls)
    assert any("/about" in u for u in urls)
    assert any("/news" in u for u in urls)
    assert not any("/secret" in u for u in urls)
    assert result["robots"]["found"] is True and result["robots"]["blocked"] is False
    assert any(i["value"] == "1509667-4" for i in result["business_ids"])
    assert result["jsonld"] and result["jsonld"]["name"] == "Acme Oy"
    assert any("acquired" in (f["quote"] or "").lower() for f in result["facts"])
    assert "founded in 1990" in result["combined_text"].lower()


def test_robots_unreachable_is_disallow_all(monkeypatch):
    def boom(self, url, **kwargs):
        return FakeResponse("nope", url, status=503, content_type="text/plain")

    monkeypatch.setattr("crawl.requests.Session.get", boom)
    result = crawl_site("https://blocked.test", delay=0, budget=5)
    assert result["ok"] is False and result["robots"]["blocked"] is True
    assert result["pages"] == []


def test_scrape_profile_uses_the_crawl(monkeypatch):
    monkeypatch.setattr("crawl.requests.Session.get", fake_get)
    monkeypatch.setattr("crawl.DELAY_S", 0)
    from scraper import scrape_company_profile
    profile = scrape_company_profile("https://acme.test")
    assert profile["fetched"] and profile["verified"]
    assert profile["company_name"] == "Acme Oy"
    assert "software" in profile["sector"].lower() or profile["evidence"]
    assert profile["pages"] and profile["crawl"]["ok"]
    assert "page_texts" in profile
    assert any(p["category"] in ("direction", "news", "home") for p in profile["pages"])
