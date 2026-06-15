---
module: src/model-gateway
owner: lab-tooling
implementation_status: clean-room
implementer_old_source_exposure: limited-audit-context
references:
  - lab_spec: docs/specs/mvp-product-spec.md
  - lab_protocol: docs/specs/lab-model-gateway-protocol.md
  - lab_security: docs/security/data-boundary.md
  - standard: HTTP JSON requests through Fetch
design_notes:
  - Sends model traffic only to the configured lab gateway URL.
  - Stores no provider API keys and delegates provider routing to the gateway.
  - Normalizes lab gateway JSON and streaming responses into provider-independent text/tool-call output.
  - Sends non-sensitive request capability/count metadata for gateway compatibility diagnostics.
  - Sends non-sensitive boundary metadata declaring local client tool execution, gateway-only provider credentials, and no MVP remote tools.
  - Normalizes gateway failure shapes into bounded, redacted client errors with operator-facing troubleshooting hints.
  - Provides explicit gateway health diagnostics and next-step hints using only the lab-configured health endpoint.
  - Uses Ant Code public labels in user-facing gateway health output while keeping the lab-agent gateway protocol marker stable.
  - Provides a local mock gateway for protocol tests and development.
  - Supports provider-independent tool-call requests and bounded tool-result handoff.
  - Supports an OpenAI Chat Completions compatible adapter mode behind an explicit protocol selector for lab-owned local gateways.
  - Repairs restored local history before OpenAI Chat Completions conversion so assistant tool-call records are forwarded only when their matching local tool results are present.
  - The OpenAI-compatible streaming parser emits incremental text, provider-exposed thinking/reasoning, tool-call draft, stream start, and stream stop events while preserving the final normalized response shape.
  - Maps Ant Code image content blocks to OpenAI Chat Completions `image_url` data URL blocks when the active same-gateway model turn includes image attachments.
  - Declares image request presence through non-sensitive `metadata.capabilities.images` in the provider-independent lab gateway protocol.
  - Normalizes common image/vision unsupported gateway failures into bounded diagnostics without probing provider model-list endpoints or storing provider credentials locally.
  - The lab-owned gateway streaming parser can also emit normalized stream callbacks so session code can produce AntEvent schema v2 output consistently across protocols.
  - Local model aliases are represented as clean-room gateway configuration data; the default lab adapter options are the three locally provided Ant Code aliases, and no provider account/model-list endpoint is called.
  - Treats `LAB_MODEL_GATEWAY_API_KEY` as an adapter access token only; provider API keys remain outside the local client boundary.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Model Gateway Provenance

The gateway adapter is provider-independent and implements the lab-owned traffic boundary.
