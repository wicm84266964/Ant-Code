# Lab Gateway Rollout Checklist

This checklist is for connecting Ant Code to a real lab-owned model gateway. It is intentionally operational: each step should leave behind evidence that can be reviewed before broad lab rollout.

## Scope

Goal: validate that the local clean-room client can use the deployed lab gateway without direct provider credentials, unmanaged telemetry, or accidental research-data exfiltration.

Out of scope for the local client:

- Provider account management.
- Provider API keys.
- Provider-specific routing.
- Gateway-side billing, quota, and retention implementation.

The gateway team owns those items behind the lab boundary.

## Phase 0: Freeze The Client Candidate

- Choose a local Git commit for rollout testing.
- Run `npm run verify:release` from a clean working tree.
- Save the generated `docs/audit/` artifacts with the rollout notes.
- Confirm the endpoint manifest declares only `LAB_MODEL_GATEWAY_URL`, `LAB_MODEL_GATEWAY_HEALTH_URL`, `LAB_MODEL_GATEWAY_PROTOCOL`, optional gateway adapter auth, approved hosts, loopback test endpoints, and development fixtures.
- Confirm no direct provider key is required by the local client.
- Decide whether the smoke check covers TUI only or both TUI and `ant-code dashboard`. Dashboard rollout candidates must keep the server loopback-only and preserve the same local permission/session boundary as TUI.

Evidence to retain:

- Commit hash.
- `npm run verify:release` output summary.
- Generated endpoint manifest.
- Generated MVP release audit report.
- Completed release candidate package from `docs/deployment/release-candidate-package.md`.

## Phase 1: Configure A Non-Sensitive Test Workspace

- Use a scratch workspace with no unpublished datasets, no credentials, and no restricted human-subject material.
- Set `LAB_AGENT_NETWORK_MODE=lab-only`.
- Set `LAB_MODEL_GATEWAY_PROTOCOL` to `lab-agent-gateway` or `openai-chat`.
- Set `LAB_MODEL_GATEWAY_URL` to the deployed lab gateway chat endpoint.
- Set `LAB_MODEL_GATEWAY_HEALTH_URL` to the deployed lab gateway health endpoint.
- Set `LAB_MODEL_GATEWAY_API_KEY` only if the adapter requires gateway-level bearer auth; never use a provider key here.
- Set `LAB_AGENT_MODEL` to the gateway model alias approved for testing.
- Keep `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, OAuth tokens, cloud credentials, and provider console tokens out of the client environment.

Evidence to retain:

- Redacted shell environment summary.
- `node src/cli/index.js doctor` output.
- `node src/cli/index.js gateway` output.

## Phase 2: Validate Health And Compatibility

Run the dry diagnostic first:

```sh
node src/cli/index.js gateway
```

Then run the live health diagnostic:

```sh
node src/cli/index.js gateway --live
```

Finally run the compatibility check:

```sh
node scripts/verify-gateway-compat.js --live
```

Required result:

- Health endpoint returns a 2xx status.
- A basic non-streaming chat request returns normalized text.
- No provider credential is read by the local client.
- Network policy allows only the configured lab gateway host.
- If a session id is present, `x-session-affinity` is accepted as a routing/cache hint and is not treated as authentication.

Evidence to retain:

- Command outputs.
- Gateway request IDs if the gateway exposes them.
- Gateway-side audit event IDs if available.

## Phase 3: Validate Tool-Call Round Trips

Use only a scratch workspace.

Read-only flow:

```sh
node src/cli/index.js -p "please read_file README.md"
```

Write-block flow:

```sh
node src/cli/index.js -p "please write_file scratch.txt hello"
```

Approved write flow:

```sh
node src/cli/index.js --allow-write -p "please write_file scratch.txt hello"
```

Required result:

- Read tools are executed locally and returned to the gateway as bounded tool results.
- Writes are blocked unless the local session has explicit approval.
- Tool outputs are bounded and do not include local secret files.
- Gateway never executes local filesystem or shell tools itself.

Evidence to retain:

- Client command outputs.
- Gateway-side request trace for the tool-call request and tool-result follow-up.
- Confirmation that no raw credential file content was sent.

## Phase 4: Validate Streaming

If the gateway supports streaming, validate both accepted formats before enabling streaming by default:

- `text/event-stream`
- `application/x-ndjson`

Required result:

- Text deltas combine into the same normalized assistant text shape as non-streaming responses.
- Complete SSE events or NDJSON lines are dispatched as they arrive, before the full response closes.
- Unsupported stream event types are ignored safely.
- Stream parse errors become bounded gateway errors.
- Dashboard live draft cards show visible assistant text before final completion when streaming is enabled.

Evidence to retain:

- Gateway stream fixture or request ID.
- Client output.
- Any parse-error logs with sensitive content removed.
- For Dashboard pilots, a short screen recording, screenshot series, or test log that proves incremental visible deltas appeared during a running turn.

## Phase 5: Pilot With Low-Sensitivity Internal Code

- Use an internal-code-only project with no restricted datasets.
- Keep transcript retention at the default 30 days or lower.
- Confirm the lab gateway retention policy is acceptable for the project data class.
- Confirm gateway-side redaction and audit policy with the data owner.
- Run a small group pilot before opening access to the full lab.

Exit criteria:

- No direct provider traffic from the local client.
- No uncontrolled transcript uploads.
- Gateway quota and audit records are visible to lab operators.
- Tool approvals behave predictably for read, write, and shell requests.

## Rollback

Rollback is local-first:

- Remove or unset `LAB_MODEL_GATEWAY_URL`.
- Remove or unset `LAB_MODEL_GATEWAY_HEALTH_URL`.
- Set `LAB_AGENT_NETWORK_MODE=offline`.
- Remove lab config paths from `LAB_AGENT_CONFIG`.
- Keep generated transcripts local for review, or run `/sessions cleanup` if retention policy allows deletion.

The client should then continue to run local diagnostics, slash commands, memory, and session cleanup without model turns.

## Release Decision

Approve broad rollout only when all are true:

- `npm run verify:release` passes on the client candidate.
- `node scripts/verify-gateway-compat.js --live` passes against the deployed gateway.
- The compatibility matrix has no unresolved required rows.
- The security config template has been adapted into a lab-owned deployment config.
- Gateway operators have documented model allowlist, quota, retention, and incident rollback procedures.
