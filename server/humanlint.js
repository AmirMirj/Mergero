// Human-language linter for outreach: deterministic, explainable checks that catch machine/template tells,
// audit how personalised a draft really is, and detect wording reused across prospects.
// The LLM humanizer fixes what this finds; the send gate refuses drafts that still fail. No API calls here.

const STOCK = [
  [/\bi hope (this|you|all is|you're|you are)\b/i, "stock opener", "high"],
  [/\bi (came|stumbled) across\b/i, "stock opener", "medium"],
  [/\b(i wanted|i'm|i am) (to )?reach(ing)? out\b/i, "stock opener", "high"],
  [/\bjust (checking in|touching base|following up|circling back)\b/i, "template follow-up", "high"],
  [/\b(hope|trust) (you're|you are|this finds you|all is) (well|doing well)\b/i, "stock opener", "high"],
  [/\bdear (sir|madam|sir\/madam|team|owner)\b/i, "impersonal salutation", "high"],
  [/\bto whom it may concern\b/i, "impersonal salutation", "high"],
  [/\b(i('d| would) love to|would love to connect)\b/i, "salesy phrasing", "medium"],
  [/\blooking forward to hearing from you\b/i, "stock closer", "medium"],
  [/\b(please )?don'?t hesitate\b/i, "stock closer", "medium"],
  [/\bexciting opportunity\b/i, "marketing tone", "high"],
  [/\bquick question\b/i, "cold-email cliché", "medium"],
  [/\b(perfect|ideal) (fit|match) for\b/i, "marketing tone", "low"],
  [/\bno pressure\b/i, "cold-email cliché", "low"],
];
const AI_WORDS = ["delve", "leverage", "synerg", "landscape", "unlock", "streamline", "robust", "seamless", "cutting-edge", "game-changer", "game changer", "tapestry", "testament", "in today's", "elevate", "empower", "harness", "holistic", "ecosystem", "paradigm", "transformative", "world-class", "best-in-class", "state-of-the-art", "unparalleled", "impressive growth", "resonate", "at the intersection of", "it's worth noting", "furthermore", "moreover", "additionally", "navigate the", "journey", "supercharge", "next level", "value proposition", "reach out", "touch base", "bandwidth", "move the needle", "low-hanging", "win-win"];
const FLATTERY = /\b(impressive|remarkable|outstanding|incredible|amazing|fantastic|great work|congratulations on|truly|genuinely)\b/i;
const GERMAN_DU = /\b(du|dich|dir|dein|deine|deinem|deinen|deiner)\b/i;
const GERMAN_SIE = /\b(Sie|Ihnen|Ihr|Ihre|Ihrem|Ihren|Ihrer)\b/;

const STOPWORDS = new Set("the a an and or of to in for on with at by from as is are was were be been it its this that these those we you your our i my me they their them he she his her not no but if then than so such into over under about after before more most very can could would should may might will just also only one two three what which who whom when where how all any some each other another same own same too".split(" "));

const sentences = (t) => t.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-ZÄÖÅÜ0-9"“])/).map((s) => s.trim()).filter((s) => s.length > 1);
const words = (t) => (t.match(/[\p{L}\p{N}'’-]+/gu) || []);
const sig = (t) => words(t.toLowerCase()).filter((w) => w.length > 3 && !STOPWORDS.has(w));

// Distinctive tokens from a fact string: numbers, capitalised words and long words.
function tokensOf(s) {
  return new Set(words(String(s || "")).filter((w) => /^\p{Lu}/u.test(w) || /\d/.test(w) || w.length > 7).map((w) => w.toLowerCase()).filter((w) => !STOPWORDS.has(w)));
}

export function lint(body, opts = {}) {
  const { subject = "", language = "en", channel = "email", company = {}, facts = [], previous = [] } = opts;
  const text = String(body || "");
  const full = `${subject}\n${text}`;
  const flags = [];
  const add = (rule, severity, excerpt, fix) => flags.push({ rule, severity, excerpt: excerpt ? String(excerpt).slice(0, 80) : "", fix });

  // 1. Stock phrases and AI vocabulary
  for (const [re, rule, sev] of STOCK) { const m = full.match(re); if (m) add(rule, sev, m[0], "Replace with a specific reason for writing"); }
  const lower = full.toLowerCase();
  for (const w of AI_WORDS) if (lower.includes(w)) add("AI vocabulary", "medium", w, "Use a plain word or cut it");
  const fl = text.match(FLATTERY); if (fl) add("generic flattery", "medium", fl[0], "State the fact instead of the adjective");

  // 2. Punctuation and formatting
  if (/—/.test(text) || /\s–\s/.test(text)) add("em dash", "high", "—", "Use a comma or a full stop");
  const ex = (text.match(/!/g) || []).length; if (ex) add("exclamation mark", "high", "!", "Remove");
  if (/^\s*([-*•]|\d+[.)])\s+/m.test(text)) add("bullet or numbered list", "high", "list", "Write it as sentences");
  if (/^#+\s|\*\*[^*]+\*\*/m.test(text)) add("markdown formatting", "high", "**/#", "Plain text only");
  if (/\p{Extended_Pictographic}/u.test(text)) add("emoji", "high", "emoji", "Remove");
  if ((text.match(/;/g) || []).length > 1) add("semicolons", "low", ";", "Split the sentence");
  if ((text.match(/…|\.\.\./g) || []).length > 1) add("ellipses", "low", "…", "Finish the thought");
  if (/\[[^\]]{1,40}\]|\{\{|\bFIRST_NAME\b|\bCOMPANY_NAME\b/.test(full)) add("placeholder", "high", (full.match(/\[[^\]]{1,40}\]|\{\{[^}]*\}\}/) || ["[…]"])[0], "Fill in the real detail");
  if (/\b(AI|artificial intelligence|automated|automation|this (email )?sequence|generated)\b/i.test(text)) add("mentions AI or automation", "high", (text.match(/\b(AI|automated|sequence|generated)\b/i) || [""])[0], "Never mention how the email was produced");

  // 3. Rhythm and structure
  const ss = sentences(text);
  const lens = ss.map((s) => words(s).length);
  const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const sd = lens.length > 1 ? Math.sqrt(lens.reduce((a, l) => a + (l - avg) ** 2, 0) / lens.length) : 0;
  if (lens.length >= 4 && sd < 2.2) add("uniform sentence rhythm", "medium", `${lens.join("/")} words`, "Vary sentence length; one short sentence helps");
  if (avg > 24) add("long sentences", "medium", `${Math.round(avg)} words on average`, "Cut sentences in half");
  const triads = (text.match(/\b\w+, \w+,? and \w+\b/g) || []).length; if (triads >= 2) add("rule-of-three lists", "medium", `${triads} triads`, "Keep one item, drop the rest");
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const wc = words(text).length;
  if (channel === "email" && paras.length === 1 && wc > 70) add("single block of text", "medium", `${wc} words, one paragraph`, "Break into two or three short paragraphs");
  const band = channel === "email" ? [60, 170] : channel === "linkedin" ? [25, 100] : [40, 220];
  if (wc < band[0]) add("too short", "low", `${wc} words`, `Aim for ${band[0]}–${band[1]} words`);
  if (wc > band[1]) add("too long", "medium", `${wc} words`, `Aim for ${band[0]}–${band[1]} words`);
  const qs = (text.match(/\?/g) || []).length; if (qs > 2) add("too many questions", "medium", `${qs} questions`, "Ask one thing");
  const hedges = (lower.match(/\b(perhaps|maybe|might|may|could|possibly|potentially)\b/g) || []).length; if (hedges > 3) add("over-hedging", "low", `${hedges} hedges`, "Say it plainly");
  if (language === "en" && wc > 60 && !/\b\w+'(s|t|re|ve|ll|d|m)\b/i.test(text)) add("no contractions", "low", "formal register", "One or two contractions read more human");
  // repetition of a content word
  const counts = {}; for (const w of sig(text)) counts[w] = (counts[w] || 0) + 1;
  const rep = Object.entries(counts).filter(([w, n]) => n >= 4 && !(company.name || "").toLowerCase().includes(w)).map(([w, n]) => `${w}×${n}`);
  if (rep.length) add("word repeated", "low", rep.join(", "), "Rephrase one of them");

  // 4. Personal address and brand hygiene
  const first = String(company.owner?.name || "").split(/\s+/)[0] || "";
  if (channel !== "call_script" && first && !new RegExp(`\\b${first}\\b`, "i").test(text)) add("owner not addressed by name", "medium", first, "Open with the first name");
  const nameCount = first ? (text.match(new RegExp(`\\b${first}\\b`, "gi")) || []).length : 0; if (nameCount > 2) add("name overused", "low", `${first}×${nameCount}`, "Use the name once");
  const brand = (text.match(/\bMergero\b/g) || []).length; if (brand > 2) add("brand overused", "low", `Mergero×${brand}`, "Mention the firm once");
  const cname = (company.name || "").split(/\s+/)[0]; if (cname && cname.length > 3) { const cc = (text.match(new RegExp(`\\b${cname}`, "gi")) || []).length; if (cc > 2) add("company name overused", "low", `${cname}×${cc}`, "Say 'your company' or 'the business'"); }
  if (/(€|eur|m€|million)\s?\d|\d[\d.,]*\s?(m€|million|meur|€m)/i.test(text) && /\b(revenue|turnover|ebitda|margin|profit|sales)\b/i.test(text)) add("quotes their financial figures", "high", (text.match(/[^.]*\b(revenue|turnover|ebitda|margin|profit)\b[^.]*\./i) || [""])[0], "Never read the owner's own numbers back to them");
  if (language === "de" && GERMAN_DU.test(text) && GERMAN_SIE.test(text)) add("mixed du/Sie", "high", "du + Sie", "Use Sie consistently");
  if (/\b(sell your (company|business)|exit strategy|M&A process|valuation)\b/i.test(text) && opts.step === 1) add("pitches a sale in the first touch", "high", (text.match(/sell your (company|business)|exit strategy|M&A process|valuation/i) || [""])[0], "Open the conversation; never propose a sale in touch 1");

  // 5. Personalisation audit: which specific facts made it into the text?
  const points = [];
  for (const f of facts) {
    const label = typeof f === "string" ? f : (f.claim || f.label || "");
    const toks = tokensOf(label);
    const hit = [...toks].filter((t) => lower.includes(t));
    if (hit.length >= Math.min(2, toks.size) && hit.length > 0) points.push({ fact: String(label).slice(0, 100), tokens: hit.slice(0, 4) });
  }
  // Timo: what failed before were promotional or templated emails; each one must make clear why THIS company.
  // A first touch therefore needs two sourced, company-specific facts; later touches and replies need one.
  const needed = opts.step === 1 ? 2 : 1;
  const personalization = { points, count: points.length, needed, generic: points.length < needed };
  if (personalization.generic && facts.length) add(points.length ? "why this company is not clear enough" : "generic: no specific fact used", "high", "", `Reference ${needed === 2 ? "two" : "one"} concrete, sourced detail${needed === 2 ? "s" : ""} about their company so the owner sees why they, specifically, are being written to`);

  // 6. Cross-prospect similarity: shingle overlap with earlier drafts sent to other companies.
  const shingles = (t) => { const w = words(t.toLowerCase()); const s = new Set(); for (let i = 0; i + 6 <= w.length; i++) s.add(w.slice(i, i + 6).join(" ")); return s; };
  const mine = shingles(text);
  let similarity = { max: 0, with: null, shared: [] };
  for (const p of previous) {
    if (!p.body || p.company_id === company.id) continue;
    const theirs = shingles(p.body);
    const shared = [...mine].filter((s) => theirs.has(s));
    const score = mine.size ? shared.length / mine.size : 0;
    if (score > similarity.max) similarity = { max: Math.round(score * 100) / 100, with: p.company_name || p.company_id, shared: shared.slice(0, 3) };
  }
  if (similarity.max >= 0.12) add("wording reused from another prospect", "high", similarity.shared[0] || "", `Rewrite the shared passage (also sent to ${similarity.with})`);

  // Score: 0 = reads fully human. Weighted by severity, capped.
  const weight = { high: 14, medium: 7, low: 3 };
  const score = Math.min(100, flags.reduce((a, f) => a + weight[f.severity], 0));
  const grade = score <= 15 ? "human" : score <= 35 ? "acceptable" : "robotic";
  const hard = flags.some((f) => ["placeholder", "mentions AI or automation", "quotes their financial figures", "wording reused from another prospect", "mixed du/Sie", "pitches a sale in the first touch"].includes(f.rule));
  return {
    score, grade, flags, personalization, similarity,
    metrics: { words: wc, sentences: ss.length, avg_sentence: Math.round(avg * 10) / 10, rhythm_sd: Math.round(sd * 10) / 10, paragraphs: paras.length, questions: qs },
    blocks_send: hard || score > (opts.threshold ?? 35),
    linted_at: new Date().toISOString(),
  };
}

// Facts worth checking a draft against: enrichment specifics + sourced research claims.
export function factsFor(company) {
  const e = company.enrichment || {};
  const out = [];
  for (const p of e.products || []) out.push(`product: ${p}`);
  for (const c of e.customers || []) out.push(`customer: ${c}`);
  for (const n of e.recent_news || []) out.push(n);
  for (const s of e.signals || []) out.push(s);
  if (e.offering?.summary) out.push(e.offering.summary);
  for (const f of company.research?.facts || []) if (f.confidence !== "low") out.push(f.claim);
  return out.slice(0, 40);
}

// Earlier drafts to other companies (for the reuse check).
export function previousDrafts(companies, exceptId, limit = 60) {
  const out = [];
  for (const c of companies) {
    if (c.id === exceptId) continue;
    for (const m of c.messages || []) if (m.step > 0 && m.body) out.push({ company_id: c.id, company_name: c.name, body: m.body });
  }
  return out.slice(-limit);
}
