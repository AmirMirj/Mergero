# Repurposing the HMD CRM and its email gateway for Mergero

`email-io/` is a clone of https://github.com/TheShoutingParrot/sentinel-hmd-crm (branch `main`, commit `2f3ded4`, cloned 2026-09-26). It is our own hackathon CRM for HMD Secure. The clone holds no secrets (the only key-shaped string is the Resend placeholder in `functions/local.settings.json.example`). It has its own `.git`; if `mergero/` becomes a repository, either gitignore `email-io/` like `scraper/` or port what we need and delete it.

## 1. What is in email-io

| Part | Stack | Size | What it does |
|---|---|---|---|
| `functions/` | Azure Functions v4, TypeScript, plain `fetch`, no vendor SDKs | ~700 lines | The email/SMS IO manager. Email: `resendSend` (POST to api.resend.com), `resendWebhook` (Resend `email.received` event; the event carries metadata only, so the body is fetched from `/emails/receiving/{id}`), `emailMessages?since=` (poll endpoint read by the browser), `interpretEmail` (OpenAI `json_schema` structured output: sentiment, warmth, stage suggestion, concerns, open questions, suggested reply). SMS twins: `twilioSend`, `twilioWebhook`, `smsMessages`, `interpretSms`, plus an Azure Communication Services `smsWebhook`. Inbound messages sit in an in-memory array (`store.ts`) |
| `server/` | Fastify 5 + Postgres 16, TypeScript, Vercel AI SDK with an OpenAI/Anthropic provider seam | ~9k lines | B2B CRM API: organizations, contacts with reports-to chains, leads/deals, outreach log, notes, email threads and SMS threads stored as JSONB, meetings, agent runs with a `needs_review` approval queue, market signals, cases/offers/catalog, Microsoft Graph mail and calendar connectors (live when configured, sample otherwise, never faked), PRH company search, Finnish procurement scraper |
| `web/` | React 19 + Vite + Tailwind 4 | ~20k lines | SPA. Relevant screens: `pages/Inbox.tsx` (1005 lines), `pages/Sms.tsx` (761), `pages/Outreach.tsx` (464) with `components/outreach-compose.tsx` |
| `mcp/` | `@modelcontextprotocol/sdk`, stdio transport | ~900 lines | 51 `crm_*` tools, 8 resources, 5 prompts. Wraps the REST API through one cookie session (`client.ts`), every handler wrapped in `guard()` |

## 2. What the Mergero engine lacks against the brief and the Q&A

The brief scores innovation, scalability (thousands to tens of thousands of companies, several countries), feasibility (pilotable), impact and concreteness. Mergero told us they already mass-email from templates through Claude, MCP and their private database, want messages that do not read as AI, need warm-up conversations with owners, and use email in the Nordics and LinkedIn plus calls in DACH.

Today the engine (`server/index.js`, `public/app.js`) stops at the mailbox door:

| Gap | Where it shows | Why it matters for judging |
|---|---|---|
| No real outbound email | `POST /api/messages/:id/send` marks the draft sent and returns a `mailto:` link | A `mailto:` per owner cannot reach thousands. Scalability is the headline criterion |
| No inbound channel | Replies are pasted by hand into the Conversation tab (`POST /api/companies/:id/replies`) | The triage agent is the strongest part of the reply loop, but it never sees a live reply. Concreteness suffers |
| No sequence scheduling | `send_after_days` is stored on each Message; nothing sends step 2 or 3, nothing cancels them on a reply | The 3-touch sequence is a promise, not a mechanism |
| No cross-prospect inbox | Dashboard lists "Unhandled replies"; work happens one company at a time | An advisor handling 300 conversations needs a queue view |
| No delivery status | Message status is `draft / approved / sent / rejected` | Bounces and unanswered sequences are invisible |
| No MCP surface | Agents are reachable only through the REST API and the SPA | Mergero's own workflow is Claude, MCP, database. Meeting them there is the adoption story |
| Single sender identity | `settings.sender` is one person | Timo, Tatu and Miiro each need to send as themselves in a pilot |

## 3. Reuse verdict per component

| email-io component | Verdict | Why | Effort |
|---|---|---|---|
| `functions/src/functions/resendSend.ts` | **Port** into Express as `server/mail.js` | 60 dependency-free lines; already proven in the HMD demo. Add `reply_to`, `In-Reply-To`/`References` headers and Resend tags carrying `company_id` and `message_id` | 1 h |
| `functions/src/functions/resendWebhook.ts` | **Port** as `POST /api/mail/inbound/resend` in Express | The metadata-only quirk and the `/emails/receiving/{id}` fetch are the non-obvious parts and are done. Replace the in-memory buffer with a direct call into the existing replies handler | 2 h |
| `emailMessages.ts` + the browser polling in `Inbox.tsx` | **Drop** | Inbound mail was only ingested while someone had the Inbox open, and the buffer died with every Function restart. For Mergero the webhook must land server-side and run triage immediately | 0 |
| `interpretEmail.ts` | **Do not port**; borrow two fields | Mergero's `agents.triage` (Claude, Zod, playbook-aware, extracts facts, drafts the reply in the owner's language) is stronger. Add `open_questions` and a sentiment trend across the thread to `TriageSchema` | 30 min |
| Azure Functions runtime (`func` host on :7071) | **Drop** | A second runtime for four small handlers. The engine is one Express process; keep it that way | 0 |
| Twilio / ACS SMS (`twilio*`, `smsWebhook`, `Sms.tsx`) | **Skip** | SMS is not a Mergero channel (Nordics email, DACH LinkedIn and calls) | 0 |
| `EmailThread` / `EmailMessage` / `ThreadStatus` model | **Adopt as a view**, not as new storage | `company.conversation[]` already holds the messages. Derive `needs_reply / waiting / done` per company; add `open_questions`, keep `suggested_reply` (already the reply draft) and `next_step` (already in triage) | 1 h |
| `Inbox.tsx` layout and behaviour | **Port the UX** to vanilla JS as `#/inbox` | Thread list with filters on the left, reading pane with the triage card, editable reply and a real Send on the right. The React code itself cannot be dropped into `public/app.js` | 3 h |
| `OutreachStatus` enum | **Adopt** | `draft / scheduled / sent / replied / bounced / no_response` models a sequence far better than `draft / approved / sent / rejected`. Keep `approved`, add `scheduled`, `replied`, `bounced`, `cancelled` | 1 h with the scheduler |
| `mcp/` (client, util, tool registration pattern) | **Port** as `mergero/mcp/` | Mergero already drives its outreach through MCP. Expose prospects, pipeline run, pending approvals, approve/send, record reply, buyers, registry search, stats | 3 h |
| `connectors/graph-mail.ts` + `integrations/calendar.ts` | **Port for the pilot story** | Mergero is a Zurich/Helsinki advisory and almost certainly on Microsoft 365. Graph `sendMail` from the advisor's own mailbox beats a Resend sender for cold owner outreach, and Graph mail read gives inbound without an inbound domain. The honest live/sample pattern means the demo never lies about what is connected. Calendar: book the first call when triage moves a company to `meeting_booked` | 3 h |
| `email-to-case.ts` dedupe tag (`email:<externalId>`) | **Borrow the idea** | Dedupe inbound by Resend `email_id` so webhook retries never duplicate a conversation entry | 15 min |
| Agent approval queue (`AgentRun` `needs_review`, `propose_*` tools) | **Skip** | Mergero already has approve/reject per message, which is the same human-in-the-loop gate | 0 |
| Relational schema (`schema.sql`), cases, offers, catalog, forecast, meetings, signals, procurement scraper, PRH search | **Skip** | HMD-specific, or Mergero already has the better version (registry lookup for FI/NO/DK, watch-mode alerts) | 0 |
| `docker-compose.yml` | **Adapt** | Postgres plus the app in one command is a cheap feasibility point for the handoff | 30 min |

Roughly one sixth of the code is worth carrying over, and none of the React UI or the relational schema.

## 4. Concept mapping

| HMD CRM | Mergero engine |
|---|---|
| Organization (account) | Company (prospect) |
| Contact | `company.owner` (Mergero: the decision-maker is the majority owner) |
| Lead / deal stage `opportunity, pipeline, committed, confirmed` | Company stage along the mandate path `contacted, replied, warming, meeting_booked, mandate_signed` |
| EmailThread | The company's conversation, one thread per company |
| EmailMessage (inbound/outbound) | ConversationEntry |
| Outreach row (`channel`, `direction`, `status`, `scheduled_at`, `sent_at`) | Message (`channel`, `step`, `send_after_days`, `status`, `sent_at`) |
| `Sentiment {score, label, trend}` | `triage.sentiment` (`warm / neutral / cold`); add a trend versus the previous inbound |
| `openQuestions`, `suggestedReply`, `nextStep` | add `open_questions`; `reply_body`; `next_step` |
| ThreadStatus `needs_reply / waiting / snoozed / done` | derived: untriaged inbound or unsent reply draft = needs reply; outbound sent and no reply = waiting; `disqualified`, `meeting_booked`, `mandate_signed` = done |
| Employee with sender identity | `settings.sender` today; becomes a list of advisors |

## 5. Port plan

### P0, demo-critical (judging Sunday 2026-09-27, 15:00)

1. **`server/mail.js`**: `sendEmail({ to, subject, text, html, reply_to, headers, tags })` over the Resend API (port of `resendSend`). Read `RESEND_API_KEY`, `RESEND_FROM`, `MAIL_INBOUND_DOMAIN` from `.env`; expose them in Settings next to the Anthropic key.
2. **Wire real sending** into `POST /api/messages/:id/send`: when Resend is configured, send to `company.owner.email` with `reply_to` set to `owners+<company_id>@<inbound domain>`, store the Resend id on the message, keep the `mailto:` fallback when it is not configured. Log the outbound entry exactly as today.
3. **`POST /api/mail/inbound/resend`**: port of `resendWebhook`. Verify the Svix signature when `RESEND_WEBHOOK_SECRET` is set, fetch the body by id, dedupe by `email_id`, then route to a company in this order: plus-address token, then `In-Reply-To` matching a stored Resend id, then sender address equal to `owner.email`, then an unmatched queue. Extract the body of today's replies handler into `handleInboundReply(company, text, channel, meta)` and call it, so triage, the reply draft and the stage change run server-side within seconds. Answer 200 immediately and do the LLM work after the response.
4. **`#/inbox` route** in `public/app.js`: filters needs reply / waiting / done, a reading pane with the conversation, the triage card, the editable reply draft and Send. This replaces "paste an owner reply" as the demo moment: an owner answers from a phone, the reply appears with intent, extracted facts and a drafted answer.
5. **Live demo path**: `ngrok http 3000` and point the Resend webhook at `<ngrok>/api/mail/inbound/resend`. Reuse the Resend account and inbound domain from the HMD demo. Node 24, ngrok 3.39, Docker 29 and Postgres 17 are installed on this machine.

### P1, strengthens the pitch

6. **`mergero/mcp/`**: stdio server modelled on `email-io/mcp` (`client.ts`, `util.ts`, one `tools/*.ts` per group). Tools: `mergero_search_prospects`, `mergero_get_prospect`, `mergero_registry_search`, `mergero_import`, `mergero_run_pipeline`, `mergero_pending_approvals`, `mergero_approve_message`, `mergero_send_message`, `mergero_record_reply`, `mergero_list_buyers`, `mergero_stats`. The engine has no auth, so the client is a plain HTTP wrapper. Pitch line: "plug into the Claude and MCP workflow you already run".
7. **Sequence scheduler**: a `SEND_SWEEP_MINUTES` interval (same pattern as `WATCH_INTERVAL_HOURS`). Approving a sequence sets `send_at` on steps 2 and 3 from step 1's `sent_at` plus `send_after_days`; the sweep sends due messages; any inbound reply cancels the remaining steps. Statuses: `draft, approved, scheduled, sent, replied | bounced | cancelled`.
8. **Resend delivery events** (`email.delivered`, `email.bounced`, `email.complained`) on the same webhook: set message status, flag a bouncing owner address on the company.

### P2, pilot feasibility talking points

9. **Microsoft Graph connector** (port `graph-mail.ts`, add `sendMail`): advisors send from their own mailbox and replies are read from it. No inbound domain, better deliverability and authenticity for cold owner outreach. Keep the live/sample badge.
10. **Graph calendar** (port `calendar.ts`): when triage recommends `meeting_booked`, offer "book the first call" and log whether a real event was created.
11. **Advisors**: replace the single `settings.sender` with a list (Timo Tontti sell-side, Tatu Nordback buy-side, Miiro Nygren Nordics); route by country and sign outreach as the owning advisor.
12. **`docker-compose.yml`**: Postgres plus the engine.

## 6. Gotchas carried over from the HMD demo

- `Inbox.tsx` sends every reply to one hard-coded demo inbox (`VITE_EMAIL_TO`, defaulting to a personal Gmail) and prefixes the intended recipient into the subject. That was a workaround for Resend's `onboarding@resend.dev` sender, which only delivers to the account owner. Sending to real owners needs a verified sending domain in Resend (DNS records) or Graph `sendMail`.
- Inbound routing in HMD was by message content (which deal or account the text mentions) because all mail arrived from one address. Mergero has an owner email per company (`data/seed.json` carries them for every demo prospect), so route by plus-address and sender first; keep content matching only as a last resort.
- The webhook accepts Svix headers but never verifies them. Verify in the port.
- Replies from the CRM did not set `In-Reply-To`/`References`, so they did not thread in the recipient's mail client. Set them on step 2, step 3 and reply drafts.
- `interpretEmail` used OpenAI (`OPENAI_MODEL`) while the engine standardises on Claude through `agents.parse`. Nothing to reconcile if the interpreter is not ported.
- The `.env.example` in email-io documents `AGENT_API_TOKEN` machine endpoints that no longer exist in `server/src`. Do not plan around them.
