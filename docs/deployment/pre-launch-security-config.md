# Pre-Launch Security Config

This template describes the local client settings recommended before a real lab rollout. Replace placeholder hosts with lab-owned internal names. Do not commit real secrets.

## Environment Template

PowerShell example:

```powershell
$env:LAB_AGENT_NETWORK_MODE = "lab-only"
$env:LAB_AGENT_MODEL = "example-coding-model"
$env:LAB_MODEL_GATEWAY_PROTOCOL = "lab-agent-gateway"
$env:LAB_MODEL_GATEWAY_URL = "https://gateway.lab.example/v1/chat"
$env:LAB_MODEL_GATEWAY_HEALTH_URL = "https://gateway.lab.example/health"
$env:LAB_AGENT_ALLOWED_HOSTS = "gateway.lab.example"
$env:LAB_AGENT_TRANSCRIPT_ENABLED = "true"
$env:LAB_AGENT_TRANSCRIPT_RETENTION_DAYS = "30"
$env:LAB_AGENT_TRANSCRIPT_ENCRYPTION = "optional"
$env:LAB_AGENT_SENSITIVITY = "standard"
$env:LAB_AGENT_CONTEXT_MAX_MESSAGES = "100000"
$env:LAB_AGENT_CONTEXT_MAX_BYTES = "800000"
$env:LAB_AGENT_CONTEXT_MAX_TOKENS = "200000"
$env:LAB_AGENT_CONTEXT_KEEP_RECENT_MESSAGES = "8"
$env:LAB_AGENT_CONTEXT_SUMMARY_BYTES = "8192"
$env:LAB_AGENT_MAX_TOOL_ROUNDS = "16"
$env:LAB_AGENT_AGENT_MAX_ROUNDS = "16"
```

High-sensitivity project override:

```powershell
$env:LAB_AGENT_SENSITIVITY = "high"
$env:LAB_AGENT_NETWORK_MODE = "lab-only"
```

## Lab-Owned Config File Template

Prefer a lab-owned config path for shared machines:

```powershell
$env:LAB_AGENT_CONFIG = "C:\lab-agent\config\lab-agent.config.json"
```

Use the JSON template at `config/lab-agent.lab-template.json` as a starting point. For sensitive research projects, start from `config/lab-agent.high-sensitivity-template.json`. Keep the configured gateway host in `allowedHosts`; project-local config should not silently broaden network access.

## Required Local Policy

- `networkMode` should be `lab-only` for normal lab deployment.
- `allowedHosts` should include only lab-owned gateway, config, and approved MCP hosts.
- `transcript.retentionDays` should be 30 or lower; use 0 for high-sensitivity projects.
- `mcp.servers` should remain empty until individual servers have owner, path, tool-risk, and data-boundary review.
- Provider credentials must not be present in the local client environment.
- `LAB_MODEL_GATEWAY_API_KEY`, if required by an adapter, must be a gateway access token only and should not be committed to config files.

## Variables Allowed In The Client

| Variable | Purpose | Secret |
| --- | --- | --- |
| `LAB_MODEL_GATEWAY_PROTOCOL` | Gateway protocol selector: `lab-agent-gateway` or `openai-chat`. | No. |
| `LAB_MODEL_GATEWAY_URL` | Lab chat endpoint. | No, but treat as internal. |
| `LAB_MODEL_GATEWAY_HEALTH_URL` | Lab health endpoint. | No, but treat as internal. |
| `LAB_MODEL_GATEWAY_API_KEY` | Optional gateway adapter bearer token. Must not be a provider key. | Yes. |
| `LAB_AGENT_MODEL` | Lab model alias. | No. |
| `LAB_AGENT_NETWORK_MODE` | Local network policy mode. | No. |
| `LAB_AGENT_ALLOWED_HOSTS` | Additional explicit host allowlist. | No. |
| `LAB_AGENT_CONFIG` | Path to lab-owned config JSON. | No. |
| `LAB_AGENT_TRANSCRIPT_ENABLED` | Local transcript toggle. | No. |
| `LAB_AGENT_TRANSCRIPT_RETENTION_DAYS` | Local retention period. | No. |
| `LAB_AGENT_TRANSCRIPT_ENCRYPTION` | Local record encryption mode: `off`, `optional`, or `required`. | No. |
| `LAB_AGENT_TRANSCRIPT_KEY` | Local encryption passphrase or key material for session metadata. | Yes. |
| `LAB_AGENT_SENSITIVITY` | `standard` or `high`; high forces zero-retention metadata and restricts network modes. | No. |
| `LAB_AGENT_CONTEXT_MAX_MESSAGES` | Secondary message-count safety bound before automatic compaction. | No. |
| `LAB_AGENT_CONTEXT_MAX_BYTES` | Secondary serialized-byte safety bound before automatic compaction. | No. |
| `LAB_AGENT_CONTEXT_MAX_TOKENS` | Estimated active-context token budget before automatic compaction. | No. |
| `LAB_AGENT_CONTEXT_KEEP_RECENT_MESSAGES` | Recent messages kept verbatim after compaction. | No. |
| `LAB_AGENT_CONTEXT_SUMMARY_BYTES` | Byte budget for the session-local compacted summary. | No. |
| `LAB_AGENT_MAX_TOOL_ROUNDS` | Main turn model-tool loop safety bound. Raise for deliberate long tool-heavy work. | No. |
| `LAB_AGENT_AGENT_MAX_ROUNDS` | Default subagent model-tool loop safety bound when a profile does not set `maxRounds`. | No. |

## Variables Forbidden In The Client

Do not set provider API keys, provider OAuth tokens, cloud console tokens, SSH credentials, or dataset access tokens in the local client shell used for Ant Code. Provider credentials belong inside the lab gateway service boundary.

The local tool runtime scrubs secret-like variables before shell tool execution, but deployment should still avoid exposing unnecessary credentials to the client process.

## Pre-Launch Commands

Run these on the candidate machine:

```sh
npm run verify:release
node src/cli/index.js doctor
node src/cli/index.js gateway
node src/cli/index.js gateway --live
node scripts/verify-gateway-compat.js --live
```

`doctor` should be reviewed before adding a cohort. Warnings are acceptable for local development, but broad lab rollout should normally have a lab-managed config path, configured gateway and health URLs, explicit allowed hosts, reviewed MCP servers, and either optional/required metadata encryption or zero-retention for high-sensitivity projects.

For high-sensitivity projects, also verify local session cleanup:

```sh
node src/cli/index.js -p "/sessions cleanup"
```

## Approval Record

Record these before giving access to a lab cohort:

| Field | Value |
| --- | --- |
| Client commit | pending |
| Gateway deployment ID | pending |
| Gateway owner | pending |
| Model aliases approved | pending |
| Data classes approved | pending |
| Transcript retention | pending |
| Gateway retention | pending |
| Rollback owner | pending |
| Approval expiration | pending |
