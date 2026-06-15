---
module: src/mcp
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/mvp-product-spec.md
  - public_protocol: Model Context Protocol
design_notes:
  - Supports explicit local stdio MCP servers only.
  - Does not auto-discover, auto-install, or contact remote MCP marketplaces.
  - Uses a minimal JSON-RPC stdio client for initialize, tools/list, tools/call, prompts/list, resources/list, and resources/read.
  - Maintains persistent per-server clients with tool caches, status records, reconnect/disconnect controls, timeout handling, and bounded stderr summaries.
  - Provides configured server/tool/prompt/resource listing through slash commands and the mcp_list model tool.
  - Normalizes Windows `npx` stdio launches through `cmd /c` so configured npm MCP servers run from PowerShell environments.
  - Closes MCP runtimes after session turns, slash commands, and subagent calls to avoid orphaned stdio server processes.
  - MCP tool risk comes from local config and unknown risk defaults to ask.
  - MCP tool calls pass through the permission engine before invocation.
  - Checked-in recommended servers remain disabled by default and require explicit lab approval before use.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# MCP Provenance

The MCP module is an explicit local runtime for configured stdio servers. It avoids marketplace discovery and remote connector behavior. The default root config and lab template include disabled recommendations for filesystem, memory, and Playwright MCP servers; they are examples for lab approval, not auto-enabled connectors.
