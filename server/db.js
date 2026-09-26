// In-memory state persisted to a JSON file, or to Postgres when DATABASE_URL is set (see init()).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TIME_SAVED_MINUTES } from "./playbook.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(here, "..", "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const SEED_PATH = path.join(here, "..", "data", "seed.json");

const DEFAULT_SETTINGS = {
  api_key: process.env.ANTHROPIC_API_KEY || "",
  workspace_id: process.env.ANTHROPIC_WORKSPACE_ID || "",
  model: process.env.CLAUDE_MODEL || "claude-opus-5",
  sender: {
    name: "Timo Tontti",
    title: "Managing Partner, Head of Sell-side Advisory",
    firm: "Mergero",
    email: "timo.tontti@mergero.com",
    phone: "+358 400 274491",
  },
  style_rules:
    "Short. Plain words. One concrete reason we are writing, tied to something specific about their company. " +
    "Mention concrete buyer demand from our network without naming buyers. No em dashes, no 'I hope this finds you well', " +
    "no bullet lists, no 'delve', no 'synergies', no 'leverage', no exclamation marks, no flattery. " +
    "Sound like a person who has done 50 deals and is writing one email, not a marketing team.",
  value_props: [
    "2,000+ verified buyers with €52B+ of aggregate appetite",
    "€500M+ of deals closed, 18 transactions in H1 2026",
    "Off-market process: no auction, no public leak, owner stays in control",
  ],
  funnel_assumptions: { contact_to_reply: 0.18, reply_to_meeting: 0.45, meeting_to_mandate: 0.3 },
  // Real email (server/mail.js): Resend for sending, Resend receiving for owner replies. Settings override the environment.
  mail: {
    resend_api_key: process.env.RESEND_API_KEY || "",
    from: process.env.RESEND_FROM || "",
    inbound_domain: process.env.MAIL_INBOUND_DOMAIN || "",
    webhook_secret: process.env.RESEND_WEBHOOK_SECRET || "",
  },
};

let state = null;

function loadSeed() {
  if (!fs.existsSync(SEED_PATH)) return { companies: [], buyers: [] };
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
  return { companies: seed.companies || [], buyers: seed.buyers || [] };
}

// Older files lack newer fields; environment values fill blanks left in the saved settings.
function normalizeState(s) {
  s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  s.settings.mail = { ...DEFAULT_SETTINGS.mail, ...(s.settings.mail || {}) };
  for (const k of Object.keys(DEFAULT_SETTINGS.mail)) if (!s.settings.mail[k] && DEFAULT_SETTINGS.mail[k]) s.settings.mail[k] = DEFAULT_SETTINGS.mail[k];
  if (!s.settings.api_key && process.env.ANTHROPIC_API_KEY) s.settings.api_key = process.env.ANTHROPIC_API_KEY;
  s.inbox_unmatched = Array.isArray(s.inbox_unmatched) ? s.inbox_unmatched : [];
  return s;
}

export function load() {
  if (state) return state;
  if (fs.existsSync(DB_PATH)) {
    state = normalizeState(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
  } else {
    state = normalizeState({ ...loadSeed(), settings: { ...DEFAULT_SETTINGS } });
    save();
  }
  return state;
}

export function resetToSeed() {
  const settings = state?.settings || { ...DEFAULT_SETTINGS };
  state = normalizeState({ ...loadSeed(), settings });
  save();
  return state;
}

let writeTimer = null;
export function save() {
  // debounce writes; always write the latest state
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    if (pg) { pgChain = pgChain.then(persistPg).catch((err) => console.error("[db] Postgres write failed:", err.message)); return; }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DB_PATH);
  }, 50);
}

// ---- Postgres (optional). State stays in memory; each save upserts only the rows whose JSON changed. ----
let pg = null;
let pgChain = Promise.resolve();
const written = new Map(); // row key → signature of what Postgres holds

const PG_SCHEMA = [
  "create table if not exists mergero_companies (id text primary key, pos integer not null, doc jsonb not null, updated_at timestamptz not null default now())",
  "create table if not exists mergero_buyers (id text primary key, pos integer not null, doc jsonb not null)",
  "create table if not exists mergero_kv (key text primary key, value jsonb not null)",
];

function pgRows() {
  const rows = new Map();
  state.companies.forEach((c, i) => rows.set(`c:${c.id}`, { sig: `${i}|${JSON.stringify(c)}`, sql: "insert into mergero_companies (id, pos, doc) values ($1, $2, $3::text::jsonb) on conflict (id) do update set pos = excluded.pos, doc = excluded.doc, updated_at = now()", params: [c.id, i, JSON.stringify(c)] }));
  state.buyers.forEach((b, i) => rows.set(`b:${b.id}`, { sig: `${i}|${JSON.stringify(b)}`, sql: "insert into mergero_buyers (id, pos, doc) values ($1, $2, $3::text::jsonb) on conflict (id) do update set pos = excluded.pos, doc = excluded.doc", params: [b.id, i, JSON.stringify(b)] }));
  const s = JSON.stringify(state.settings);
  rows.set("kv:settings", { sig: s, sql: "insert into mergero_kv (key, value) values ('settings', $1::text::jsonb) on conflict (key) do update set value = excluded.value", params: [s] });
  const u = JSON.stringify(state.inbox_unmatched || []);
  rows.set("kv:inbox_unmatched", { sig: u, sql: "insert into mergero_kv (key, value) values ('inbox_unmatched', $1::text::jsonb) on conflict (key) do update set value = excluded.value", params: [u] });
  return rows;
}

async function persistPg() {
  const rows = pgRows();
  for (const [key, r] of rows) {
    if (written.get(key) === r.sig) continue;
    await pg.query(r.sql, r.params);
    written.set(key, r.sig);
  }
  for (const key of [...written.keys()]) {
    if (rows.has(key)) continue;
    const [kind, id] = [key.slice(0, 1), key.slice(2)];
    if (kind === "c") await pg.query("delete from mergero_companies where id = $1", [id]);
    if (kind === "b") await pg.query("delete from mergero_buyers where id = $1", [id]);
    written.delete(key);
  }
}

// Call once before serving. Without DATABASE_URL (or an injected client) this is the JSON-file store.
// On an empty database the current JSON file (or the seed) is migrated in on first start.
export async function init({ client } = {}) {
  if (!client && !process.env.DATABASE_URL) { load(); return "file"; }
  if (!client) {
    const { default: pgLib } = await import("pg");
    client = new pgLib.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  }
  pg = client;
  for (const sql of PG_SCHEMA) await pg.query(sql);
  const cs = await pg.query("select doc from mergero_companies order by pos");
  const bs = await pg.query("select doc from mergero_buyers order by pos");
  const kv = await pg.query("select key, value from mergero_kv");
  const saved = kv.rows.find((r) => r.key === "settings")?.value;
  const unmatched = kv.rows.find((r) => r.key === "inbox_unmatched")?.value;
  state = null;
  if (cs.rows.length || bs.rows.length || saved) {
    state = normalizeState({ companies: cs.rows.map((r) => r.doc), buyers: bs.rows.map((r) => r.doc), settings: saved || {}, inbox_unmatched: unmatched || [] });
    for (const [key, r] of pgRows()) written.set(key, r.sig);
  } else {
    load();
  }
  await flush();
  return "postgres";
}

// Wait for pending writes (Postgres) — used on shutdown and in tests.
export async function flush() {
  if (!pg) return;
  clearTimeout(writeTimer);
  pgChain = pgChain.then(persistPg);
  await pgChain;
}

export function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

export const now = () => new Date().toISOString();

export function channelFor(country) {
  return ["DE", "AT", "CH"].includes((country || "").toUpperCase()) ? "linkedin" : "email";
}

export function normalizeCompany(input) {
  const c = { ...input };
  const t = now();
  c.id = c.id || uid("c");
  c.country = (c.country || "FI").toUpperCase();
  c.channel = c.channel || channelFor(c.country);
  c.owner = c.owner || {};
  c.stage = c.stage || "new";
  c.enrichment = c.enrichment ?? null;
  c.score = c.score ?? null;
  c.matches = c.matches || [];
  c.messages = c.messages || [];
  c.conversation = c.conversation || [];
  c.intake = c.intake ?? null;
  c.notes = c.notes || "";
  c.source = c.source || "Manual";
  c.created_at = c.created_at || t;
  c.updated_at = t;
  for (const k of ["revenue_eur", "ebitda_eur", "employees", "founded"]) {
    if (c[k] !== undefined && c[k] !== null && c[k] !== "") c[k] = Number(c[k]);
    else c[k] = null;
  }
  if (c.owner.age !== undefined && c.owner.age !== "") c.owner.age = Number(c.owner.age);
  return c;
}

export function findCompany(id) {
  return load().companies.find((c) => c.id === id);
}
export function findMessage(id) {
  for (const c of load().companies) {
    const m = c.messages.find((m) => m.id === id);
    if (m) return { company: c, message: m };
  }
  return null;
}
// A sent email by the id the provider (Resend) gave it; delivery webhooks report on that id.
export function findMessageByDeliveryId(id) {
  if (!id) return null;
  for (const c of load().companies) {
    const m = c.messages.find((m) => m.delivery?.id === id);
    if (m) return { company: c, message: m };
  }
  return null;
}
export function touch(company) {
  company.updated_at = now();
  save();
  return company;
}

export function publicSettings() {
  const s = load().settings;
  const key = s.api_key || "";
  return {
    api_key_set: Boolean(key),
    api_key_masked: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : "",
    workspace_id: s.workspace_id || "",
    model: s.model,
    sender: s.sender,
    style_rules: s.style_rules,
    value_props: s.value_props,
    funnel_assumptions: s.funnel_assumptions,
    mail: publicMail(s),
  };
}
function publicMail(s) {
  const m = s.mail || {};
  const key = m.resend_api_key || "";
  return {
    configured: Boolean(key && m.from),
    api_key_set: Boolean(key),
    api_key_masked: key ? `${key.slice(0, 5)}…${key.slice(-4)}` : "",
    from: m.from || "",
    inbound_domain: m.inbound_domain || "",
    webhook_secret_set: Boolean(m.webhook_secret),
  };
}

export const STAGES = [
  "new", "enriched", "outreach_ready", "contacted", "replied", "warming", "meeting_booked", "mandate_signed", "disqualified",
];
const ORDER = Object.fromEntries(STAGES.map((s, i) => [s, i]));
// Only move forward automatically; never regress a stage the advisor set by hand.
export function advance(company, stage) {
  if (company.stage === "disqualified" || company.stage === "mandate_signed") return;
  if ((ORDER[stage] ?? -1) > (ORDER[company.stage] ?? -1)) company.stage = stage;
}

// ---- inbox: one thread per prospect, derived from its conversation and messages ----
const byAt = (a, b) => String(a.at || "").localeCompare(String(b.at || ""));
const OPEN_REPLY = new Set(["draft", "approved"]);
// needs_reply: the owner spoke last, or an advisor reply is drafted but unsent. waiting: we spoke last (or a follow-up is
// scheduled). done: the prospect left the pipeline. null: no conversation yet, so not in the inbox.
export function inboxStatus(c) {
  const conv = c.conversation || [];
  const msgs = c.messages || [];
  if (!conv.length && !msgs.some((m) => m.status === "scheduled")) return null;
  if (c.stage === "disqualified" || c.stage === "mandate_signed") return "done";
  if (msgs.some((m) => !m.step && OPEN_REPLY.has(m.status))) return "needs_reply";
  const last = conv.slice().sort(byAt).pop();
  if (last && last.direction === "inbound" && last.channel !== "intake") return "needs_reply";
  return "waiting";
}
export function inboxItem(c) {
  const status = inboxStatus(c);
  if (!status) return null;
  const conv = (c.conversation || []).slice().sort(byAt);
  const msgs = c.messages || [];
  const last = conv[conv.length - 1] || null;
  const lastIn = conv.filter((e) => e.direction === "inbound").pop() || null;
  const reply = msgs.find((m) => !m.step && OPEN_REPLY.has(m.status)) || null;
  const t = lastIn?.triage || null;
  return {
    company_id: c.id, name: c.name, country: c.country, stage: c.stage, channel: c.channel,
    owner: { name: c.owner?.name || "", email: c.owner?.email || "", email_status: c.owner?.email_status || null },
    status,
    last_at: last?.at || c.updated_at,
    last_direction: last?.direction || null,
    last_channel: last?.channel || null,
    last_text: String(last?.text || "").replace(/^Subject: [^\n]*\n\n?/, "").slice(0, 160),
    last_subject: lastIn?.subject || null,
    triage: t ? { intent: t.intent, sentiment: t.sentiment, sentiment_trend: t.sentiment_trend || "flat", next_step: t.next_step, open_questions: t.open_questions || [] } : null,
    triage_pending: Boolean(lastIn && !lastIn.triage && !lastIn.triage_error),
    triage_error: lastIn?.triage_error || null,
    reply_draft: reply ? { id: reply.id, status: reply.status } : null,
    scheduled: msgs.filter((m) => m.status === "scheduled").length,
    due: msgs.filter((m) => m.status === "scheduled" && m.due).length,
    readiness: c.score?.readiness ?? null,
  };
}

export function stats() {
  const { companies, settings } = load();
  const by_stage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  let scoreSum = 0, scoreN = 0, pending = 0, unhandled = 0, minutesSaved = 0, scheduled = 0, due = 0;
  const T = TIME_SAVED_MINUTES;
  for (const c of companies) {
    by_stage[c.stage] = (by_stage[c.stage] || 0) + 1;
    if (c.score?.readiness != null) { scoreSum += c.score.readiness; scoreN++; }
    pending += c.messages.filter((m) => m.status === "draft").length;
    scheduled += c.messages.filter((m) => m.status === "scheduled").length;
    due += c.messages.filter((m) => m.status === "scheduled" && m.due).length;
    if (inboxStatus(c) === "needs_reply") unhandled++;
    // Analyst time the agents replaced (Mergero: "less manual prospect research and first-touch outreach").
    if (c.research) minutesSaved += T.research || 30;
    if (c.enrichment) minutesSaved += T.enrichment;
    if (c.score) minutesSaved += T.scoring;
    if (c.matches?.length) minutesSaved += T.buyer_matching;
    if (c.messages.some((m) => m.step > 0)) minutesSaved += T.outreach_sequence;
    minutesSaved += (c.conversation || []).filter((e) => e.triage).length * T.reply_triage;
    if (c.intake?.status === "complete") minutesSaved += T.intake_summary;
  }
  const f = settings.funnel_assumptions;
  const active = companies.filter((c) => !["disqualified", "mandate_signed"].includes(c.stage));
  const projected = active.reduce((acc, c) => {
    const p = (c.score?.readiness ?? 40) / 100;
    return acc + p * f.contact_to_reply * f.reply_to_meeting * f.meeting_to_mandate * 4; // readiness scales reply odds
  }, 0) + by_stage.mandate_signed;
  return {
    by_stage,
    total: companies.length,
    avg_readiness: scoreN ? Math.round(scoreSum / scoreN) : null,
    projected_mandates: Math.round(projected * 10) / 10,
    messages_pending_approval: pending,
    messages_scheduled: scheduled,
    messages_due: due,
    replies_unhandled: unhandled,
    inbox_unmatched: (load().inbox_unmatched || []).length,
    hours_saved: Math.round(minutesSaved / 6) / 10,
  };
}
