# Lab Model Gateway Protocol

This document defines the clean-room MVP client-to-gateway contract. It is lab-owned and provider-independent.

## Request

The local client sends one JSON `POST` request to `LAB_MODEL_GATEWAY_URL`.

```json
{
  "protocolVersion": "lab-agent-gateway.v1",
  "model": "default",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "tools": [],
  "stream": false,
  "metadata": {
    "client": "lab-agent",
    "sessionId": "optional-session-id",
    "capabilities": {
      "tools": true,
      "toolResults": true,
      "streaming": false,
      "images": false
    },
    "boundary": {
      "toolExecution": "local-client",
      "providerCredentials": "gateway-only",
      "remoteTools": false
    },
    "request": {
      "messageCount": 1,
      "toolCount": 0,
      "toolResultCount": 0
    }
  }
}
```

Rules:

- The local client never sends provider API keys.
- `LAB_MODEL_GATEWAY_API_KEY`, when set, is treated as an adapter access token for the configured gateway URL. It must not be a provider API key.
- The gateway owns provider routing, quota, audit policy, and retention.
- The client may include tool definitions, but tool execution remains local and permission-gated.
- The gateway URL must pass local network policy before any request is sent.
- Requests include `x-session-affinity: <sessionId>` when a session id is available. Gateways may use it as a best-effort routing/cache affinity hint; it is not an authentication token.
- `metadata.capabilities` and `metadata.request` contain only non-sensitive booleans/counts for compatibility diagnostics.
- `metadata.boundary` declares that tools execute locally, provider credentials stay behind the gateway/model adapter, and remote tools are not required for MVP.
- When a request includes image attachments, user message `content` may be an
  array of text and image blocks. The client sets `metadata.capabilities.images`
  to `true`; image bytes are sent only for the active model request and are not
  written to local session metadata.

Image block shape in the provider-independent protocol:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "describe this screenshot" },
    {
      "type": "image",
      "mimeType": "image/png",
      "name": "screenshot.png",
      "size": 12345,
      "data": "<base64>"
    }
  ]
}
```

Gateways that route to text-only models should reject image requests with a
clear bounded error body. Ant Code surfaces this as an unsupported vision/input
diagnostic; it does not attempt to infer provider model capabilities by probing
provider-specific model-list endpoints.

## Non-Streaming Response

```json
{
  "id": "gateway-message-id",
  "model": "resolved-model",
  "content": [
    { "type": "text", "text": "assistant response" }
  ],
  "toolCalls": [],
  "stopReason": "stop",
  "usage": {
    "promptBytes": 123,
    "completionBytes": 45
  }
}
```

If the gateway wants the local client to run a tool, it returns `toolCalls` and no final text:

```json
{
  "id": "gateway-message-id",
  "model": "resolved-model",
  "content": [],
  "toolCalls": [
    {
      "id": "tool-1",
      "name": "read_file",
      "input": { "path": "README.md" }
    }
  ],
  "stopReason": "tool_use"
}
```

The client validates the tool name and input, asks the permission engine, executes allowed tools locally, and sends the next request with both message history and bounded `toolResults`.

```json
{
  "toolResults": [
    {
      "toolCallId": "tool-1",
      "name": "read_file",
      "content": "{\"ok\":true,\"result\":{\"path\":\"README.md\"}}",
      "truncated": false
    }
  ]
}
```

MVP print mode limits tool-call recursion to three rounds. Write tools require explicit local session approval. Without approval, the tool result reports a blocked permission decision and no filesystem mutation occurs.

## Streaming Response

MVP accepts either `text/event-stream` or `application/x-ndjson` records. Supported record types:

- `message_start`
- `text_delta`
- `content_delta`
- `message_delta`
- `message_stop`

Example SSE payload:

```text
data: {"type":"message_start","id":"msg-1","model":"default"}

data: {"type":"text_delta","text":"hello"}

data: {"type":"message_stop","stopReason":"stop"}

data: [DONE]
```

Streaming dispatch requirement:

- The client parser dispatches each complete SSE event or NDJSON line as soon as it arrives, before the full response body closes.
- Gateways should flush complete records promptly. Dashboard WebUI draft rendering depends on receiving `text_delta` events during the turn, not only after the final `message_stop`.
- Provider thinking/reasoning records may be forwarded as private status events, but Dashboard does not render raw thinking text in the main transcript.

## Health Endpoint

The optional health endpoint is configured separately with `LAB_MODEL_GATEWAY_HEALTH_URL`.

Rules:

- `ant-code gateway` and `/gateway` validate configuration and local network policy without contacting the health endpoint.
- `ant-code gateway --live`, `/gateway --live`, and `node scripts/verify-gateway-compat.js --live` send a `GET` request to the configured health endpoint.
- The endpoint should return any 2xx status when ready. JSON is recommended for operators, but the MVP client only requires the HTTP status.
- Health checks never carry prompts, tool definitions, tool results, provider keys, or transcript content.

Recommended JSON shape:

```json
{
  "ok": true,
  "service": "lab-model-gateway",
  "protocolVersion": "lab-agent-gateway.v1"
}
```

## OpenAI Chat Compatible Adapter Mode

Some lab adapters expose an OpenAI Chat Completions compatible endpoint instead of the provider-independent request shape above. Configure:

```sh
LAB_MODEL_GATEWAY_PROTOCOL=openai-chat
LAB_MODEL_GATEWAY_URL=http://127.0.0.1:8080/v1/chat/completions
LAB_MODEL_GATEWAY_API_KEY=<adapter-access-token>
```

In this mode the client converts Ant Code messages and local tool definitions into Chat Completions `messages` and `tools`. Returned `tool_calls` are normalized into Ant Code local tool calls, then executed locally through the same permission engine. This mode does not enable remote tools and does not move file, shell, git, or MCP execution into the adapter.

Current compatibility notes:

- The client sends `tools` when local tools are available, but it does not force `tool_choice: "auto"` unless a future caller explicitly provides a tool choice. Some OpenAI-compatible adapters route more reliably when tool choice is omitted.
- Streaming requests include `stream_options: { "include_usage": true }` when `stream=true`; adapters that ignore this field should still return valid SSE/NDJSON deltas.
- OpenAI-compatible `reasoning_content` / provider thinking deltas are treated as hidden thinking/status unless the local TUI explicitly enables thinking visibility. They are not a substitute for visible assistant `content`.
- Before converting restored local history into Chat Completions messages, Ant
  Code repairs incomplete tool-call chains. Assistant messages that declare
  tool calls are kept as tool-call messages only when the corresponding local
  `tool` messages are present; otherwise the dangling tool-call fields are
  removed. This protects resumed long sessions from provider-side HTTP 400
  validation failures caused by older interrupted or partially persisted turns.
- Ant Code image blocks are converted to Chat Completions `image_url` content
  blocks using `data:<mime>;base64,<data>` URLs. Adapters that do not support
  image input should return a clear 4xx error instead of hanging or accepting the
  request silently.

## Compatibility Check

The release gate includes a mock compatibility check:

```sh
npm run verify:gateway
```

For a deployed lab gateway, operators should set both endpoint variables and run the explicit live check:

```sh
LAB_MODEL_GATEWAY_URL=https://gateway.lab.example/v1/chat \
LAB_MODEL_GATEWAY_HEALTH_URL=https://gateway.lab.example/health \
node scripts/verify-gateway-compat.js --live
```

Client-side gateway errors include redacted diagnostic hints. Operators should use these hints to distinguish missing configuration, local network-policy blocks, HTTP route/auth failures, timeout/queue issues, and malformed response bodies. For release evidence, run `node scripts/verify-gateway-compat.js --live --json`.

## Mock Gateway

For local development:

```sh
npm run mock-gateway -- --port 8787
LAB_MODEL_GATEWAY_URL=http://127.0.0.1:8787/v1/chat node src/cli/index.js -p "hello"
LAB_MODEL_GATEWAY_URL=http://127.0.0.1:8787/v1/chat LAB_MODEL_GATEWAY_HEALTH_URL=http://127.0.0.1:8787/health node src/cli/index.js gateway --live
```
