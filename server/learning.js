// Learning loop: what actually gets replies, meetings and mandates — by framing, country, sector, language and source —
// computed from the pipeline's own records, and fed back into scoring and the framing suggestion.
// While real history is thin (a hackathon), a clearly labelled sample history from data/mock/outcomes_history.json is blended in.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(here, "..", "data", "mock", "outcomes_history.json");
const MEETING = new Set(["meeting_booked", "mandate_signed"]);

// One row per first touch that actually went out.
export function outcomes() {
  const rows = [];
  for (const c of db.load().companies) {
    const first = (c.messages || []).filter((m) => m.step === 1 && m.sent_at).sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)))[0];
    if (!first) continue;
    const replied = (c.conversation || []).some((e) => e.direction === "inbound" && e.channel !== "intake" && String(e.at) > String(first.sent_at));
    rows.push({
      company_id: c.id, framing: first.framing || "open", country: c.country, sector: c.industry || "unknown", language: first.language || "en",
      channel: first.channel, source: sourceKind(c.source), readiness: c.score?.readiness ?? null,
      replied, meeting: MEETING.has(c.stage), mandate: c.stage === "mandate_signed", sample: false,
    });
  }
  return rows;
}
export function sourceKind(s = "") {
  s = String(s).toLowerCase();
  if (s.startsWith("registry")) return "registry";
  if (s.includes("referral") || s.includes("partner")) return "referral";
  if (s.includes("inbound")) return "inbound";
  if (s.includes("scraper")) return "scraper";
  if (s.includes("database")) return "prospect database";
  return s ? "other" : "manual";
}

function sampleHistory() {
  try { return JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8")).map((r) => ({ ...r, sample: true })); } catch { return []; }
}

function rates(rows, key) {
  const g = {};
  for (const r of rows) {
    const k = r[key] || "unknown";
    g[k] = g[k] || { n: 0, replied: 0, meeting: 0, mandate: 0, sample_n: 0 };
    g[k].n++; if (r.replied) g[k].replied++; if (r.meeting) g[k].meeting++; if (r.mandate) g[k].mandate++; if (r.sample) g[k].sample_n++;
  }
  return Object.entries(g).map(([k, v]) => ({ key: k, n: v.n, sample_n: v.sample_n, reply_rate: v.n ? v.replied / v.n : 0, meeting_rate: v.n ? v.meeting / v.n : 0, mandate_rate: v.n ? v.mandate / v.n : 0 }))
    .sort((a, b) => b.n - a.n);
}

export function learning({ minReal = 8 } = {}) {
  const real = outcomes();
  const sample = real.length < minReal ? sampleHistory() : [];
  const rows = [...real, ...sample];
  const by = (k) => rates(rows, k);
  // Best framing per country (and per sector) with at least 4 observations.
  const best = {};
  for (const r of rows) {
    const key = r.country; best[key] = best[key] || {};
    const f = best[key][r.framing] = best[key][r.framing] || { n: 0, replied: 0 };
    f.n++; if (r.replied) f.replied++;
  }
  const best_framing_by_country = Object.fromEntries(Object.entries(best).map(([country, fr]) => {
    const ranked = Object.entries(fr).filter(([, v]) => v.n >= 4).map(([framing, v]) => ({ framing, n: v.n, reply_rate: v.replied / v.n })).sort((a, b) => b.reply_rate - a.reply_rate);
    return [country, ranked[0] || null];
  }));
  const overall = { n: rows.length, real_n: real.length, sample_n: sample.length, reply_rate: rows.length ? rows.filter((r) => r.replied).length / rows.length : 0, meeting_rate: rows.length ? rows.filter((r) => r.meeting).length / rows.length : 0, mandate_rate: rows.length ? rows.filter((r) => r.mandate).length / rows.length : 0 };
  return { overall, sample_included: sample.length > 0, by_framing: by("framing"), by_country: by("country"), by_sector: by("sector"), by_language: by("language"), by_source: by("source"), best_framing_by_country, generated_at: new Date().toISOString() };
}

// Short text for prompts: what has worked for prospects like this one.
export function summaryFor(company) {
  const L = learning();
  const pct = (x) => `${Math.round(x * 100)}%`;
  const lines = [];
  const bf = L.best_framing_by_country[company.country];
  if (bf) lines.push(`In ${company.country}, the "${bf.framing}" framing has the best reply rate (${pct(bf.reply_rate)}, n=${bf.n}).`);
  const sec = L.by_sector.find((s) => s.key === company.industry); if (sec && sec.n >= 4) lines.push(`${company.industry}: reply rate ${pct(sec.reply_rate)}, meeting rate ${pct(sec.meeting_rate)} (n=${sec.n}).`);
  const src = L.by_source.find((s) => s.key === sourceKind(company.source)); if (src && src.n >= 4) lines.push(`Prospects sourced via ${src.key} convert to mandates at ${pct(src.mandate_rate)} (n=${src.n}).`);
  if (L.overall.n) lines.push(`Overall: reply ${pct(L.overall.reply_rate)}, meeting ${pct(L.overall.meeting_rate)}, mandate ${pct(L.overall.mandate_rate)} across ${L.overall.n} first touches${L.sample_included ? " (includes sample history)" : ""}.`);
  return lines.join(" ");
}
export function bestFramingFor(company) { return learning().best_framing_by_country[company.country] || null; }

export function register(app) {
  app.get("/api/learning", (req, res) => res.json(learning()));
}
