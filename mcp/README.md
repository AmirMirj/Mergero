# Mergero Origination Engine — MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) **stdio** server that exposes the engine (`server/index.js`, REST contract in `../API.md`) to Claude Desktop, Claude Code, the MCP Inspector or any MCP client. Mergero already runs its outreach through Claude and MCP against its own database; this server plugs the origination engine into that workflow.

Every outreach message still passes the human gate: `mergero_approve_message` never sends, `mergero_send_message` is the only tool that reaches an owner, and its description says so.

## Tools (31)

| Group | Tools |
|---|---|
| Read | `mergero_stats`, `mergero_playbook`, `mergero_list_prospects`, `mergero_get_prospect`, `mergero_registry_search`, `mergero_inbox`, `mergero_pending_approvals`, `mergero_get_message`, `mergero_list_buyers`, `mergero_watch_alerts`, `mergero_mail_status`, `mergero_job_status` |
| Sourcing and agents (mutate) | `mergero_import_prospects`, `mergero_add_prospect`, `mergero_update_prospect`, `mergero_run_pipeline`, `mergero_run_step`, `mergero_run_pipeline_bulk`, `mergero_set_stage`, `mergero_intake_link`, `mergero_add_buyer` |
| Messages, the approval gate (mutate) | `mergero_update_message`, `mergero_humanize_message`, `mergero_approve_message`, `mergero_reject_message`, `mergero_unschedule_message`, `mergero_send_message`, `mergero_record_reply` |
| Email plumbing (mutate) | `mergero_simulate_inbound_email`, `mergero_run_sweep` |

**Resources:** `mergero://stats`, `mergero://playbook`, `mergero://inbox`, `mergero://buyers`, template `mergero://prospect/{id}`.
**Prompts:** `review_pending_drafts`, `work_the_inbox`, `source_prospects`.

## Run

The engine must be running (`npm start` in the repo root, http://localhost:3000).

```bash
cd mcp && npm install
npm test        # smoke test over stdio against the running engine
npm run inspect # MCP Inspector
```

Config: `MERGERO_API_URL` (default `http://localhost:3000`).

## Wire it into a client

Claude Code:

```bash
claude mcp add mergero -- node C:/Users/dangv/Documents/prompt-marketing/mergero/mcp/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "mergero": {
      "command": "node",
      "args": ["C:/Users/dangv/Documents/prompt-marketing/mergero/mcp/index.js"],
      "env": { "MERGERO_API_URL": "http://localhost:3000" }
    }
  }
}
```

## Files

```
index.js   server: tools, resources, prompts; connects stdio
client.js  fetch wrapper over the engine's /api/*
smoke.mjs  stdio smoke test (npm test)
```
