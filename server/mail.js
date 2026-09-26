// Real email in and out of the engine. Outbound goes through Resend's send API; inbound arrives through Resend's
// receiving webhook. Ported from the HMD CRM's Azure Functions (email-io/functions/src/functions/resendSend.ts and
// resendWebhook.ts) and moved server-side, so an owner's reply is logged and triaged the moment it lands, whether or
// not anyone has the app open. Resend's `email.received` event carries metadata only; the body is fetched by id.
import crypto from "node:crypto";

const API_BASE = () => (process.env.RESEND_API_BASE || "https://api.resend.com").replace(/\/+$/, "");
// Every prospect gets its own reply-to address on the inbound domain: owners+<company_id>@<inbound domain>.
const INBOUND_LOCAL_PART = "owners";

// Settings win over the environment; empty settings fall back to the environment.
export function config(settings) {
  const m = settings?.mail || {};
  return {
    api_key: m.resend_api_key || process.env.RESEND_API_KEY || "",
    from: m.from || process.env.RESEND_FROM || "",
    inbound_domain: String(m.inbound_domain || process.env.MAIL_INBOUND_DOMAIN || "").toLowerCase().replace(/^@/, "").trim(),
    webhook_secret: m.webhook_secret || process.env.RESEND_WEBHOOK_SECRET || "",
  };
}
export function configured(settings) {
  const c = config(settings);
  return Boolean(c.api_key && c.from);
}

export function inboundAddress(settings, companyId) {
  const { inbound_domain } = config(settings);
  return inbound_domain && companyId ? `${INBOUND_LOCAL_PART}+${companyId}@${inbound_domain}` : null;
}

// "Name <a@b.c>" | "a@b.c" | { name, email } | { name, address } → { name, email }
export function parseAddress(v) {
  if (!v) return { name: "", email: "" };
  if (Array.isArray(v)) return parseAddress(v[0]);
  if (typeof v === "object") return { name: String(v.name || "").trim(), email: String(v.email || v.address || "").trim().toLowerCase() };
  const s = String(v).trim();
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: s.replace(/^<|>$/g, "").toLowerCase() };
}
export function addressList(v) {
  if (!v) return [];
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [v];
  return raw.map(parseAddress).filter((a) => a.email);
}

// owners+c_ab12cd@inbound.example → "c_ab12cd" (any local part with a plus token counts)
export function companyIdFromAddress(addr) {
  const { email } = parseAddress(addr);
  const m = /^[^+@]+\+([^@]+)@/.exec(email);
  return m ? m[1] : null;
}

// Our own Message-ID on every outbound email: <message id>.<company id>@<domain>. A reply's In-Reply-To then routes
// itself even when the owner writes from another address.
export function messageIdFor(settings, message) {
  const c = config(settings);
  const domain = c.inbound_domain || parseAddress(c.from).email.split("@")[1] || "mergero.local";
  return `<${message.id}.${message.company_id}@${domain}>`;
}
export function messageIdToken(header) {
  const m = /<?\s*(m_[a-z0-9]+)\.(c_[a-z0-9]+)@/i.exec(String(header || ""));
  return m ? { message_id: m[1], company_id: m[2] } : null;
}

// Send one email. Resend reference: https://resend.com/docs/api-reference/emails/send-email
export async function send(settings, { to, subject, text, html, reply_to, headers, tags }) {
  const c = config(settings);
  if (!c.api_key || !c.from) throw Object.assign(new Error("Email delivery is not configured: add the Resend API key and From address in Settings."), { status: 409 });
  const body = { from: c.from, to: Array.isArray(to) ? to : [to], subject: subject || "(no subject)", text: text || "" };
  if (html) body.html = html;
  if (reply_to) body.reply_to = reply_to;
  if (headers && Object.keys(headers).length) body.headers = headers;
  if (tags?.length) body.tags = tags.map((t) => ({ name: t.name, value: String(t.value).replace(/[^A-Za-z0-9_-]/g, "_") }));
  let res;
  try {
    res = await fetch(`${API_BASE()}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw Object.assign(new Error(`Could not reach Resend: ${err.message}`), { status: 502 });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Resend rejected the send (${res.status}): ${json.message || json.error || res.statusText}`), { status: 502 });
  return { id: json.id, provider: "resend" };
}

// The webhook has no body; fetch it. Reference: GET /emails/receiving/{id}
export async function fetchReceived(settings, emailId) {
  const c = config(settings);
  if (!c.api_key) throw new Error("Resend API key missing: cannot fetch the received email body");
  const res = await fetch(`${API_BASE()}/emails/receiving/${encodeURIComponent(emailId)}`, { headers: { Authorization: `Bearer ${c.api_key}` } });
  if (!res.ok) throw new Error(`Resend receiving/${emailId} → HTTP ${res.status}`);
  return normalizeReceived(await res.json());
}

// Tolerant of the webhook `data` object, the receiving API object and hand-written simulator payloads.
export function normalizeReceived(e = {}) {
  const headers = headerMap(e.headers);
  const text = String(e.text || e.body || "").trim() || stripHtml(e.html || "");
  return {
    id: e.email_id || e.id || null,
    from: parseAddress(e.from ?? e.sender ?? e.From),
    to: addressList(e.to ?? e.recipient ?? e.To),
    subject: String(e.subject || e.Subject || "").trim() || "(no subject)",
    text,
    message_id: e.message_id || headers["message-id"] || "",
    in_reply_to: e.in_reply_to || headers["in-reply-to"] || "",
    references: e.references || headers["references"] || "",
    received_at: e.created_at || e.received_at || new Date().toISOString(),
  };
}
function headerMap(h) {
  const out = {};
  if (!h) return out;
  if (Array.isArray(h)) for (const x of h) if (x?.name) out[String(x.name).toLowerCase()] = String(x.value ?? "");
  else if (typeof h === "object") for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(" ") : String(v ?? "");
  return out;
}

export function stripHtml(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

// Resend signs webhooks with Svix: HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>" using the base64 secret
// after "whsec_". The header lists "v1,<base64 signature>" entries separated by spaces.
export function verifySvix(rawBody, headers, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  const id = headers["svix-id"], ts = headers["svix-timestamp"], sigs = headers["svix-signature"];
  if (!id || !ts || !sigs) return { ok: false, reason: "missing svix-id, svix-timestamp or svix-signature header" };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec) return { ok: false, reason: "timestamp outside tolerance" };
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  for (const part of String(sigs).split(/\s+/)) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}
// Test helper and reference implementation of the signing side.
export function signSvix(rawBody, secret, { id = `msg_${Date.now().toString(36)}`, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const sig = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${sig}` };
}

// The owner's new words only: drop the quoted history and the signature, in the languages we write in.
const QUOTE_START = [
  /^(On|Am|Den|Le|El|Il|Op|Pe|Den|Fra)\b.{3,}(wrote|schrieb|skrev|a écrit|escribió|ha scritto|schreef|kirjoitti|napisał):?\s*$/i,
  /^.{3,}\b(wrote|schrieb|skrev|kirjoitti|a écrit):\s*$/i,
  /^-{2,}\s*(Original|Forwarded|Ursprüngliche|Alkuperäinen|Vidarebefordrat)\b.*-{2,}\s*$/i,
  /^_{6,}\s*$/,
];
const HEADER_LINE = /^(From|Von|Från|Fra|Lähettäjä|De)\s*:\s.+/i;
const HEADER_FOLLOW = /^(Sent|To|Date|Subject|Gesendet|An|Betreff|Skickat|Till|Ämne|Sendt|Til|Emne|Lähetetty|Vastaanottaja|Aihe|Envoyé|À|Objet)\s*:/i;
export function replyText(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (l.startsWith(">")) { cut = i; break; }
    if (/^--\s*$/.test(l)) { cut = i; break; }
    if (QUOTE_START.some((re) => re.test(l))) { cut = i; break; }
    if (HEADER_LINE.test(l) && lines.slice(i + 1, i + 5).some((x) => HEADER_FOLLOW.test(x.trim()))) { cut = i; break; }
    // A wrapped "On … wrote:" that ends on the next line.
    if (/^(On|Am|Den|Le)\b/.test(l) && i + 1 < lines.length && /(wrote|schrieb|skrev|a écrit|kirjoitti):?\s*$/i.test(lines[i + 1].trim())) { cut = i; break; }
  }
  const out = lines.slice(0, cut).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out || String(text || "").trim();
}
