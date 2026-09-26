// Self-test for server/llm.js against a fake OpenAI-compatible endpoint (no network, no real key).
// Run: node server/llm.selftest.mjs   — exercises json_schema mode, the json_object fallback, and the corrective retry.
import http from "node:http";
import { z } from "zod/v4";

async function runMode(MODE) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      calls++;
      if (!(req.headers.authorization || "").startsWith("Bearer dc_")) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "bad key" } })); }
      const b = JSON.parse(body); const fmt = b.response_format?.type;
      if (MODE === "object" && fmt === "json_schema") { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "response_format json_schema unsupported" } })); }
      const lastUser = b.messages.filter((m) => m.role === "user").pop()?.content || "";
      const content = MODE === "invalid_then_fix" && !/did not match/.test(lastUser) ? JSON.stringify({ fit: "high", reason: "x" }) : "```json\n" + JSON.stringify({ fit: 77, reason: `mode=${MODE} fmt=${fmt || "none"} model=${b.model}` }) + "\n```";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", model: b.model, choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }));
    });
  });
  await new Promise((r) => server.listen(3199, r));
  process.env.VERDA_BASE_URL = "http://localhost:3199/deploy/v1"; process.env.VERDA_API_KEY = "dc_test"; process.env.VERDA_MODEL = "mistral-large-3"; process.env.LLM_PROVIDER = "verda";
  const llm = await import("./llm.js");
  const agents = await import("./agents.js");
  const schema = z.object({ fit: z.number().int(), reason: z.string() });
  const settings = { model: "claude-opus-5", api_key: "", llm_provider: "verda" };
  const usage = [];
  const out = await llm.verdaParse(settings, { schema, system: "sys", user: "u", onUsage: (u, m) => usage.push([u, m]) });
  const via = await agents.parse(settings, { schema, system: "sys", user: "u" });
  const ping = await llm.verdaPing(settings);
  console.log(`[${MODE}] verdaParse=${JSON.stringify(out)} | via agents.parse fit=${via.fit} | calls=${calls} | usage=${JSON.stringify(usage[0])} | ping.ok=${ping.ok}`);
  if (out.fit !== 77 || via.fit !== 77 || !ping.ok) throw new Error(`mode ${MODE} failed`);
  await new Promise((r) => server.close(r));
}
for (const m of ["schema", "object", "invalid_then_fix"]) await runMode(m);
console.log("PASS: llm.js structured output modes");
