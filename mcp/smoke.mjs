// Smoke test: start the MCP server over stdio, list what it exposes, call a few read tools, read a resource, get a prompt.
// Needs the engine running (MERGERO_API_URL, default http://localhost:3000).  Run: npm test
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, "index.js")], env: { ...process.env }, stderr: "pipe" });
const client = new Client({ name: "mergero-mcp-smoke", version: "0.1.0" });
let failures = 0;
const check = (name, cond, extra) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "   " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300) : ""}`); if (!cond) failures++; };
const parse = (r) => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } };

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  check("tools registered", tools.length >= 25, `${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
  const resources = (await client.listResources()).resources;
  const templates = (await client.listResourceTemplates()).resourceTemplates;
  check("resources + template", resources.length === 4 && templates.length === 1, resources.map((r) => r.uri));
  const prompts = (await client.listPrompts()).prompts;
  check("prompts", prompts.length === 3, prompts.map((p) => p.name));

  const stats = parse(await client.callTool({ name: "mergero_stats", arguments: {} }));
  check("mergero_stats", typeof stats.total === "number", { total: stats.total, pending: stats.messages_pending_approval, unhandled: stats.replies_unhandled });
  const list = parse(await client.callTool({ name: "mergero_list_prospects", arguments: { limit: 3 } }));
  check("mergero_list_prospects compact rows", list.total > 0 && list.prospects.length === 3 && "readiness" in list.prospects[0], list.prospects[0].name);
  const one = parse(await client.callTool({ name: "mergero_get_prospect", arguments: { id: list.prospects[0].id } }));
  check("mergero_get_prospect", one.id === list.prospects[0].id && Array.isArray(one.messages));
  const inbox = parse(await client.callTool({ name: "mergero_inbox", arguments: {} }));
  check("mergero_inbox", inbox.counts && Array.isArray(inbox.items), inbox.counts);
  const pending = parse(await client.callTool({ name: "mergero_pending_approvals", arguments: { limit: 5 } }));
  check("mergero_pending_approvals", typeof pending.total === "number" && Array.isArray(pending.drafts), { total: pending.total });
  const pb = parse(await client.callTool({ name: "mergero_playbook", arguments: {} }));
  check("mergero_playbook", typeof pb.messaging_principles === "string");
  const bad = await client.callTool({ name: "mergero_get_prospect", arguments: { id: "c_does_not_exist" } });
  check("errors come back as isError, not crashes", bad.isError === true, bad.content[0].text);
  const res = await client.readResource({ uri: "mergero://playbook" });
  check("resource mergero://playbook", res.contents[0].mimeType === "application/json" && JSON.parse(res.contents[0].text).mandate_path.length === 5);
  const pr = await client.readResource({ uri: `mergero://prospect/${list.prospects[0].id}` });
  check("resource template mergero://prospect/{id}", JSON.parse(pr.contents[0].text).id === list.prospects[0].id);
  const prompt = await client.getPrompt({ name: "review_pending_drafts", arguments: { company_id: list.prospects[0].id } });
  check("prompt review_pending_drafts", prompt.messages[0].content.text.includes(list.prospects[0].id));
} catch (err) {
  check("smoke run", false, err.message);
} finally {
  await client.close().catch(() => {});
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
