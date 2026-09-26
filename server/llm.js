// Model provider switch. "anthropic" = Claude via the Anthropic SDK (structured outputs, web tools).
// "verda" = Mistral Large 3 hosted on Verda (DataCrunch) — an OpenAI-compatible chat-completions endpoint,
// EU data sovereignty. Structured output = JSON schema mode with Zod validation and one corrective retry.
import { z } from "zod/v4";

export const PROVIDERS = ["anthropic", "verda"];

// Settings win over the environment; the older TPM_* names from .env are accepted as aliases.
export function verdaConfig(settings = {}) {
  const raw = settings.verda_base_url || process.env.VERDA_BASE_URL || process.env.TPM_EXTERNAL_BASE_URL || "";
  const base = raw.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  const fromUrl = (base.match(/\/([a-z0-9-]*mistral[a-z0-9-]*)\//i) || [])[1] || "";
  return {
    base_url: base,
    chat_url: base ? `${base}/chat/completions` : "",
    api_key: settings.verda_api_key || process.env.VERDA_API_KEY || process.env.TPM_EU_API_KEY || "",
    model: settings.verda_model || process.env.VERDA_MODEL || (fromUrl ? fromUrl.replace(/^data-sovereignty-/, "") : "mistral-large-3"),
    timeout_ms: Number(process.env.VERDA_TIMEOUT_MS || 300000),
    // USD per million tokens, for the cost meter; set VERDA_PRICE_IN/OUT when known.
    price: [Number(process.env.VERDA_PRICE_IN || 0), Number(process.env.VERDA_PRICE_OUT || 0)],
  };
}
export function verdaConfigured(settings = {}) { const c = verdaConfig(settings); return Boolean(c.chat_url && c.api_key); }

export function provider(settings = {}) {
  const p = String(settings.llm_provider || process.env.LLM_PROVIDER || "").toLowerCase();
  if (PROVIDERS.includes(p)) return p;
  return "anthropic";
}
// Fallback to Claude when the Verda call fails: on by default unless the operator turns it off (strict data sovereignty).
export function fallbackAllowed(settings = {}) {
  if (settings.llm_fallback != null) return Boolean(settings.llm_fallback);
  return String(process.env.LLM_FALLBACK || "anthropic").toLowerCase() !== "none";
}
export function webToolsAvailable(settings = {}) {
  return provider(settings) === "anthropic" || fallbackAllowed(settings);
}

const stripFences = (t) => String(t || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
function extractJson(text) {
  const t = stripFences(text);
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("no JSON object in the model output");
}

async function chat(cfg, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeout_ms);
  let res;
  try {
    res = await fetch(cfg.chat_url, { method: "POST", headers: { Authorization: `Bearer ${cfg.api_key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (err) {
    throw Object.assign(new Error(`Verda endpoint unreachable: ${err.name === "AbortError" ? "timed out" : err.message}`), { status: 502 });
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || json?.error) {
    const msg = typeof json?.error === "string" ? json.error : json?.error?.message || json?.msg || json?.message || text.slice(0, 200);
    throw Object.assign(new Error(`Verda (${res.status}): ${msg}`), { status: res.status || 502, verda: true, body: json });
  }
  return json;
}

// Structured call: returns the Zod-validated object. `onUsage(usage, model)` lets the caller meter tokens.
export async function verdaParse(settings, { schema, system, user, max_tokens = 8000, name = "result", onUsage }) {
  const cfg = verdaConfig(settings);
  if (!cfg.chat_url || !cfg.api_key) throw Object.assign(new Error("Verda is not configured: set VERDA_BASE_URL and VERDA_API_KEY (or the TPM_* aliases) or fill them in Settings."), { status: 409 });
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });
  const messages = [{ role: "system", content: `${system}\n\nAnswer with a single JSON object that matches this JSON schema exactly (no prose, no markdown fences):\n${JSON.stringify(jsonSchema)}` }, { role: "user", content: user }];
  const attempt = async (msgs, responseFormat) => {
    const body = { model: cfg.model, messages: msgs, max_tokens, temperature: 0.3 };
    if (responseFormat) body.response_format = responseFormat;
    const out = await chat(cfg, body);
    if (onUsage && out.usage) onUsage({ input_tokens: out.usage.prompt_tokens || 0, output_tokens: out.usage.completion_tokens || 0 }, cfg.model);
    const content = out.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((c) => c.text || "").join("") : content;
    return extractJson(text);
  };
  const formats = [
    { type: "json_schema", json_schema: { name, schema: jsonSchema, strict: true } },
    { type: "json_object" },
    null,
  ];
  let lastErr = null, data = null;
  for (const fmt of formats) {
    try { data = await attempt(messages, fmt); break; }
    catch (err) {
      lastErr = err;
      // A 4xx that mentions the response format means this endpoint does not support it: try the next mode.
      if (err.verda && err.status >= 400 && err.status < 500 && /response_format|json_schema|guided|unsupported|unknown field/i.test(err.message)) continue;
      if (err.verda) throw err; // deployment down, auth, quota …
      continue; // JSON extraction failed: try a looser mode
    }
  }
  if (data == null) throw lastErr || new Error("Verda returned no usable JSON");
  let parsed = schema.safeParse(data);
  if (!parsed.success) {
    // One corrective round-trip with the validation errors.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    const fixed = await attempt([...messages, { role: "assistant", content: JSON.stringify(data) }, { role: "user", content: `That JSON did not match the schema (${issues}). Return the corrected JSON object only.` }], { type: "json_object" });
    parsed = schema.safeParse(fixed);
    if (!parsed.success) throw new Error(`Verda output did not match the expected schema: ${issues}`);
  }
  return parsed.data;
}

// Quick connectivity check for Settings and the sources tab.
export async function verdaPing(settings = {}) {
  const cfg = verdaConfig(settings);
  if (!cfg.chat_url || !cfg.api_key) return { ok: false, configured: false, reason: "not configured" };
  try {
    const t0 = Date.now();
    const out = await chat({ ...cfg, timeout_ms: 30000 }, { model: cfg.model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 5 });
    return { ok: true, configured: true, model: out.model || cfg.model, ms: Date.now() - t0, endpoint: cfg.base_url };
  } catch (err) { return { ok: false, configured: true, reason: err.message, endpoint: cfg.base_url, model: cfg.model }; }
}
