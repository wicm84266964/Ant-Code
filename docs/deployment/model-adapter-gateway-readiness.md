# Model Adapter Gateway Readiness

Ant Code uses a model gateway/model adapter layer for model traffic. This layer is not a remote tool server. Local files, shell commands, git state, MCP calls, and edit approvals stay inside the local Ant Code client.

## Current Client Surfaces

- `ant-code` defaults to the terminal TUI.
- `ant-code dashboard` starts the local Dashboard WebUI on loopback, default port `7410`, and opens the browser.
- TUI and Dashboard share the same model gateway, permission engine, context compaction, and local session metadata. Gateway adapters should not special-case UI surfaces except for operator correlation, audit labels, or display diagnostics.

## Boundary

Required boundary:

- Tools execute on the local client.
- The model gateway receives prompts, tool definitions, and bounded tool results only when model turns are requested.
- Provider credentials live inside the gateway/model adapter service boundary, not in the local Ant Code shell.
- `LAB_MODEL_GATEWAY_API_KEY`, when used, is only a gateway access token for that adapter. Do not place provider API keys in the local client environment.
- Remote tools are disabled by default and are not required for MVP.
- A loopback adapter at `127.0.0.1` is acceptable for local models.
- A lab-only or VPN-only adapter is preferred for shared GPU or hosted models.
- Public exposure is optional and must add authentication, TLS, rate limits, audit IDs, and data-retention review.

## Required Endpoints

- `LAB_MODEL_GATEWAY_URL`: provider-independent chat endpoint.
- `LAB_MODEL_GATEWAY_PROTOCOL`: optional protocol selector. Defaults to `lab-agent-gateway`; use `openai-chat` for OpenAI Chat Completions compatible local adapters.
- `LAB_MODEL_GATEWAY_API_KEY`: optional bearer token for the configured adapter URL.
- `LAB_MODEL_GATEWAY_HEALTH_URL`: optional health endpoint for explicit live checks.

Health checks never carry prompts, tool definitions, tool results, provider keys, or transcript content.

For an OpenAI-compatible loopback adapter:

```sh
LAB_MODEL_GATEWAY_PROTOCOL=openai-chat
LAB_MODEL_GATEWAY_URL=http://127.0.0.1:8080/v1/chat/completions
LAB_MODEL_GATEWAY_HEALTH_URL=http://127.0.0.1:8080/health
LAB_AGENT_NETWORK_MODE=offline
```

Current request behavior to account for:

- Ant Code sends `x-session-affinity` when a session id is available. Treat it as a routing/cache affinity hint only, not an authentication token.
- In OpenAI-compatible mode, Ant Code sends `tools` when local tools are available but does not force `tool_choice: "auto"` by default.
- In OpenAI-compatible mode, Ant Code sends image attachments as
  Chat Completions `image_url` data URL blocks when the selected model turn
  includes image input.
- In the provider-independent protocol, Ant Code sets
  `metadata.capabilities.images=true` when user messages include image blocks.
- Streaming requests may include usage options such as `stream_options.include_usage=true`; adapters should ignore unsupported compatibility fields safely.
- In streaming mode, complete SSE events or NDJSON lines should be flushed promptly. Dashboard live draft cards depend on incremental `text_delta` delivery during the turn.
- Provider reasoning/thinking deltas are not displayed as normal assistant text in Dashboard. Visible user-facing text should use normal assistant content/delta fields.
- If the gateway/model route is text-only, reject image requests with a bounded
  4xx error that clearly states image or vision input is unsupported. Ant Code
  uses that wording for operator diagnostics.
- Dashboard model configuration is single-gateway. A text main model and visual
  fallback model can coexist only when both are registered under the same active
  gateway/key.

## Compatibility Evidence

Dry mock check:

```sh
npm run verify:gateway
```

Live text report:

```sh
node scripts/verify-gateway-compat.js --live
```

Live JSON evidence:

```sh
node scripts/verify-gateway-compat.js --live --json
```

The JSON evidence is intentionally non-sensitive. It records protocol version, model alias, network mode, configured endpoint booleans, chat normalization status, and the local-tool boundary declaration.

For adapters that support streaming, keep at least one evidence item showing that visible deltas arrive before final completion. A gateway that buffers all stream records until the response closes may pass basic text normalization while still making Dashboard appear stalled.

For adapters that support vision, keep one evidence item showing a small image
request succeeds through the configured model alias. For adapters that do not
support vision, keep one evidence item showing a clear unsupported-image error.

## Gateway Responsibilities

The gateway/model adapter owns:

- provider credential storage
- model alias routing
- quota and rate limiting
- gateway-side retention policy
- gateway-side audit IDs
- optional provider failover

The local client owns:

- workspace file reads and writes
- local command execution
- git state inspection
- local MCP process execution
- approval prompts
- metadata retention for local session summaries

## Rollout Questions

Before broad use, record answers for:

- Is the adapter loopback, lab-only, VPN-only, or public?
- Which model aliases are allowed?
- What data classes may be sent through this adapter?
- What retention policy applies to gateway logs?
- What audit ID appears in gateway logs for a compatibility check?
- Who owns rollback if the adapter fails or returns malformed responses?
