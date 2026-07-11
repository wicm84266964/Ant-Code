# Research Data Boundary

This document defines the data boundary for Ant Code.

## Primary Rule

Sensitive project data must not leave approved infrastructure unless a project owner explicitly approves the destination and the approval is recorded.

Default behavior is local-first and gateway-only.

## Data Classes

| Class | Examples | Default handling |
| --- | --- | --- |
| Public code | Open-source dependencies, public examples | May be sent to approved model gateway |
| Internal code | Private scripts, unpublished methods, project tools | Approved gateway only |
| Sensitive research data | Raw data, patient/subject data, unpublished measurements, proprietary datasets | Do not send by default; require explicit policy exception |
| Credentials | API keys, SSH keys, cloud tokens, cookies, OAuth tokens | Never send to model; scrub from env and logs |
| Personal data | Names, emails, student IDs, human subject metadata | Treat as sensitive unless explicitly public |
| Transcripts | Prompts, model responses, tool results | Local by default; retention-limited; optional encryption |
| Tool outputs | Shell output, diffs, test logs | Same class as content included in the output |

## Approved Data Flows

Allowed by default:

- User terminal to local Ant Code process.
- Local agent to configured model gateway.
- Local agent to local filesystem within approved workspace.
- Local agent to local shell after permission check.
- Local agent to approved local or managed MCP servers.
- Local agent to managed policy/config service.
- Local agent to managed plugin/skill registry.

Conditionally allowed:

- Local agent to public internet for package/docs lookup, only if the project policy allows web access.
- Local agent to approved object storage for large attachments.
- Local agent to approved scheduler or compute runner.

Forbidden by default:

- private provider web apps
- provider API hosts except through an explicitly approved gateway design
- provider console OAuth hosts
- unreviewed telemetry intake
- unreviewed remote feature config
- Feedback endpoints
- Transcript upload endpoints
- Official marketplace auto-install endpoints
- Unapproved third-party MCP servers

## Model Traffic Boundary

All model requests must go through `LAB_MODEL_GATEWAY_URL` or an equivalent approved endpoint.

The client must not directly read or use:

- provider API keys
- provider OAuth tokens
- Console OAuth tokens
- Unscoped user cloud credentials

The gateway owns:

- Provider routing.
- Quota.
- Audit policy.
- Optional redaction.
- Model allowlist.
- Request/response retention policy.

The local client owns:

- User confirmation.
- Workspace scoping.
- Tool execution policy.
- Local transcript policy.
- Secret scrubbing before request construction.

## Dashboard Browser Boundary

Dashboard is a loopback-only browser surface, not a network-sharing feature. It
accepts `127.0.0.1`, `localhost`, or `::1` and rejects other bind hosts. Every
process generates fresh session and CSRF credentials. Root-page bootstrap places
the session credential in an `HttpOnly; SameSite=Strict` cookie and a separate
`SameSite=Strict` CSRF cookie that must be echoed in a request header.

All API calls are checked against the exact bound Host and port. Supplied Origin
and cross-site fetch context must be acceptable; state-changing requests must be
JSON and pass CSRF validation. Dashboard cannot be framed because its Content
Security Policy includes `frame-ancestors 'none'` and responses also send
`X-Frame-Options: DENY`. Credential values must not be logged, documented, or
used to imply support for LAN or public access.

Browser-visible file access stays within the approved workspace after canonical
`realpath` validation, including symlink and junction targets. Remote Markdown
images are not fetched automatically and remain text or external links. SVG is
download-only rather than embedded as same-origin active content. Office preview
input is capped at 10 MiB and parsed in a worker limited to 1,000 entries, 16 MiB
per entry, 64 MiB total extraction, a 200:1 compression ratio, and 3 seconds.
Raw file responses are capped at 20 MiB.

Turn input is bounded to a 40 MiB JSON body and a 256 KiB UTF-8 prompt. Image
input is limited to six PNG, JPEG, GIF, or WebP files, at most 8 MiB each and 24
MiB total; canonical base64 and content signatures are verified. Other JSON
request bodies are capped at 1 MiB.

Dashboard transcript pages default to 100 messages and are capped at 200, while
the browser mounts no more than 300 transcript nodes. Active runtime state is
bounded separately from durable history: only reclaimable idle state is evicted,
and persisted sessions plus older transcript metadata/chunks remain available.

## Local Transcript Policy

Default:

- Store transcripts/session metadata locally under the Ant Code local state directory.
- Do not upload transcripts.
- Do not include raw secrets.
- Retain for a bounded period or bounded size.
- For high-sensitivity projects, set retention to zero so new local session metadata is not persisted.
- When encryption is required, keep key material outside repository config and pass it through the local environment.
- Conversation compaction summaries are session-local process memory only. Metadata may record context counts and byte totals, but not raw compacted text.
- Transcript archive chunks may store redacted visible conversation messages
  locally under `.lab-agent/sessions/<session-id>.transcript/` when transcript
  retention is enabled. TUI and Dashboard use those chunks for paged local
  review.
- Model-context archive chunks may store redacted model history locally under
  `.lab-agent/sessions/<session-id>.model-context/`, including assistant
  tool-call requests and matching local tool results. Resume uses these chunks
  for model-context restoration within the configured resume budget; older
  sessions without them fall back to transcript chunks.
- File paths are preserved by transcript/context redaction because they are
  necessary for code tasks and resume quality. Secret-like values remain
  redacted, including Bearer tokens, API keys, token/secret/password/credential/
  authorization values, and emails.

Recommended settings:

- `LAB_AGENT_TRANSCRIPT_RETENTION_DAYS=30` for normal projects.
- `LAB_AGENT_TRANSCRIPT_RETENTION_DAYS=0` for high-sensitivity projects.
- `LAB_AGENT_SENSITIVITY=high` for sensitive research projects; this forces metadata disabled / zero-retention and rejects broad network modes.
- `LAB_AGENT_TRANSCRIPT_ENCRYPTION=required` on shared workstations.
- `LAB_AGENT_TRANSCRIPT_KEY` supplied by the local operator or lab secret manager when encryption is enabled.
- `transcript.includeToolOutput=policy` so high-risk command output can be redacted.
- `models[].contextTokens` and `context.maxTokens` sized to the configured gateway model window, with `context.maxBytes`, `context.maxMessages`, `context.keepRecentMessages`, and `context.summaryBytes` as secondary local safety bounds for project sensitivity.

## Shell and Subprocess Boundary

Default subprocess policy:

- Scrub sensitive environment variables.
- Block known credential files from reads unless explicitly approved.
- Require confirmation for writes outside the workspace.
- Require confirmation for network commands if project policy is offline.
- Deny destructive recursive operations unless a human approves the exact path.

Environment variables to scrub by default:

- `*_API_KEY`
- `*_TOKEN`
- `*_SECRET`
- `*_PASSWORD`
- `AWS_*`
- `GITHUB_TOKEN`
- `SSH_AUTH_SOCK`
- `OPENAI_API_KEY`
- provider API key variables
- OAuth token variables

## MCP Boundary

Default:

- Local stdio MCP is allowed only from configured paths.
- HTTP MCP is allowed only from approved hosts.
- MCP server environment variables are scrubbed unless explicitly allowlisted.
- MCP tools inherit the same permission engine as built-in tools.

Forbidden by default:

- Auto-discovering third-party managed MCP servers.
- Auto-installing official MCP servers.
- Passing raw credentials to unreviewed MCP servers.

## Plugin and Skill Boundary

Default:

- Plugins and skills come from managed registries or local project paths.
- Plugin packages must be version-pinned.
- Registry entries must include owner, source, checksum, and review status.
- Auto-update is disabled unless a managed registry signs releases.

Forbidden by default:

- Official marketplace auto-install.
- Unpinned GitHub marketplace installs.
- Runtime plugin downloads from arbitrary URLs.

## Network Policy

Ant Code should support these modes:

| Mode | Behavior |
| --- | --- |
| `offline` | No network except loopback. |
| `lab-only` | Configured gateway, managed config, approved MCP, and managed registry only. |
| `approved-web` | Managed endpoints plus explicit web allowlist. |
| `open-dev` | Developer mode for non-sensitive repos only; must show warning. |

Default for managed deployment: `lab-only`.

`LAB_AGENT_NETWORK_MODE` can temporarily override the configured network mode
for a local session. Use it for explicit operator-controlled switches such as
offline validation or high-sensitivity project work.

High-sensitivity mode permits only `offline` or `lab-only`. `approved-web` and `open-dev` are rejected for high-sensitivity sessions.

## Audit Requirements

Every release must produce:

- Dependency SBOM.
- Dependency license summary.
- Network endpoint manifest.
- Plugin registry manifest.
- Model gateway config summary.
- Policy defaults summary.
- Transcript retention summary.
- Known exceptions list.

Every exception must record:

- Requester.
- Project.
- Data class.
- Destination.
- Expiration date.
- Approver.

## Initial Denylist

The new repository should fail CI if these strings appear in runtime code without an explicit test fixture exception:

- private provider web apps
- private provider coding-agent endpoints
- provider console OAuth hosts
- provider MCP proxy hosts
- unreviewed telemetry intake hosts
- unreviewed telemetry SDKs
- unreviewed remote feature-flag SDKs
- private provider endpoint clients
- `shared_session_transcripts`
- `claude_cli_feedback`
