#!/usr/bin/env node
// Mergero Origination Engine — Model Context Protocol server (stdio).
//
// Exposes the engine's REST API (server/index.js) to MCP clients: Claude Desktop, Claude Code, the MCP Inspector or any
// agent. Mergero already runs its outreach through Claude and MCP against its own database; this server plugs the
// engine into that workflow. Every message still passes a human approval step (approve → send) unless the client
// deliberately calls the send tool, and the tool descriptions say so.
//
// Config (env):  MERGERO_API_URL   base URL of the engine   (default http://localhost:3000)
// Run:           node index.js     |  npm run inspect  (MCP Inspector)
// Pattern ported from the HMD CRM MCP server (email-io/mcp): one client, registerTool per operation, guard() on errors.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MergeroClient, qs } from "./client.js";

const API_URL = process.env.MERGERO_API_URL || "http://localhost:3000";
const client = new MergeroClient(API_URL);

// ---- result helpers ---------------------------------------------------------------------------------------------
const text = (s) => ({ content: [{ type: "text", text: String(s) }] });
const json = (obj) => text(JSON.stringify(obj, null, 2));
async function guard(fn) {
  try { return await fn(); }
  catch (err) { return { isError: true, content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }; }
}

// ---- compact views (a researched prospect is tens of kilobytes; agents rarely need the crawl details) --------------
const lastInbound = (c) => (c.conversation || []).filter((e) => e.direction === "inbound").pop() || null;
function compactCompany(c) {
  const li = lastInbound(c);
  return {
    id: c.id, name: c.name, country: c.country, city: c.city, industry: c.industry, website: c.website,
    revenue_eur: c.revenue_eur, ebitda_eur: c.ebitda_eur, employees: c.employees, founded: c.founded, ownership_type: c.ownership_type,
    owner: c.owner, stage: c.stage, channel: c.channel, source: c.source,
    readiness: c.score?.readiness ?? null, attractiveness: c.score?.attractiveness ?? null, recommended_timing: c.score?.recommended_timing ?? null,
    buyers_matched: (c.matches || []).length,
    drafts_pending: (c.messages || []).filter((m) => m.status === "draft").length,
    follow_ups_scheduled: (c.messages || []).filter((m) => m.status === "scheduled").length,
    conversation_entries: (c.conversation || []).length,
    last_inbound: li ? { at: li.at, intent: li.triage?.intent ?? null, sentiment: li.triage?.sentiment ?? null } : null,
    researched_at: c.research?.ran_at ?? null, updated_at: c.updated_at,
  };
}
function prospectView(c, full) {
  if (full) return c;
  const { research, messages, watch, ...rest } = c;
  return {
    ...rest,
    messages: (messages || []).map(({ humanizer, ...m }) => ({ ...m, humanizer: humanizer ? { ai_tell_score_before: humanizer.ai_tell_score_before, ai_tell_score_after: humanizer.ai_tell_score_after, flags: humanizer.flags } : null })),
    research: research ? {
      status: research.status, ran_at: research.ran_at, facts_total: (research.facts || []).length,
      facts: (research.facts || []).slice(0, 40).map((f) => ({ id: f.id, category: f.category, claim: f.claim, as_of: f.as_of, confidence: f.confidence, url: f.url })),
      financials: research.financials ? { identifier: research.financials.identifier, rows: research.financials.rows, conflicts: research.financials.conflicts } : null,
      warnings: research.warnings || [],
    } : null,
    watch: watch ? { last_run_at: watch.last_run_at, alerts: (watch.alerts || []).slice(0, 10) } : null,
  };
}
const compactMessage = (c, m) => ({
  id: m.id, company_id: c.id, company: c.name, country: c.country, step: m.step, channel: m.channel, language: m.language, framing: m.framing || null,
  status: m.status, send_after_days: m.send_after_days, send_at: m.send_at || null, subject: m.subject, body: m.body,
  ai_tell_score: m.humanizer ? `${m.humanizer.ai_tell_score_before} → ${m.humanizer.ai_tell_score_after}` : null,
  in_reply_to: m.in_reply_to || null, created_at: m.created_at, sent_at: m.sent_at,
});
async function findMessage(id) {
  const companies = await client.get("/api/companies");
  for (const c of companies) { const m = (c.messages || []).find((x) => x.id === id); if (m) return { company: c, message: m }; }
  throw new Error(`Message ${id} not found`);
}

// ---- server ----------------------------------------------------------------------------------------------------
const server = new McpServer(
  { name: "mergero-origination-engine", version: "0.1.0" },
  {
    instructions:
      "Tools for Mergero's sell-side deal origination engine. Prospects (private companies whose owners may be open to a " +
      "transaction) move along Mergero's mandate path: new → enriched → outreach_ready → contacted → replied → warming → " +
      "meeting_booked → mandate_signed (disqualified ends it). Agents research, score, match buyers and draft a humanized " +
      "3-touch outreach sequence; a human approves every message before it is sent. Use mergero_playbook for the ICP and " +
      "messaging rules before writing or judging any message. Money is in EUR. Tools marked MUTATES change the engine's data; " +
      "mergero_send_message sends a real email when Resend is configured.",
  },
);

const stage = z.enum(["new", "enriched", "outreach_ready", "contacted", "replied", "warming", "meeting_booked", "mandate_signed", "disqualified"]);
const framing = z.enum(["open", "growth", "minority", "exit"]).describe("How the conversation is framed: open conversation (default), growth capital, partial/minority stake, full sale");
const language = z.string().describe("Language code for outreach: en, fi, sv, de, no, da").optional();

// ---- read ------------------------------------------------------------------------------------------------------
server.registerTool("mergero_stats", { title: "Pipeline stats", description: "Pipeline counts by stage, average readiness, projected mandates, drafts pending approval, owners waiting for an answer, scheduled follow-ups and analyst hours saved." },
  async () => guard(async () => json(await client.get("/api/stats"))));

server.registerTool("mergero_playbook", { title: "Mergero playbook", description: "What Mergero told us: ideal sell-side profile, the mandate path, readiness signals, messaging principles every message must follow, and the value proposition. Read this before drafting or judging outreach." },
  async () => guard(async () => json(await client.get("/api/playbook"))));

server.registerTool("mergero_list_prospects", {
  title: "List prospects",
  description: "Prospects in the pipeline, compact rows. Filter by stage, country (FI SE NO DK DE AT CH) or a name/industry/city search.",
  inputSchema: { stage: stage.optional(), country: z.string().optional(), q: z.string().optional().describe("Substring match on name, industry, city or owner"), limit: z.number().int().min(1).max(500).optional().describe("Default 50") },
}, async ({ stage: st, country, q, limit }) => guard(async () => {
  let rows = await client.get("/api/companies");
  if (st) rows = rows.filter((c) => c.stage === st);
  if (country) rows = rows.filter((c) => c.country === country.toUpperCase());
  if (q) { const n = q.toLowerCase(); rows = rows.filter((c) => [c.name, c.industry, c.city, c.owner?.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(n))); }
  return json({ total: rows.length, prospects: rows.slice(0, limit || 50).map(compactCompany) });
}));

server.registerTool("mergero_get_prospect", {
  title: "Get prospect",
  description: "One prospect in full: profile, sourced research facts and filed financials, score and why-now, buyer matches, outreach messages with statuses, the owner conversation with triage, intake summary. Pass full=true for the raw record including every research fact.",
  inputSchema: { id: z.string(), full: z.boolean().optional() },
}, async ({ id, full }) => guard(async () => json(prospectView(await client.get(`/api/companies/${encodeURIComponent(id)}`), full))));

server.registerTool("mergero_registry_search", {
  title: "Search company registries",
  description: "Source candidates straight from the official open-data company registers: Finland (PRH/YTJ: TOL industry code, city, founded before), Norway (Brønnøysund: NACE code, minimum employees, founded before), Denmark (CVR name lookup). Rows can be passed to mergero_import_prospects.",
  inputSchema: { country: z.enum(["FI", "NO", "DK"]), q: z.string().optional().describe("Name search"), industry_code: z.string().optional().describe("TOL (FI) or NACE (NO) code, e.g. 28 for machinery"), city: z.string().optional(), founded_before: z.number().int().optional().describe("Year; a proxy for owner age"), employees_min: z.number().int().optional(), page: z.number().int().min(1).optional() },
}, async (input) => guard(async () => json(await client.get(`/api/registry/search${qs(input)}`))));

server.registerTool("mergero_inbox", {
  title: "Reply inbox",
  description: "One thread per prospect with a conversation: needs_reply (the owner spoke last or a reply is drafted but unsent), waiting (we spoke last), done. Includes the last triage (intent, sentiment, open questions, next step), reply drafts, scheduled follow-ups, and inbound emails that matched no prospect.",
  inputSchema: { status: z.enum(["needs_reply", "waiting", "done"]).optional() },
}, async ({ status }) => guard(async () => {
  const inbox = await client.get("/api/inbox");
  return json({ counts: inbox.counts, mail: inbox.mail, items: status ? inbox.items.filter((i) => i.status === status) : inbox.items, unmatched: inbox.unmatched });
}));

server.registerTool("mergero_pending_approvals", {
  title: "Drafts awaiting approval",
  description: "Every outreach draft and reply draft waiting for a human decision, with subject, body and humanizer score. Approve with mergero_approve_message, change with mergero_update_message, drop with mergero_reject_message.",
  inputSchema: { company_id: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
}, async ({ company_id, limit }) => guard(async () => {
  const companies = await client.get("/api/companies");
  const out = [];
  for (const c of companies) {
    if (company_id && c.id !== company_id) continue;
    for (const m of c.messages || []) if (m.status === "draft") out.push(compactMessage(c, m));
  }
  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return json({ total: out.length, drafts: out.slice(0, limit || 50) });
}));

server.registerTool("mergero_get_message", { title: "Get message", description: "One outreach or reply message by id, with its company.", inputSchema: { id: z.string() } },
  async ({ id }) => guard(async () => { const { company, message } = await findMessage(id); return json({ ...compactMessage(company, message), humanizer: message.humanizer, delivery: message.delivery || null }); }));

server.registerTool("mergero_list_buyers", { title: "List buyer mandates", description: "Anonymised buyer mandates in Mergero's network: type, sectors, geographies, revenue and EBITDA ranges, deal types, thesis." },
  async () => guard(async () => json(await client.get("/api/buyers"))));

server.registerTool("mergero_advisor_capacity", { title: "Advisor outreach capacity", description: "Per advisor: markets, daily email cap (deliverability, Mergero: 50-100 per sender), emails sent today, prospects owned, first touches approved or queued; plus emails per day, new owners and conversations per month at the benchmark reply rate." },
  async () => guard(async () => json(await client.get("/api/advisors/capacity"))));

server.registerTool("mergero_queue_first_touches", { title: "Queue approved first touches", description: "Schedule every human-approved first-touch email, best prospects first, spread over each advisor's working day within their daily cap; overflow goes to the next working days. Follow-ups are scheduled after each first touch goes out.", inputSchema: { limit: z.number().int().min(1).max(5000).optional() } },
  async ({ limit }) => guard(async () => json(await client.post("/api/outreach/queue", { limit }))));

server.registerTool("mergero_mgx_sync", { title: "Sync buyer mandates from MGX", description: "Query live buyer mandates from the MGX Deal Engine API (sector, size, deal type, geography) and upsert them as buyers; falls back to a labelled sample when MGX_API_URL is not set on the engine." },
  async () => guard(async () => json(await client.post("/api/mgx/sync", {}))));

server.registerTool("mergero_watch_alerts", { title: "Watch-mode alerts", description: "Timing alerts from re-crawling researched websites: new CEO, acquisitions, new sites, hiring spikes.", inputSchema: { limit: z.number().int().min(1).max(500).optional() } },
  async ({ limit }) => guard(async () => json(await client.get(`/api/watch/alerts${qs({ limit })}`))));

server.registerTool("mergero_mail_status", { title: "Email delivery status", description: "Whether real email (Resend) is configured, the sender, the inbound reply domain, the webhook URL, scheduled and due follow-ups, unmatched inbound mail." },
  async () => guard(async () => json(await client.get("/api/mail/status"))));

server.registerTool("mergero_job_status", { title: "Bulk job status", description: "Progress of a bulk pipeline or watch job started with mergero_run_pipeline_bulk.", inputSchema: { job_id: z.string() } },
  async ({ job_id }) => guard(async () => json(await client.get(`/api/jobs/${encodeURIComponent(job_id)}`))));

// ---- write: sourcing and agents ----------------------------------------------------------------------------------
server.registerTool("mergero_import_prospects", {
  title: "Import prospects",
  description: "MUTATES: imports rows from mergero_registry_search (or hand-written rows with at least a name) as new prospects. Registry ids already in the pipeline are skipped.",
  inputSchema: { companies: z.array(z.object({ name: z.string(), country: z.string().optional(), city: z.string().optional(), website: z.string().optional(), industry: z.string().optional(), industry_code: z.string().optional(), employees: z.number().nullable().optional(), founded: z.number().nullable().optional(), registry_id: z.string().optional(), source: z.string().optional(), owner: z.object({ name: z.string().optional(), title: z.string().optional(), email: z.string().optional(), linkedin: z.string().optional(), age: z.number().optional() }).optional() }).passthrough()).min(1) },
}, async ({ companies }) => guard(async () => { const r = await client.post("/api/companies/bulk", { companies }); return json({ imported: r.imported, prospects: (r.companies || []).map(compactCompany) }); }));

server.registerTool("mergero_add_prospect", {
  title: "Add prospect",
  description: "MUTATES: adds one prospect by hand (e.g. from a referral). Country codes: FI SE NO DK DE AT CH. The channel follows the country (Nordics email, DACH LinkedIn).",
  inputSchema: { name: z.string(), country: z.string(), city: z.string().optional(), website: z.string().optional(), industry: z.string().optional(), revenue_eur: z.number().optional(), ebitda_eur: z.number().optional(), employees: z.number().optional(), founded: z.number().optional(), ownership_type: z.enum(["founder-owned", "family-owned", "pe-backed", "management-owned", "unknown"]).optional(), owner_name: z.string().optional(), owner_title: z.string().optional(), owner_age: z.number().optional(), owner_email: z.string().optional(), owner_linkedin: z.string().optional(), notes: z.string().optional(), source: z.string().optional() },
}, async (i) => guard(async () => {
  const body = { name: i.name, country: i.country, city: i.city, website: i.website, industry: i.industry, revenue_eur: i.revenue_eur, ebitda_eur: i.ebitda_eur, employees: i.employees, founded: i.founded, ownership_type: i.ownership_type, notes: i.notes, source: i.source || "MCP",
    owner: { name: i.owner_name, title: i.owner_title, age: i.owner_age, email: i.owner_email, linkedin: i.owner_linkedin } };
  return json(compactCompany(await client.post("/api/companies", body)));
}));

server.registerTool("mergero_run_pipeline", {
  title: "Run full pipeline on one prospect",
  description: "MUTATES and takes minutes: research the web presence and registries → enrich → score → match buyers → draft and humanize the 3-touch outreach sequence. Drafts wait for approval. Set research=false to skip the crawl.",
  inputSchema: { id: z.string(), framing: framing.optional(), language, research: z.boolean().optional() },
}, async ({ id, framing: f, language: l, research }) => guard(async () => json(prospectView(await client.post(`/api/companies/${encodeURIComponent(id)}/run`, { framing: f, language: l, research }), false))));

server.registerTool("mergero_run_step", {
  title: "Run one agent step",
  description: "MUTATES: run a single agent on a prospect: research (crawl + registries + web, refreshes), enrich, score, match, outreach (drafts a new sequence, replacing unsent drafts), watch (re-crawl and raise alerts), teaser (blind buyer teaser, only after mandate_signed).",
  inputSchema: { id: z.string(), step: z.enum(["research", "enrich", "score", "match", "outreach", "watch", "teaser"]), framing: framing.optional(), language },
}, async ({ id, step, framing: f, language: l }) => guard(async () => json(prospectView(await client.post(`/api/companies/${encodeURIComponent(id)}/${step}`, step === "outreach" ? { framing: f, language: l } : {}), false))));

server.registerTool("mergero_run_pipeline_bulk", {
  title: "Run pipeline on many prospects",
  description: "MUTATES: starts a background job running the full pipeline on the given ids, or on every prospect at a stage (default new). Poll with mergero_job_status.",
  inputSchema: { ids: z.array(z.string()).optional(), stage: stage.optional(), language },
}, async ({ ids, stage: st, language: l }) => guard(async () => json(await client.post("/api/pipeline/run", { ids, stage: st, language: l }))));

server.registerTool("mergero_set_stage", { title: "Set stage", description: "MUTATES: moves a prospect to a stage by hand (e.g. meeting_booked after a call, mandate_signed after the engagement letter, disqualified). Disqualifying cancels scheduled follow-ups.", inputSchema: { id: z.string(), stage } },
  async ({ id, stage: st }) => guard(async () => json(compactCompany(await client.post(`/api/companies/${encodeURIComponent(id)}/stage`, { stage: st })))));

server.registerTool("mergero_update_prospect", {
  title: "Update prospect",
  description: "MUTATES: edits prospect fields such as notes, owner details (name, title, age, email, linkedin), website, industry, revenue_eur, ebitda_eur, employees, founded, ownership_type.",
  inputSchema: { id: z.string(), fields: z.object({}).passthrough().describe("Only the fields to change") },
}, async ({ id, fields }) => guard(async () => json(compactCompany(await client.put(`/api/companies/${encodeURIComponent(id)}`, fields)))));

// ---- write: messages, the human-in-the-loop gate ----------------------------------------------------------------
server.registerTool("mergero_update_message", { title: "Edit message", description: "MUTATES: changes the subject or body of a draft before approval.", inputSchema: { id: z.string(), subject: z.string().optional(), body: z.string().optional() } },
  async ({ id, subject, body }) => guard(async () => { const m = await client.put(`/api/messages/${encodeURIComponent(id)}`, { ...(subject !== undefined ? { subject } : {}), ...(body !== undefined ? { body } : {}) }); return json(m); }));

server.registerTool("mergero_humanize_message", { title: "Re-humanize message", description: "MUTATES: runs the humanizer critic again on a message (flags AI tells, rewrites, reports the AI-tell score before and after).", inputSchema: { id: z.string() } },
  async ({ id }) => guard(async () => json(await client.post(`/api/messages/${encodeURIComponent(id)}/humanize`))));

server.registerTool("mergero_approve_message", { title: "Approve message", description: "MUTATES: the human approval step. A first touch becomes sendable; a follow-up whose first touch already went out is scheduled for its day (unless the owner has replied). Nothing is sent by this tool.", inputSchema: { id: z.string() } },
  async ({ id }) => guard(async () => json(await client.post(`/api/messages/${encodeURIComponent(id)}/approve`))));

server.registerTool("mergero_reject_message", { title: "Reject message", description: "MUTATES: rejects a draft, approved or scheduled message so it will not be sent.", inputSchema: { id: z.string() } },
  async ({ id }) => guard(async () => json(await client.post(`/api/messages/${encodeURIComponent(id)}/reject`))));

server.registerTool("mergero_unschedule_message", { title: "Take follow-up off the clock", description: "MUTATES: a scheduled follow-up goes back to approved and is only sent by hand.", inputSchema: { id: z.string() } },
  async ({ id }) => guard(async () => json(await client.post(`/api/messages/${encodeURIComponent(id)}/unschedule`))));

server.registerTool("mergero_send_message", {
  title: "Send approved message",
  description: "MUTATES and REACHES THE OWNER: sends an approved message. Email goes out through Resend when configured (otherwise a mailto: link is returned and the message is logged as sent); LinkedIn and call scripts are logged as sent for the advisor to deliver. Sending the first touch puts approved follow-ups on the clock.",
  inputSchema: { id: z.string() },
}, async ({ id }) => guard(async () => json(await client.post(`/api/messages/${encodeURIComponent(id)}/send`))));

server.registerTool("mergero_record_reply", {
  title: "Record an owner reply",
  description: "MUTATES: logs a reply the owner sent through another channel (LinkedIn, phone note, forwarded email) and runs triage: intent, sentiment, extracted facts, open questions, recommended stage, next step and a drafted reply awaiting approval. Replies arriving by email through the Resend webhook are recorded automatically.",
  inputSchema: { id: z.string().describe("Prospect id"), text: z.string(), channel: z.enum(["email", "linkedin", "phone"]).optional() },
}, async ({ id, text: t, channel }) => guard(async () => {
  const c = await client.post(`/api/companies/${encodeURIComponent(id)}/replies`, { text: t, channel });
  const entry = lastInbound(c);
  return json({ prospect: compactCompany(c), triage: entry?.triage || null, triage_error: entry?.triage_error || null, reply_draft: (c.messages || []).find((m) => m.id === entry?.triage?.reply_message_id) || null });
}));

server.registerTool("mergero_intake_link", { title: "Owner intake link", description: "MUTATES: creates (or returns) the confidential intake link for a prospect's owner. A Mergero intake agent gathers revenue split, client concentration, EBITDA, timing, motivation and deal-breakers in a short conversation.", inputSchema: { id: z.string() } },
  async ({ id }) => guard(async () => json(await client.post(`/api/companies/${encodeURIComponent(id)}/intake-link`))));

server.registerTool("mergero_add_buyer", {
  title: "Add buyer mandate",
  description: "MUTATES: adds an anonymised buyer mandate to the network used for matching.",
  inputSchema: { name: z.string(), buyer_type: z.enum(["PE", "family_office", "strategic"]), sectors: z.array(z.string()), geographies: z.array(z.string()), revenue_min_eur: z.number().optional(), revenue_max_eur: z.number().optional(), ebitda_min_eur: z.number().optional(), ebitda_max_eur: z.number().optional(), deal_types: z.array(z.string()).optional(), thesis: z.string().optional(), active: z.boolean().optional() },
}, async (b) => guard(async () => json(await client.post("/api/buyers", b))));

server.registerTool("mergero_simulate_inbound_email", {
  title: "Simulate an inbound owner email",
  description: "MUTATES (demo/test): feeds an email into the inbound pipeline exactly as the Resend webhook would: routed to the prospect (by company_id, or by the sender's address), quoted history stripped, triaged, reply drafted. Unroutable mail lands in the unmatched queue.",
  inputSchema: { from: z.string().describe("Sender, e.g. \"Jari Lehtinen <jari@nordicpump.fi>\""), subject: z.string().optional(), text: z.string(), company_id: z.string().optional() },
}, async (b) => guard(async () => json(await client.post("/api/mail/inbound/simulate", { ...b, wait: true }))));

server.registerTool("mergero_run_sweep", { title: "Run the follow-up scheduler", description: "MUTATES: sends every scheduled follow-up that is due (email via Resend), marks the rest due for the advisor, cancels ones the owner has answered. Pass now (ISO time) to pretend it is later, e.g. in a demo.", inputSchema: { now: z.string().optional() } },
  async ({ now }) => guard(async () => json(await client.post("/api/mail/sweep", { now }))));

// ---- resources --------------------------------------------------------------------------------------------------
const resource = (name, uri, title, description, fetcher) =>
  server.registerResource(name, uri, { title, description, mimeType: "application/json" }, async (u) => ({ contents: [{ uri: u.href, mimeType: "application/json", text: JSON.stringify(await fetcher(), null, 2) }] }));
resource("stats", "mergero://stats", "Pipeline stats", "Counts by stage, projected mandates, pending approvals, owners waiting.", () => client.get("/api/stats"));
resource("playbook", "mergero://playbook", "Mergero playbook", "ICP, mandate path, messaging principles, readiness signals.", () => client.get("/api/playbook"));
resource("inbox", "mergero://inbox", "Reply inbox", "Threads needing a reply, waiting or done, plus unmatched inbound mail.", () => client.get("/api/inbox"));
resource("buyers", "mergero://buyers", "Buyer mandates", "Anonymised buyer mandates used for matching.", () => client.get("/api/buyers"));
server.registerResource("prospect", new ResourceTemplate("mergero://prospect/{id}", { list: undefined }), { title: "Prospect", description: "One prospect record (compact view).", mimeType: "application/json" },
  async (u, { id }) => ({ contents: [{ uri: u.href, mimeType: "application/json", text: JSON.stringify(prospectView(await client.get(`/api/companies/${encodeURIComponent(String(id))}`), false), null, 2) }] }));

// ---- prompts ----------------------------------------------------------------------------------------------------
const prompt = (name, title, description, argsSchema, build) =>
  server.registerPrompt(name, { title, description, argsSchema }, (args) => ({ messages: [{ role: "user", content: { type: "text", text: build(args || {}) } }] }));
prompt("review_pending_drafts", "Review drafts against the playbook", "Judge every draft awaiting approval against Mergero's messaging principles, fix what fails, approve the rest.",
  { company_id: z.string().optional().describe("Limit to one prospect") },
  ({ company_id }) => `Read mergero_playbook first. Then call mergero_pending_approvals${company_id ? ` for prospect ${company_id}` : ""}. For each draft: check it never says sell/exit/M&A process/valuation in a first touch, leads with concrete buyer demand and one specific observation about the company, offers the softer door first, asks for a 20-minute confidential conversation, and reads like one senior advisor wrote it (no stock openers, no em dashes, no bullet lists, no exclamation marks). Edit with mergero_update_message where needed (keep every concrete fact), then approve with mergero_approve_message. Reject anything that cannot be fixed. Do NOT send. Finish with a table: message id, company, step, verdict, what you changed.`);
prompt("work_the_inbox", "Work the reply inbox", "Go through owners waiting for an answer, judge each drafted reply, and propose the next step.",
  {},
  () => `Call mergero_inbox with status needs_reply. For each thread, call mergero_get_prospect and read the last inbound message, its triage (intent, sentiment, open questions, next step) and the drafted reply. Check the reply answers every open question honestly (buyer types yes, buyer names no; process confidential and off-market; owner sets the pace), stays in the owner's language, and follows the playbook. Edit with mergero_update_message if needed, approve with mergero_approve_message, and where the triage recommends it, set the stage with mergero_set_stage or create an intake link with mergero_intake_link. Never send yourself. Finish with a table: company, intent, sentiment trend, next step, what you did.`);
prompt("source_prospects", "Source prospects from a registry", "Pull candidates from an official company register, import them and run the pipeline.",
  { country: z.string().describe("FI, NO or DK"), industry_code: z.string().optional().describe("TOL (FI) or NACE (NO) code"), city: z.string().optional(), founded_before: z.string().optional().describe("Year") },
  ({ country, industry_code, city, founded_before }) => `Read mergero_playbook for the ideal profile. Search with mergero_registry_search (country ${country}${industry_code ? `, industry_code ${industry_code}` : ""}${city ? `, city ${city}` : ""}${founded_before ? `, founded_before ${founded_before}` : ""}). Pick candidates that fit the ideal profile (size, age of the company as a proxy for owner age, industry with buyer appetite) and import them with mergero_import_prospects. Start mergero_run_pipeline_bulk on the imported ids and poll mergero_job_status until finished. Report the readiness scores and buyer matches, and list the drafts now waiting for approval.`);

// ---- start ------------------------------------------------------------------------------------------------------
async function main() {
  try { const s = await client.get("/api/stats"); console.error(`[mergero-mcp] connected to ${API_URL}: ${s.total} prospects, ${s.messages_pending_approval} drafts pending`); }
  catch (err) { console.error(`[mergero-mcp] WARNING: ${err.message} Tools will retry on first use.`); }
  await server.connect(new StdioServerTransport());
  console.error("[mergero-mcp] ready on stdio");
}
main().catch((err) => { console.error("[mergero-mcp] fatal:", err); process.exit(1); });
