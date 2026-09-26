// Polite company-website crawler for deal research: honest UA, robots.txt, sitemaps, multilingual page picking,
// clean main text, JSON-LD, business IDs, social profiles and report PDFs; headless render for JS-only sites.
// Robots/sitemap/JSON-LD/CSR heuristics and the homepage+subpage crawl are ported from scraper/scripts/fetch_page.py
// and scraper/backend/voice_card/scraper.py (MIT © Zubair Trabzada).
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { gunzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import { browserAvailable, renderPages } from "./render.js";

export const USER_AGENT = "MergeroResearchBot/0.1 (+https://mergero.com)";
const BOT = "mergeroresearchbot";
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_TEXT = 12000;
const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
const QUOTAS = { offering: 5, customers: 4, direction: 4, footprint: 3, news: 3, reports: 2, people: 2, careers: 1, legal: 1 };
const HUBS = new Set(["offering", "customers", "footprint", "direction", "reports", "news", "people"]);
const LANGS = new Set("en fi sv se no nb nn da dk de fr es nl pl ru et lv lt zh cn ja ko pt cs sk hu ro tr uk ar".split(" "));
const LANG_ALIAS = { nb: "no", nn: "no", se: "sv", dk: "da", cn: "zh" };

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const uniq = (a) => [...new Set(a.filter(Boolean))];
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const countWords = (s) => (s.match(/\S+/g) || []).length;
const bare = (h) => h.toLowerCase().replace(/^www\./, "");
const decode = (s) => { try { return decodeURI(s); } catch { return s; } };
const toUrl = (s, base) => { try { return new URL(s, base); } catch { return null; } };
const fold = (s) => String(s ?? "").toLowerCase().replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").normalize("NFD").replace(/\p{M}/gu, "");
const tokens = (s) => fold(s).replace(/[^a-z0-9]+/g, " ").trim();
const normLang = (s) => { const l = /^([a-z]{2,3})(?:[-_]|$)/i.exec(String(s ?? "").trim())?.[1].toLowerCase(); return l ? LANG_ALIAS[l] || l : null; };
const yearsIn = (s) => (s.match(/(?<!\d)20\d{2}(?!\d)/g) || []).map(Number).filter((y) => y <= new Date().getFullYear() + 1);
const pathOf = (u) => { const x = toUrl(u); return x ? decode(x.pathname + x.search) : String(u); };

// ---------- page keywords ----------
// Multilingual (EN/FI/SV/NO/DA/DE) slug + link-text keywords, ASCII-folded ("ä"→"a", "ø"→"o").
// "a-b" is a phrase, "x*" a prefix; longer (more specific) keywords weigh more.
const KW = Object.fromEntries(Object.entries({
  offering: "products product* services service* solutions solution* what-we-do offering* capabilit* portfolio brands catalog* " +
    "tuotteet tuote* tuotte* palvelu* ratkaisu* osaaminen mita-teemme produkt* tjanst* losning* erbjud* sortiment vad-vi-gor " +
    "tjeneste* hva-vi-gjor ydelse* hvad-vi-gor leistung* losungen loesungen dienstleistung* angebot* was-wir-tun",
  customers: "customers customer* clients client* references reference* case-stud* cases case success-stor* testimonial* industries " +
    "industry sectors markets who-we-serve projects yritysasiakka* asiakkaat asiakka* asiakas* referenssi* asiakastarina* toimiala* " +
    "projektit kund* referens* kundcase* bransch* referanse* kundehistorie* bransje* prosjekt* kundecase* referencer brancher " +
    "branche* referenz* projekte projekter",
  footprint: "contact* locations location offices office sites find-us where-we-are distributor* dealer* reseller* retailers " +
    "global-presence worldwide yhteystiedot yhteys* ota-yhteytta toimipiste* toimipaik* jalleenmyyj* myyntipist* sijainti* palvelupist* " +
    "asiakaspalvelu kontakt* kontor* aterforsalj* hitta-oss anlaggning* kundservice kundtjanst forhandler* avdeling* lokasjon* finn-oss " +
    "kundeservice afdeling* find-os standort* niederlassung* vertrieb* haendler handler anfahrt kundenservice kundendienst ansprechpartner",
  direction: "about about-us company who-we-are our-story history strategy vision mission values purpose sustainab* responsib* esg csr " +
    "ownership meista tietoa-meista yritys* yrityk* yhtio konserni historia strategia visio missio arvot vastuullisuus vastuu* " +
    "keita-olemme tarinamme om-oss om-foretaget foretaget historik strategi varderingar hallbarhet ansvar* om-selskapet selskapet " +
    "historikk visjon verdier barekraft samfunnsansvar om-os om-virksomheden virksomheden historie vaerdier baeredygtighed ueber-uns " +
    "uber-uns unternehmen geschichte strategie leitbild werte nachhaltig* verantwortung philosophie",
  reports: "investors investor* investor-relations ir annual-report* annual-review financial* results reports interim* sijoittaj* " +
    "vuosikertomu* tilinpaato* osavuosikatsau* puolivuosikatsau* taloudelli* taloustied* tulostied* investerare arsredovisning* " +
    "arsrapport* arsberetning* arsberattelse* delarsrapport* bokslut* finansiel* rapporter regnskap* regnskab* investoren " +
    "geschaftsbericht* geschaeftsbericht* jahresabschluss* finanzbericht* berichte",
  news: "news newsroom press press-releases media blog* articles article insights events ajankohtaista uutiset uutis* tiedotte* " +
    "tiedote* artikkelit nyheter nyhet* pressmeddelande* aktuellt aktuelt nyheder nyhed* presse pressemitteilung* pressemeldinger " +
    "aktuelles neuigkeiten medier",
  people: "team our-team management leadership board board-of-directors executive* people staff employees johto johtoryhma hallitus " +
    "henkilosto henkilokunta tiimi meidan-tiimi ledning* styrelse* personal medarbetare ledelse* styret ledergruppe* ansatte " +
    "medarbeidere bestyrelse* direktion medarbejdere geschaftsfuhrung geschaeftsfuehrung vorstand aufsichtsrat mitarbeiter",
  careers: "careers career* jobs job vacanc* join-us work-with-us open-positions recruit* rekry* ura urat tyopaik* avoimet-tyopaikat " +
    "toihin karriar* jobb* lediga-jobb lediga-tjanster jobba-hos-oss karriere* stilling* ledige-stillinger jobbe-hos-oss " +
    "stellenangebot* stellen",
  legal: "impressum imprint legal-notice legal-info* mentions-legales juridisk-information",
}).map(([cat, list]) => [cat, list.split(/\s+/).map((k) => ({ toks: k.replace("*", "").split("-"), prefix: k.endsWith("*"), w: k.replace(/[*-]/g, "").length }))]));

// Sum over token positions of the heaviest keyword (phrase or prefix) starting there.
function kwScore(text, kws) {
  const t = text.split(" ");
  let sum = 0;
  for (let i = 0; i < t.length; i++) {
    let best = 0;
    for (const k of kws) {
      if (k.w <= best || i + k.toks.length > t.length) continue;
      if (k.toks.every((w, j) => (k.prefix && j === k.toks.length - 1 ? t[i + j].startsWith(w) : t[i + j] === w))) best = k.w;
    }
    sum += best;
  }
  return sum;
}

// ---------- URL hygiene ----------
const ASSET = /\.(?:pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|zip|rar|7z|gz|docx?|xlsx?|pptx?|odt|ods|csv|mp[34]|m4v|mov|avi|wmv|webm|ogg|wav|css|js|mjs|json|xml|txt|rss|atom|woff2?|ttf|eot|exe|dmg|apk|msi|ics|vcf)$/;
const JUNK = /\/(?:tags?|author|feed|rss|comments|attachment|trackback|embed|wp-json|wp-admin|wp-content|wp-includes|wp-login\.php|xmlrpc\.php|cdn-cgi|cart|checkout|basket|ostoskori|varukorg|handlekurv|warenkorb|my-account|login|signin|sign-in|logout|register|search|haku|suche|print|share|amp)(?:\/|$)|\/page\/\d+\/?$/;
const JUNK_QUERY = /(?:^|&)(?:replytocom|share|print|s|q|search|sort|orderby|order|filter|add-to-cart|paged?|start|offset|format|output|preview|ver|v)=/i;
const SKIP = /privacy|cookie|gdpr|tietosuoja|evaste|integritet|personuppgift|personvern|privatliv|datenschutz|kayttoehdo|toimitusehdo|villkor|vilkar|(?:^|[/-])(?:terms|agb|disclaimer|sitemap|accessibility|saavutettavuus)(?:[/-]|$)/;
const HOME_ALIAS = /\/(?:home|etusivu|start|startseite|forside|hjem|hem|index(?:\.\w+)?)\/?$/;
const TRACKING = /^(?:utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|hsa_\w+|_hs\w+|trk|ref|srsltid)$/i;
const LANG_SEG = /^([a-z]{2})(?:[-_][a-z]{2})?$/i;

function canon(x, root) {
  const u = new URL(x.href);
  u.hash = ""; u.username = ""; u.password = "";
  if (root && bare(u.hostname) === bare(root.hostname) && u.port === root.port) { u.protocol = root.protocol; u.hostname = root.hostname; }
  const drop = [...u.searchParams.keys()].filter((k) => TRACKING.test(k));
  if (drop.length) { drop.forEach((k) => u.searchParams.delete(k)); u.search = u.searchParams.size ? `?${u.searchParams}` : ""; }
  return u;
}
const keyOf = (u) => `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}`;

function langOf(u) {
  const m = LANG_SEG.exec(u.pathname.split("/")[1] || "");
  if (m && LANGS.has(m[1].toLowerCase())) return normLang(m[1]);
  const q = ["lang", "language", "locale", "lng", "hl"].map((k) => u.searchParams.get(k)).find(Boolean);
  return q ? normLang(q) : null;
}
function segsOf(u) { // folded path segments without a leading language prefix
  let s = u.pathname.split("/").filter(Boolean);
  const m = LANG_SEG.exec(s[0] || "");
  if (m && LANGS.has(m[1].toLowerCase())) s = s.slice(1);
  return s.map((x) => tokens(decode(x))).filter(Boolean);
}
const isHomeUrl = (u) => (!segsOf(u).length && [...u.searchParams.keys()].every((k) => /^(lang|language|locale|lng|hl)$/i.test(k))) || HOME_ALIAS.test(fold(decode(u.pathname)));

// Category + pick priority from path (last segment weighs most), link texts, parent-menu labels and hub inheritance.
function rate(u, { anchors = [], menus = [], inherit = null, home = false, child = false } = {}) {
  const segs = segsOf(u);
  let cat = "other", top = 0;
  for (const c of Object.keys(QUOTAS)) {
    let s = segs.reduce((a, seg, i) => a + kwScore(seg, KW[c]) * (i === segs.length - 1 ? 3 : 1), 0);
    s += 2 * Math.max(0, ...anchors.map((a) => kwScore(a, KW[c]))) + Math.max(0, ...menus.map((m) => kwScore(m, KW[c])));
    if (inherit === c) s += 4;
    if (s > top) { top = s; cat = c; }
  }
  const year = Math.max(0, ...yearsIn(u.pathname));
  const prio = Math.min(top, 40) / 8 + (home ? 2 : 0) + (child ? 1 : 0) - Math.max(0, segs.length - 1) * 0.8
    - (u.search ? 1.5 : 0) - (u.pathname.length > 80 ? 1 : 0) + (year ? Math.max(-1, Math.min(1.5, (year - 2021) * 0.4)) : 0);
  return { cat, prio, depth: segs.length };
}

export function categorize(url, anchor = "") {
  const u = toUrl(url);
  if (!u) return "other";
  if (isHomeUrl(u)) return "home";
  if (SKIP.test(fold(decode(u.pathname)))) return "other";
  const a = tokens(anchor);
  return rate(u, { anchors: a ? [a] : [] }).cat;
}

// ---------- robots.txt ----------
// Groups for our token (else "*"); longest match wins, Allow wins ties; supports * and $ (RFC 9309).
function parseRobots(txt) {
  const groups = [], sitemaps = [];
  let cur = null, agentRun = false;
  for (const raw of txt.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, "").trim(), i = line.indexOf(":");
    if (i < 1) continue;
    const key = line.slice(0, i).trim().toLowerCase(), val = line.slice(i + 1).trim();
    if (key === "sitemap") { if (val) sitemaps.push(val); continue; }
    if (key === "user-agent") {
      if (!cur || !agentRun) groups.push((cur = { agents: [], rules: [], delay: 0 }));
      cur.agents.push(val.toLowerCase().split("/")[0].trim());
      agentRun = true;
      continue;
    }
    agentRun = false;
    if (!cur) continue;
    if ((key === "allow" || key === "disallow") && val) cur.rules.push(compileRule(val, key === "allow"));
    else if (key === "crawl-delay") cur.delay = Number(val) || 0;
  }
  const mine = groups.filter((g) => g.agents.includes(BOT));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return { sitemaps, rules: use.flatMap((g) => g.rules), delay: Math.max(0, ...use.map((g) => g.delay)) };
}
function compileRule(path, allow) {
  const p = decode(path);
  const re = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
  return { re, len: p.length, allow };
}
function robotsAllow(rules, path) {
  const p = decode(path);
  let best = null;
  for (const r of rules) if (r.re.test(p) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
  return !best || best.allow;
}

// ---------- HTTP ----------
async function resolves(host) {
  if (/^[\d.]+$|^\[|^localhost$/i.test(host)) return true;
  try {
    await Promise.race([lookup(host), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("slow DNS"), { code: "ESLOW" })), 4000).unref())]);
    return true;
  } catch (e) {
    return !["ENOTFOUND", "EAI_NONAME", "EAI_NODATA", "ENODATA", "EAI_AGAIN"].includes(e.code);
  }
}

function netError(e, url) {
  const code = e?.cause?.code || e?.code || "", host = toUrl(url)?.hostname || url;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `Timed out fetching ${url}`;
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME/.test(code)) return `Could not resolve ${host}`;
  if (code === "ECONNREFUSED") return `Connection refused by ${host}`;
  if (code === "ECONNRESET") return `Connection reset by ${host}`;
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(code)) return `TLS certificate problem on ${host} (${code})`;
  return `${e?.cause?.message || e?.message || e} (${host})`;
}

async function readCapped(res) {
  if (Number(res.headers.get("content-length")) > MAX_BYTES) { await res.body?.cancel().catch(() => {}); return null; }
  const chunks = [];
  let size = 0;
  for await (const ch of res.body ?? []) {
    size += ch.length;
    if (size > MAX_BYTES) return null; // leaving the loop cancels the stream
    chunks.push(ch);
  }
  return Buffer.concat(chunks);
}

// Charset from Content-Type, BOM, <meta charset> or <?xml encoding>; mislabelled Latin-1 falls back to windows-1252.
function decodeBody(buf, type) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = gunzipSync(buf, { maxOutputLength: MAX_BYTES * 4 }); } catch {} }
  const head = buf.subarray(0, 4096).toString("latin1");
  let cs = /charset=["']?([\w.:-]+)/i.exec(type)?.[1]
    || (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? "utf-8" : buf[0] === 0xff && buf[1] === 0xfe ? "utf-16le" : buf[0] === 0xfe && buf[1] === 0xff ? "utf-16be" : null)
    || /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1]
    || /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1] || "utf-8";
  let text;
  try { text = new TextDecoder(cs.toLowerCase()).decode(buf); } catch { text = new TextDecoder().decode(buf); cs = "utf-8"; }
  if (/^utf-?8$/i.test(cs) && (text.match(/�/g) || []).length > 3) text = new TextDecoder("windows-1252").decode(buf);
  return text;
}

// ---------- HTML → text, links, metadata ----------
const BLOCK = new Set("address article aside blockquote caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody tfoot thead tr ul".split(" "));
const SPACED = new Set(["a", "span", "label", "time", "abbr", "cite"]);
const NOISE = new Set(["svg", "iframe", "form", "button", "nav", "select", "canvas", "object", "embed", "template", "noscript"]);
const CHROME = "svg, iframe, button, nav, select, canvas, object, embed, [role=navigation], [hidden], [style*='display:none' i], [style*='display: none' i]";
const COMPONENT_FOOTER = /(?:card|modal|panel|entry|post|article|comment|widget|table)[-_]?footer/i;

// Block-aware walk: one line per block / table row, whitespace collapsed, identical lines dropped, short items kept.
function blockText(nodes, cap, skip = null) {
  const lines = [], seen = new Set();
  let buf = "", len = 0;
  const flush = () => {
    const t = squash(buf).replace(/(?:\s*\|\s*){2,}/g, " | ").replace(/^\|\s*|\s*\|$/g, "").trim();
    buf = "";
    if (t.length >= 3 && !seen.has(t)) { seen.add(t); lines.push(t); len += t.length + 1; }
  };
  const walk = (n) => {
    if (len > cap) return;
    if (n.type === "text") { buf += n.data; return; }
    if (n.type !== "tag" && n.type !== "root") return;
    if (skip?.has(n.name)) return;
    if (n.name === "br") return flush();
    const block = n.type === "root" || BLOCK.has(n.name);
    if (block) flush();
    for (const c of n.children || []) walk(c);
    if (n.name === "td" || n.name === "th") buf += " | ";
    else if (block) flush();
    else if (SPACED.has(n.name)) buf += " ";
  };
  for (const n of nodes) walk(n);
  flush();
  let text = lines.join("\n");
  if (text.length > cap) { const cut = text.lastIndexOf("\n", cap); text = text.slice(0, cut > cap * 0.7 ? cut : cap); }
  return text;
}

// Site footer: <footer>/contentinfo outside articles, else the outermost [id|class*=footer] block.
function footerNodes($) {
  const outer = (sel) => $(sel).filter((_, el) => !$(el).parent().closest(`${sel}, article`).length);
  const f = outer("footer, [role=contentinfo]");
  if (f.length) return f;
  return outer("[id*=footer i], [class*=footer i]").filter((_, el) => /^(div|section|aside)$/.test(el.name)
    && !COMPONENT_FOOTER.test(`${el.attribs.id || ""} ${el.attribs.class || ""}`) && !$(el).closest("main, article").length && $(el).text().length < 20000);
}

function parsePage(html, pageUrl, { footer = false } = {}) {
  const $ = cheerio.load(html);
  const base = toUrl($("base[href]").attr("href") || "", pageUrl)?.href || pageUrl;
  const title = squash($("title").first().text()) || squash($("meta[property='og:title']").attr("content")) || squash($("h1").first().text());
  const lang = normLang($("html").attr("lang") || $("meta[http-equiv='content-language' i]").attr("content"));
  const alternates = [];
  $("link[rel~=alternate][hreflang][href]").each((_, el) => { const u = toUrl(el.attribs.href, base); if (u) alternates.push({ lang: normLang(el.attribs.hreflang), url: u.href }); });
  const ld = [];
  $("script").each((_, el) => { if (/ld\+json/i.test(el.attribs.type || "")) ld.push(...parseLd($(el).text())); });
  const scripts = $("script[src]").length;
  const refresh = /url\s*=\s*['"]?([^'";]+)/i.exec($("meta[http-equiv='refresh' i]").attr("content") || "")?.[1];
  // every link incl. nav/footer, with its text and the label of the parent menu item (dropdowns)
  const links = [];
  $("a[href]").each((_, el) => {
    const u = toUrl((el.attribs.href || "").trim(), base);
    if (!u || !/^https?:$/.test(u.protocol)) return;
    const $a = $(el);
    const anchor = squash($a.text()) || squash(el.attribs["aria-label"] || el.attribs.title || $a.find("img[alt]").attr("alt"));
    const menu = squash($a.parent().closest("ul").closest("li").children("a, span, button").first().text());
    links.push({ url: u.href, anchor: anchor.slice(0, 120), menu: menu.slice(0, 60), el });
  });
  $("script, style, noscript, template").remove();
  // client-side-render heuristic, ported from fetch_page.py: framework root with (almost) no server-rendered text
  const rootLens = $("[id]").filter((_, el) => /(app|root|__next|__nuxt)/i.test(el.attribs.id)).map((_, el) => squash($(el).text()).length).get();
  const footerText = footer ? blockText(footerNodes($).get(), 3000, NOISE) : "";
  // strip page chrome, then read the main content
  $(CHROME).remove();
  $("form").filter((_, el) => $(el).text().length < 3000).remove(); // keep ASP.NET-style whole-page forms
  $("header, [role=banner], #header, #masthead, .site-header").filter((_, el) => !$(el).closest("main, article").length).remove();
  $("footer, [role=contentinfo]").remove();
  footerNodes($).remove();
  $("[id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i]").filter((_, el) => !/^(html|body|main)$/.test(el.name) && $(el).text().length < 5000).remove();
  const bodyText = squash($("body").text());
  const pick = ["main", "[role=main]"].map((s) => $(s).first()).find((el) => el.length && squash(el.text()).length >= Math.max(150, bodyText.length * 0.25))
    || ($("article").length === 1 && squash($("article").text()).length >= 150 ? $("article") : null)
    || ($("body").length ? $("body") : $.root());
  const text = blockText(pick.get(), MAX_TEXT);
  const bodyWords = countWords(bodyText);
  const jsOnly = (rootLens.some((n) => n < 50) && bodyWords < 200) || (bodyWords < 20 && scripts > 0);
  const mainEl = pick.get(0);
  for (const l of links) { let p = l.el; while (p && p !== mainEl) p = p.parent; l.inMain = Boolean(p); delete l.el; }
  return { title, lang, alternates, ld, links, refresh, footer: footerText, text, words: countWords(text), jsOnly };
}

// ---------- JSON-LD ----------
function parseLd(raw) {
  const s = String(raw).trim().replace(/^(?:<!--|\/\/\s*<!\[CDATA\[|<!\[CDATA\[)|(?:-->|\/\/\s*\]\]>|\]\]>)$/g, "").trim();
  for (const t of [s, s.replace(/[\u0000-\u001f]+/g, " ").replace(/,\s*([}\]])/g, "$1")]) {
    try { return flatLd(JSON.parse(t)); } catch {}
  }
  return [];
}
const flatLd = (x) => (Array.isArray(x) ? x.flatMap(flatLd)
  : x && typeof x === "object" ? [x, ...flatLd(x["@graph"] || []), ...(x.publisher?.["@type"] ? flatLd(x.publisher) : [])] : []);
const typesOf = (n) => [].concat(n?.["@type"] ?? []).map((t) => String(t).replace(/^https?:\/\/schema\.org\//i, ""));
const ORG = /^(?:Organization|Corporation|LocalBusiness|OnlineBusiness|OnlineStore|NGO|Airline|Consortium|Store|(?:Financial|Professional|Legal|Emergency)Service|.+(?:Organization|Business|Store|Contractor|Agency|Agent|Establishment|Shop|Dealer|Clinic|Restaurant|Hotel|Bank|Plumber|Electrician|Locksmith|Dentist|Physician|Attorney|Notary|Brewery|Winery|Bakery|Company))$/;
const val = (v) => (v == null ? null : Array.isArray(v) ? val(v[0]) : typeof v === "object" ? val(v["@value"] ?? v.name ?? v.value ?? null) : squash(v) || null);
const names = (v) => [].concat(v ?? []).map((x) => (x && typeof x === "object" ? val(x.name) : val(x))).filter(Boolean);
function addrText(a) {
  if (!a || typeof a !== "object") return val(a);
  return [a.streetAddress, [a.postalCode, a.addressLocality].filter(Boolean).join(" "), a.addressRegion, val(a.addressCountry)].map(val).filter(Boolean).join(", ") || null;
}
function employees(v) {
  if (v == null || typeof v !== "object") return v ?? null;
  return v.value ?? (v.minValue != null || v.maxValue != null ? [v.minValue, v.maxValue].filter((x) => x != null).join("-") : null);
}
function mergeOrg(nodes, onSite) {
  const orgs = nodes.filter((n) => typesOf(n).some((t) => ORG.test(t)));
  if (!orgs.length) return null;
  const rank = (n) => (/#organi[sz]ation$/i.test(n["@id"] || "") ? 2 : 0) + (onSite(val(n.url)) ? 1 : 0);
  orgs.sort((a, b) => rank(b) - rank(a));
  const o = { name: null, legalName: null, url: null, description: null, foundingDate: null, founders: [], numberOfEmployees: null, address: [], areaServed: [], sameAs: [], telephone: null, email: null, vatID: null, taxID: null, identifier: null };
  for (const n of orgs) {
    for (const k of ["name", "legalName", "url", "description", "foundingDate", "telephone", "email", "vatID", "taxID"]) o[k] ??= val(n[k]);
    o.numberOfEmployees ??= employees(n.numberOfEmployees);
    o.identifier ??= [].concat(n.identifier ?? []).map((x) => (x && typeof x === "object" ? [x.propertyID, x.value].filter(Boolean).join(": ") : String(x))).filter(Boolean).join("; ") || null;
    const cp = [].concat(n.contactPoint ?? []);
    o.telephone ??= val(cp.find((c) => c?.telephone)?.telephone);
    o.email ??= val(cp.find((c) => c?.email)?.email);
    o.founders.push(...names([].concat(n.founder ?? [], n.founders ?? [])));
    o.address.push(...[].concat(n.address ?? [], [].concat(n.location ?? []).map((l) => l?.address)).map(addrText).filter(Boolean));
    o.areaServed.push(...names(n.areaServed));
    o.sameAs.push(...[].concat(n.sameAs ?? []).map(val).filter(Boolean));
  }
  for (const k of ["founders", "address", "areaServed", "sameAs"]) o[k] = uniq(o[k]);
  if (o.email) o.email = o.email.replace(/^mailto:/i, "");
  if (o.description) o.description = o.description.slice(0, 1000);
  return o;
}

// ---------- business IDs (labels required; checksums where the registry defines one) ----------
const fiOk = (d) => { const s = [7, 9, 10, 5, 8, 4, 2].reduce((a, w, i) => a + w * d[i], 0) % 11; return s !== 1 && +d[7] === (s ? 11 - s : 0); };
const noOk = (d) => { const s = [3, 2, 7, 6, 5, 4, 3, 2].reduce((a, w, i) => a + w * d[i], 0) % 11; return s !== 1 && +d[8] === (s ? 11 - s : 0); };
const luhn = (d) => [...d].reverse().reduce((a, c, i) => { const n = +c * (i % 2 ? 2 : 1); return a + (n > 9 ? n - 9 : n); }, 0) % 10 === 0;
const REG_ID = /\b(?:y-?tunnus|fo-?nummer|business\s*id(?:entity\s*code)?|company\s*(?:id|reg(?:istration)?\.?\s*(?:no|number))|org(?:ani[sz]a(?:tions|sjons|tion))?\.?\s*-?\s*(?:nr|no|nummer|number)\b\.?|registration\s*(?:no|number))[^\d\n]{0,20}?(?:(?:FI|SE|NO)\s?)?(\d{7}-\d|\d{6}-?\d{4}|\d{3}[ .]?\d{3}[ .]?\d{3})(?![\d-])/gi;
const CVR = /\bCVR(?:[\s.-]*(?:nr|nummer|no)\b\.?)?[^\d\n]{0,10}?(?:DK\s?)?(\d{2}\s?\d{2}\s?\d{2}\s?\d{2})(?!\d)/gi;
const HR = /\b(HR[AB])(?:\s*-?\s*Nr\.?)?\s*:?\s*(\d{1,6})(\s?B\b)?/g;
const COURT_NAME = "([A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?(?:\\s(?:am|an der|im|in der)\\s[A-ZÄÖÜ][a-zäöüß]+|\\s\\([A-Za-zäöüß. ]+\\))?)";
const AMTS = new RegExp(`Amtsgericht:?\\s+${COURT_NAME}`), REGG = new RegExp(`Registergericht:?\\s+(?!Amtsgericht)${COURT_NAME}`);
const NO_MVA = /\bNO\s?(\d{3}\s?\d{3}\s?\d{3})\s?MVA\b/g;
const VAT = /\b(FI|SE|DK|NO|DE|ATU)\s?(\d{8,12})(?:\s?MVA)?(?!\d)/g;
const VAT_CTX = /(?:vat|alv|moms|mva|ust|mwst|umsatzsteuer|tax|btw|tva|iva|y-?tunnus|business\s*id|cvr|org)/i;

function findIds(text, out) {
  if (!text) return out;
  const add = (type, value, raw) => { if (!out.some((x) => x.type === type && x.value === value)) out.push({ type, value, raw: squash(raw).slice(0, 80) }); };
  for (const m of text.matchAll(REG_ID)) {
    const tok = m[1].replace(/[ .]/g, ""), d = tok.replace("-", "");
    if (/^\d{7}-\d$/.test(tok) && fiOk(d)) add("FI_YTUNNUS", tok, m[0]);
    else if (/^\d{10}$/.test(d) && luhn(d)) add("SE_ORGNR", `${d.slice(0, 6)}-${d.slice(6)}`, m[0]);
    else if (/^\d{9}$/.test(d) && noOk(d)) add("NO_ORGNR", d, m[0]);
  }
  for (const m of text.matchAll(CVR)) add("DK_CVR", m[1].replace(/\s/g, ""), m[0]);
  for (const m of text.matchAll(HR)) {
    const win = text.slice(Math.max(0, m.index - 150), m.index + m[0].length + 150);
    const court = AMTS.exec(win)?.[1] || REGG.exec(win)?.[1];
    add("DE_HR", `${m[1]} ${m[2]}${m[3] ? " B" : ""}${court ? ` (Amtsgericht ${court})` : ""}`, m[0]);
  }
  for (const m of text.matchAll(NO_MVA)) {
    const d = m[1].replace(/\s/g, "");
    if (noOk(d)) { add("NO_ORGNR", d, m[0]); add("VAT", `NO${d}MVA`, m[0]); }
  }
  for (const m of text.matchAll(VAT)) {
    const [raw, cc, num] = m, ctx = VAT_CTX.test(text.slice(Math.max(0, m.index - 40), m.index)) || /MVA$/.test(raw);
    const ok = { FI: num.length === 8 && fiOk(num), SE: num.length === 12 && num.endsWith("01") && luhn(num.slice(0, 10)), NO: num.length === 9 && noOk(num), DK: num.length === 8 && ctx, DE: num.length === 9 && ctx, ATU: num.length === 8 && ctx }[cc];
    if (!ok) continue;
    add("VAT", `${cc}${num}${cc === "NO" ? "MVA" : ""}`, raw);
    if (cc === "FI") add("FI_YTUNNUS", `${num.slice(0, 7)}-${num[7]}`, raw);
    if (cc === "SE") add("SE_ORGNR", `${num.slice(0, 6)}-${num.slice(6, 10)}`, raw);
    if (cc === "NO") add("NO_ORGNR", num, raw);
    if (cc === "DK") add("DK_CVR", num, raw);
  }
  return out;
}

// ---------- social profiles & report documents ----------
const SOCIAL = {
  linkedin: [/(^|\.)linkedin\.com$/, (p) => (/^\/(company|school|showcase)\/[^/]+/.test(p) ? 3 : /^\/in\/[^/]+/.test(p) ? 1 : 0)],
  facebook: [/(^|\.)(facebook|fb)\.com$/, (p) => (/sharer|share\.php|\/dialog|\/plugins|^\/tr\b|^\/?$/.test(p) ? 0 : 2)],
  instagram: [/(^|\.)instagram\.com$/, (p) => (/^\/(p|reel|explore|stories)\/|^\/?$/.test(p) ? 0 : 2)],
  x: [/(^|\.)(twitter|x)\.com$/, (p) => (/intent|share|hashtag|search|^\/home|^\/?$/.test(p) ? 0 : 2)],
  youtube: [/(^|\.)youtube\.com$/, (p) => (/^\/(@|channel\/|c\/|user\/)/.test(p) ? 3 : /^\/(watch|embed|shorts|playlist)|^\/?$/.test(p) ? 0 : 1)],
};
function pickSocial(urls) {
  const best = {};
  for (const raw of urls) {
    const u = toUrl(raw);
    if (!u) continue;
    for (const [net, [host, rank]] of Object.entries(SOCIAL)) {
      const r = host.test(u.hostname) ? rank(u.pathname) : 0;
      if (r > (best[net]?.r ?? 0)) best[net] = { r, url: `https://${u.hostname}${u.pathname.replace(/\/+$/, "")}` };
    }
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.url]));
}
const REPORT_DOC = /annual[\s_-]*(?:report|review)|vuosikertomu|tilinpaato|osavuosikatsau|puolivuosikatsau|tulostiedote|arsredovisning|arsrapport|arsberetning|arsberattelse|bokslut|delarsrapport|kvartalsrapport|halvarsrapport|geschaftsbericht|geschaeftsbericht|jahresabschluss|zwischenbericht|halbjahresbericht|quartalsbericht|financial[\s_-]*statement|interim[\s_-]*report|half[\s_-]*year(?:ly)?[\s_-]*report|quarterly[\s_-]*report|regnskap|regnskab/;
const smPref = (u) => (/page|post|news|product|service|solution|article|case|reference|project|sivu|tuote|palvelu|uutis|nyhet|produkt|tjanst|leistung|seite/i.test(u) ? 2 : 0)
  - (/image|video|tag|author|attachment|categor|media|archive|user|faq|glossar|job|event/i.test(u) ? 2 : 0);

// ---------- per-site fetch state (shared by crawlSite and readPages) ----------
class Site {
  constructor({ delayMs = 500, timeoutMs = 15000, budgetMs = 90000, log = () => {} } = {}) {
    Object.assign(this, { delayMs, delay: delayMs, timeoutMs, log, t0: Date.now(), budgetMs, deadline: Date.now() + budgetMs });
    Object.assign(this, { root: null, rules: [], lastEnd: 0, reads: 0, fails: 0, failed: [], stop: false, notes: [] });
  }
  left() { return this.deadline - Date.now(); }
  same(u) { return Boolean(u) && bare(u.hostname) === bare(this.root.hostname) && u.port === this.root.port; }
  allowed(u) { return u.pathname === "/robots.txt" || robotsAllow(this.rules, u.pathname + u.search); }

  // GET with manual redirects (≤5; same-site unless anyHost; robots-checked), politeness delay, per-request timeout, 3 MB cap.
  async get(url, { anyHost = false, polite = true, accept = HTML_ACCEPT } = {}) {
    if (polite) await sleep(Math.min(this.lastEnd + this.delay - Date.now(), this.left()));
    let cur = url;
    try {
      for (let hop = 0; hop <= 5; hop++) {
        const left = this.left();
        if (left < 500) return { error: "time budget exhausted", url: cur };
        const res = await fetch(cur, { redirect: "manual", headers: { "user-agent": USER_AGENT, accept }, signal: AbortSignal.timeout(Math.min(this.timeoutMs, left)) });
        const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (loc) {
          await res.body?.cancel().catch(() => {});
          const next = toUrl(loc, cur);
          if (!next || !/^https?:$/.test(next.protocol)) return { status: res.status, error: "redirect to a non-http URL", url: cur };
          if (this.same(next) && !this.allowed(next)) return { status: res.status, error: "redirect target disallowed by robots.txt", url: next.href };
          if (!anyHost && !this.same(next)) return { status: res.status, error: `redirects off-site to ${next.host}`, url: next.href };
          cur = next.href;
          continue;
        }
        const type = res.headers.get("content-type") || "";
        if (!res.ok || /^(?:image|video|audio|font)\/|application\/(?:pdf|zip|octet-stream)/i.test(type)) {
          await res.body?.cancel().catch(() => {});
          return { status: res.status, type, url: cur, error: res.ok ? `not a text response (${type})` : `HTTP ${res.status}` };
        }
        const buf = await readCapped(res);
        if (!buf) return { status: res.status, type, url: cur, error: "response larger than 3 MB" };
        return { ok: true, status: res.status, type, url: cur, text: decodeBody(buf, type) };
      }
      return { error: "too many redirects", url: cur };
    } catch (e) {
      return { error: netError(e, cur), url: cur };
    } finally {
      this.lastEnd = Date.now();
    }
  }

  async page(url, o) {
    this.reads++;
    const r = await this.get(url, o);
    if (!r.error && !/html|xml/i.test(r.type) && !/^\s*</.test(r.text)) return { ...r, ok: false, error: `not an HTML page (${r.type || "no content-type"})` };
    return r;
  }

  // robots.txt: 2xx → rules; 4xx → no rules; 5xx/429 → unreachable, which RFC 9309 treats as disallow-all.
  async robots(base) {
    const r = await this.get(new URL("/robots.txt", base).href, { anyHost: true, polite: false, accept: "text/plain,*/*;q=0.5" });
    const info = { url: r.url, found: false, sitemaps: [], unreachable: false, status: r.status, error: r.error && !r.status ? r.error : null };
    this.rules = [];
    if (r.ok && !/^\s*</.test(r.text)) {
      const p = parseRobots(r.text);
      Object.assign(info, { found: true, sitemaps: uniq(p.sitemaps.map((s) => toUrl(s, r.url)?.href)) });
      this.rules = p.rules;
      if (p.delay * 1000 > this.delayMs) { this.delay = Math.min(p.delay, 10) * 1000; this.notes.push(`Honouring robots.txt Crawl-delay (${this.delay / 1000}s)`); }
    } else if (r.status >= 500 || r.status === 429) info.unreachable = true;
    return info;
  }

  // Plain HTTP read of one page → { url, status, rendered, p } or null (failure recorded).
  async fetchParsed(url, footer = false) {
    const r = await this.page(url);
    if (r.error) {
      this.failed.push(`${pathOf(url)} (${r.error})`);
      if (r.status === 429) { this.stop = true; this.notes.push("Site answered HTTP 429 (rate limited); stopped early"); }
      if (++this.fails >= 6) { this.stop = true; this.notes.push("Stopped after repeated fetch errors"); }
      return null;
    }
    this.fails = 0;
    return { url: r.url, status: r.status, rendered: false, p: parsePage(r.text, r.url, { footer }) };
  }

  // Headless read of several pages → Map<requested url, { url, status, rendered, p }>.
  async renderParsed(urls, footer = false) {
    const got = new Map();
    if (!urls.length || this.left() < 4000) return got;
    const html = await renderPages(urls, { timeoutMs: Math.min(20000, Math.max(8000, this.timeoutMs)), userAgent: USER_AGENT, deadline: this.deadline - 1500 });
    for (const [u, h] of html) got.set(u, { url: u, status: 200, rendered: true, p: parsePage(h, u, { footer }) });
    this.reads += html.size;
    return got;
  }
}

const toPage = (g, category, fallbackLang = null) => ({
  url: g.url, category, title: g.p.title, lang: g.p.lang || langOf(new URL(g.url)) || fallbackLang, text: g.p.text,
  words: g.p.words, hash: sha1(g.p.text), status: g.status, rendered: g.rendered,
});

// ---------- the crawl ----------
class Crawl extends Site {
  constructor(out, opts) {
    super(opts);
    Object.assign(this, { out, maxPages: opts.maxPages, render: opts.render, pool: new Map(), skip: new Set(), fetched: new Set(), hashes: new Set() });
    Object.assign(this, { kept: {}, ld: [], docs: new Map(), langs: [], external: [], browser: false, lang0: null, rootKey: "" });
  }

  async run(website) {
    const out = this.out, input = String(website ?? "").trim();
    const assumed = !/^https?:\/\//i.test(input);
    let start = input && toUrl(assumed ? `https://${input}` : input);
    if (!start || !/^https?:$/.test(start.protocol) || !(start.hostname.includes(".") || start.hostname === "localhost")) return void (out.error = "Invalid website URL");
    start.hash = "";

    // 1. fail fast on DNS (try the www/apex twin first)
    if (!(await resolves(start.hostname))) {
      const twin = start.hostname.startsWith("www.") ? start.hostname.slice(4) : `www.${start.hostname}`;
      if (!(await resolves(twin))) return void (out.error = `Could not resolve ${start.hostname}`);
      out.warnings.push(`${start.hostname} does not resolve; using ${twin}`);
      start.hostname = twin;
    }
    this.root = start;

    // 2. robots.txt (falls back to http:// when https is broken and no scheme was given)
    let rb = await this.robots(start);
    if (rb.error && assumed && start.protocol === "https:") {
      const alt = new URL(start);
      alt.protocol = "http:";
      const rb2 = await this.robots(alt);
      if (!rb2.error) { out.warnings.push(`HTTPS failed (${rb.error}); using http://`); start = this.root = alt; rb = rb2; }
    }
    if (rb.error) return void (out.error = rb.error);
    if (!this.applyRobots(rb)) return;
    this.log(`robots.txt ${rb.found ? `found (${rb.sitemaps.length} sitemaps)` : "absent"}`);

    // 3. homepage, with sitemaps fetched concurrently
    const smFor = (b) => uniq([...out.robots.sitemaps.slice(0, 3), new URL("/sitemap.xml", b).href, new URL("/sitemap_index.xml", b).href]);
    let smP = Promise.all(smFor(start).map((u) => this.sitemap(u, false)));
    let home = await this.page(start.href, { anyHost: true, polite: false });
    if (home.error) { await smP; return void (out.error = home.status && home.status >= 400 ? `Homepage returned HTTP ${home.status}` : home.error); }
    this.root = new URL(home.url);
    if (this.root.origin !== toUrl(rb.url || start.href)?.origin) { // redirected (http→https, apex→www, new domain): that origin's robots.txt rules
      const rb2 = await this.robots(this.root);
      if (rb2.error) { await smP; return void (out.error = rb2.error); }
      if (!this.applyRobots(rb2)) { await smP; return; }
      if (bare(this.root.hostname) !== bare(start.hostname)) {
        out.warnings.push(`Homepage redirects to ${this.root.host}`);
        await smP;
        smP = Promise.all(smFor(this.root).map((u) => this.sitemap(u)));
      }
    }
    let hp = parsePage(home.text, home.url, { footer: true });
    const hop = hp.refresh && hp.words < 50 && toUrl(hp.refresh, home.url); // meta-refresh splash, e.g. "/" → "/fi/"
    if (hop && this.same(hop) && this.allowed(hop) && hop.href !== home.url) {
      const r = await this.page(hop.href);
      if (!r.error) { home = r; this.root = new URL(r.url); hp = parsePage(r.text, r.url, { footer: true }); }
    }
    out.ok = true;
    out.root = this.root.href;
    out.js_only = hp.jsOnly;
    this.rootKey = keyOf(this.root);
    this.fetched.add(this.rootKey);
    let rendered = false;
    if (this.render === "always" || (this.render === "auto" && hp.jsOnly)) {
      if (await browserAvailable()) {
        const g = (await this.renderParsed([home.url], true)).get(home.url);
        if (g) { hp = g.p; rendered = this.browser = true; out.rendered_with = "browser"; }
        else out.warnings.push("Headless render of the homepage failed; using the raw HTML");
      } else out.warnings.push(hp.jsOnly ? "Homepage looks client-side rendered but no headless browser is available (set BROWSER_PATH)" : "render: \"always\" requested but no headless browser is available");
    }
    this.lang0 = langOf(this.root) || hp.lang;
    out.footer_text = hp.footer;
    this.addPage(home.url, "home", hp, home.status, rendered);
    this.log(`homepage ${out.root} (${hp.words} words${out.js_only ? ", looks JS-only" : ""}${rendered ? ", rendered" : ""})`);

    // 4. sitemaps: robots-listed + defaults; an index contributes ≤5 preferred child sitemaps; ≤2000 URLs
    const maps = (await smP).filter(Boolean);
    const read = new Set(maps.map((m) => m.url));
    const locs = maps.filter((m) => !m.index).flatMap((m) => m.locs);
    const kids = uniq(maps.filter((m) => m.index).flatMap((m) => m.locs)).filter((u) => !read.has(u))
      .map((u, i) => ({ u, i, s: smPref(u) })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 5);
    for (const { u } of kids) {
      if (locs.length >= 2000 || Date.now() - this.t0 > this.budgetMs * 0.3) break;
      const m = await this.sitemap(u);
      if (m && !m.index) locs.push(...m.locs);
    }
    if (!maps.length) out.warnings.push("No sitemap found; discovery relied on links");
    for (const l of uniq(locs).slice(0, 2000)) this.addCand(l);
    this.log(`inventory ${this.pool.size + 1} URLs (${locs.length} from sitemaps)`);

    // 5. quota picks → one hop from the hub pages read → fill the remaining slots by score
    const limit = Math.max(0, this.maxPages - 1);
    await this.readCands(this.pick(limit, true));
    await this.readCands(this.pick(limit - (out.pages.length - 1), false));
    this.finish();
  }

  applyRobots(rb) {
    const out = this.out;
    out.robots.found ||= rb.found;
    out.robots.sitemaps = uniq([...out.robots.sitemaps, ...rb.sitemaps]);
    if (rb.unreachable) {
      out.robots.blocked = true;
      out.error = `robots.txt unreachable (HTTP ${rb.status}); treated as disallow-all per RFC 9309`;
      return false;
    }
    if (!this.allowed(new URL("/", this.root)) || !this.allowed(this.root)) {
      out.robots.blocked = true;
      out.error = "robots.txt disallows MergeroResearchBot";
      return false;
    }
    return true;
  }

  async sitemap(url, polite = true) {
    const u = toUrl(url);
    if (!u || (this.same(u) && !this.allowed(u) && !this.out.robots.sitemaps.includes(url))) return null;
    const r = await this.get(url, { anyHost: true, polite, accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" });
    if (!r.ok || !/<(?:urlset|sitemapindex)[\s>]/i.test(r.text)) return null;
    const locs = [...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)]
      .map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'"));
    return { url: r.url, index: /<sitemapindex[\s>]/i.test(r.text), locs };
  }

  addCand(href, { anchor = "", menu = "", home = false, inherit = null, child = false } = {}) {
    const x = toUrl(href);
    if (!x || !/^https?:$/.test(x.protocol) || !this.same(x)) return;
    const u = canon(x, this.root), path = fold(decode(u.pathname));
    if (ASSET.test(path) || JUNK.test(path) || JUNK_QUERY.test(u.search.slice(1))) return;
    const key = keyOf(u);
    if (key === this.rootKey) return;
    let c = this.pool.get(key);
    if (!c) {
      if (this.pool.size >= 5000) return;
      this.pool.set(key, (c = { url: u.href, key, anchors: new Set(), menus: new Set(), home: false, inherit: null, child: false, done: this.fetched.has(key) }));
    }
    const a = tokens(anchor), m = tokens(menu);
    if (a && c.anchors.size < 6) c.anchors.add(a);
    if (m && c.menus.size < 3) c.menus.add(m);
    c.home ||= home;
    c.inherit ||= inherit;
    c.child ||= child;
  }

  ctx(c) { return { anchors: [...c.anchors], menus: [...c.menus], inherit: c.inherit, home: c.home, child: c.child }; }

  // Round-robin over category quotas (other-language variants only where a category has nothing else),
  // then, unless quotasOnly, the best remaining candidates by score (≤ quota+2 per category).
  pick(limit, quotasOnly) {
    if (limit <= 0 || this.stop || this.left() < 3000) return [];
    const cands = [];
    for (const c of this.pool.values()) {
      if (c.done || this.skip.has(c.key)) continue;
      const u = new URL(c.url);
      if (isHomeUrl(u) || SKIP.test(fold(decode(u.pathname))) || !this.allowed(u)) continue;
      Object.assign(c, rate(u, this.ctx(c)));
      const lang = langOf(u);
      c.foreign = Boolean(lang && lang !== this.lang0);
      cands.push(c);
    }
    cands.sort((a, b) => b.prio - a.prio);
    const count = { ...this.kept }, picks = [];
    const take = (c) => { c.done = true; picks.push(c); count[c.cat] = (count[c.cat] || 0) + 1; };
    for (let r = 0; r < 5; r++) {
      for (const cat of Object.keys(QUOTAS)) {
        if (picks.length >= limit || QUOTAS[cat] <= r || (count[cat] || 0) > r) continue;
        const c = cands.find((x) => !x.done && x.cat === cat && (!x.foreign || !count[cat]));
        if (c) take(c);
      }
    }
    if (!quotasOnly) {
      for (const c of cands) {
        if (picks.length >= limit) break;
        if (!c.done && !c.foreign && c.prio > -1.5 && (count[c.cat] || 0) < (QUOTAS[c.cat] ?? 4) + 2) take(c);
      }
    }
    this.log(`picked ${picks.length}: ${picks.map((c) => `${c.cat}:${pathOf(c.url)}`).join(" ")}`);
    return picks;
  }

  async readCands(list) {
    if (!list.length) return;
    let rest = list;
    if (this.browser) {
      const got = await this.renderParsed(list.map((c) => c.url));
      for (const c of list) if (got.has(c.url)) this.ingest(c, got.get(c.url));
      rest = list.filter((c) => !got.has(c.url));
    }
    for (const c of rest) {
      if (this.stop) break;
      if (this.left() < 2000) { this.notes.push("Time budget reached before all selected pages were read"); break; }
      const g = await this.fetchParsed(c.url);
      if (g) this.ingest(c, g);
    }
  }

  ingest(c, g) {
    const key = keyOf(canon(new URL(g.url), this.root));
    if (this.fetched.has(key)) return; // redirected onto a page we already have
    this.fetched.add(key);
    if (g.p.words < 5) { this.failed.push(`${pathOf(g.url)} (no text)`); return; }
    if (this.addPage(g.url, c.cat, g.p, g.status, g.rendered)) this.log(`read ${c.cat} ${pathOf(g.url)} (${g.p.words} words)`);
  }

  addPage(url, category, p, status, rendered) {
    const page = toPage({ url, status, rendered, p }, category, this.lang0);
    if (this.hashes.has(page.hash)) return false; // same content under another URL (language/query variant)
    this.hashes.add(page.hash);
    this.out.pages.push(page);
    this.kept[category] = (this.kept[category] || 0) + 1;
    this.langs.push(p.lang, ...p.alternates.map((a) => a.lang));
    for (const a of p.alternates) { const x = toUrl(a.url); if (this.same(x)) this.skip.add(keyOf(canon(x, this.root))); } // translations of a page we have
    this.ld.push(...p.ld);
    const isHome = category === "home", hub = HUBS.has(category) ? category : null;
    const parent = new URL(url).pathname.replace(/\/+$/, "");
    for (const l of p.links) {
      const x = new URL(l.url);
      if (/\.pdf$/i.test(x.pathname) || /\.pdf[?#]/i.test(l.url)) { this.addDoc(l.url, l.anchor); continue; }
      if (!this.same(x)) { if (isHome) this.external.push(l.url); continue; }
      const own = hub && l.inMain; // one hop: content links on a hub page inherit its category
      this.addCand(l.url, { anchor: l.anchor, menu: l.menu, home: isHome, inherit: own ? hub : null, child: own && x.pathname.startsWith(`${parent}/`) });
    }
    return true;
  }

  addDoc(href, anchor) {
    const url = href.split("#")[0];
    if (this.docs.has(url) || this.docs.size >= 200) return;
    const hay = fold(`${decode(url)} ${anchor}`), years = yearsIn(hay);
    this.docs.set(url, { url, anchor: squash(anchor).slice(0, 150), category: REPORT_DOC.test(hay) ? "reports" : "other", year: years.length ? Math.max(...years) : null });
  }

  finish() {
    const out = this.out;
    out.languages = uniq(this.langs.filter((l) => /^[a-z]{2,3}$/.test(l || "")));
    const org = mergeOrg(this.ld, (u) => this.same(toUrl(u || "")));
    out.jsonld = { organization: org, types: uniq(this.ld.flatMap(typesOf)).slice(0, 40) };
    out.social = pickSocial([...(org?.sameAs || []), ...this.external]);
    const ids = [];
    for (const t of [out.footer_text, ...out.pages.filter((p) => ["home", "legal", "footprint"].includes(p.category)).map((p) => p.text)]) findIds(t, ids);
    if (org?.vatID) findIds(`VAT ${org.vatID}`, ids);
    for (const v of [org?.taxID, org?.identifier]) if (v) findIds(`Business ID ${v}`, ids);
    out.business_ids = ids;
    const rep = (d) => (d.category === "reports" ? 0 : 1);
    out.documents = [...this.docs.values()].sort((a, b) => rep(a) - rep(b) || (b.year || 0) - (a.year || 0)).slice(0, 100);
    const all = [...this.pool.values()], by = { home: 1 };
    for (const c of all) {
      const u = new URL(c.url);
      const cat = isHomeUrl(u) ? "home" : SKIP.test(fold(decode(u.pathname))) ? "other" : c.cat || rate(u, this.ctx(c)).cat;
      by[cat] = (by[cat] || 0) + 1;
    }
    const depth = (s) => new URL(s).pathname.split("/").filter(Boolean).length;
    const urls = [out.root, ...all.map((c) => c.url).sort((a, b) => depth(a) - depth(b)).slice(0, 1499)].sort();
    out.inventory = { total: all.length + 1, urls, by_category: by };
    out.stats.discovered = out.inventory.total;
    out.stats.fetched = this.reads;
    if (this.failed.length) out.warnings.push(`${this.failed.length} page(s) not read: ${this.failed.slice(0, 5).join("; ")}${this.failed.length > 5 ? "; …" : ""}`);
    out.warnings = uniq([...out.warnings, ...this.notes]);
    this.log(`done: ${out.pages.length} pages, ${out.documents.length} documents, ${out.business_ids.length} IDs`);
  }
}

export async function crawlSite(website, opts = {}) {
  const { maxPages = 24, delayMs = 500, timeoutMs = 15000, budgetMs = 90000, render = "auto", log = () => {} } = opts;
  const out = {
    ok: false, error: null, root: "", robots: { found: false, sitemaps: [], blocked: false },
    inventory: { total: 0, urls: [], by_category: {} }, languages: [], jsonld: { organization: null, types: [] },
    social: {}, business_ids: [], footer_text: "", pages: [], documents: [], js_only: false, rendered_with: "none",
    warnings: [], stats: { discovered: 0, fetched: 0, kept: 0, ms: 0 },
  };
  const crawl = new Crawl(out, { maxPages, delayMs, timeoutMs, budgetMs, render, log });
  try {
    await crawl.run(website);
  } catch (e) {
    out.error ||= `Crawler failed: ${e.message}`;
  }
  if (!out.ok) out.warnings = uniq([...out.warnings, ...crawl.notes]);
  out.stats.fetched ||= crawl.reads;
  out.stats.kept = out.pages.length;
  out.stats.ms = Date.now() - crawl.t0;
  return out;
}

// Reads specific same-site URLs (e.g. newly discovered ones) with the same politeness rules; skips off-site,
// robots-disallowed and failing URLs. Returns page objects shaped like CrawlResult.pages.
export async function readPages(root, urls, opts = {}) {
  const { render = "auto" } = opts;
  const raw = String(root ?? "").trim();
  const start = raw && toUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!start || !/^https?:$/.test(start.protocol)) return [];
  const site = new Site(opts);
  site.root = start;
  try {
    const rb = await site.robots(start);
    if (rb.error || rb.unreachable || !site.allowed(new URL("/", start))) return [];
    const list = [], seen = new Set();
    for (const s of urls || []) {
      const u = toUrl(s, start);
      if (!u || !/^https?:$/.test(u.protocol) || !site.same(u) || !site.allowed(u)) continue;
      const c = canon(u, start), key = keyOf(c);
      if (!seen.has(key)) { seen.add(key); list.push(c.href); }
    }
    const got = new Map();
    if (render === "always" && list.length && (await browserAvailable())) for (const [u, g] of await site.renderParsed(list)) got.set(u, g);
    const thin = [];
    for (const u of list) {
      if (got.has(u)) continue;
      if (site.stop || site.left() < 1500) break;
      const g = await site.fetchParsed(u);
      if (!g) continue;
      got.set(u, g);
      if (render === "auto" && g.p.jsOnly) thin.push(u);
    }
    if (thin.length && (await browserAvailable())) for (const [u, g] of await site.renderParsed(thin)) got.set(u, g);
    const pages = [], hashes = new Set();
    for (const u of list) {
      const g = got.get(u);
      if (!g || g.p.words < 5) continue;
      const page = toPage(g, categorize(g.url));
      if (hashes.has(page.hash)) continue;
      hashes.add(page.hash);
      pages.push(page);
      site.log(`read ${page.category} ${pathOf(page.url)} (${page.words} words)`);
    }
    return pages;
  } catch (e) {
    site.log(`readPages failed: ${e.message}`);
    return [];
  }
}
