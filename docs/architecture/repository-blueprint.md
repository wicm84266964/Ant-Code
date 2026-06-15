# Clean-room Repository Blueprint

This document gives the proposed directory layout and implementation order for the new clean-room repository.

## Repository Name

Public name:

```text
ant-code
```

Internal implementation codename:

```text
lab-agent
```

The public name should avoid `claude`, `anthropic`, `tengu`, `ccr`, or other upstream-specific product names. The internal codename is retained for protocol, local state, and audit compatibility.

## Initial Tree

```text
lab-agent/
  package.json
  tsconfig.json
  README.md
  LICENSE
  docs/
    architecture/
    provenance/
    security/
    specs/
  src/
    cli/
    core/
    model-gateway/
    context/
    tools/
    permissions/
    mcp/
    memory/
    commands/
    agents/
    ui/
    storage/
    config/
    diagnostics/
  tests/
    unit/
    integration/
    fixtures/
  scripts/
    verify-provenance.ts
    verify-forbidden-endpoints.ts
    doctor.ts
```

## Directory Responsibilities

| Directory | Responsibility |
| --- | --- |
| `src/cli` | argument parsing, entrypoint, mode selection |
| `src/core` | session runtime, turn loop, cancellation |
| `src/model-gateway` | lab gateway client and streaming parser |
| `src/context` | context assembly and compaction |
| `src/tools` | built-in tool definitions and handlers |
| `src/permissions` | policy loading, decision engine, approval state |
| `src/mcp` | local stdio/http MCP client |
| `src/memory` | lab/user/project/session memory |
| `src/commands` | slash command registry and handlers |
| `src/agents` | subagent profiles and runner |
| `src/ui` | terminal UI components |
| `src/storage` | transcript and session persistence |
| `src/config` | config schema and layered config loading |
| `src/diagnostics` | local logs, doctor, endpoint manifest |

## Implementation Order

### Milestone 1: Skeleton

- Create empty repository.
- Add provenance policy.
- Add forbidden endpoint CI check.
- Add config schema.
- Add CLI entrypoint.
- Add local diagnostic logger.

Exit criteria:

- `ant-code --version`
- `ant-code doctor`
- CI checks provenance docs and forbidden endpoints.

### Milestone 2: Model Gateway

- Implement lab gateway client.
- Implement internal message format.
- Implement streaming response parser.
- Implement model alias config.
- Add mock gateway for tests.

Exit criteria:

- `ant-code -p "hello"` works against mock gateway.
- No direct provider API key is needed in client.

### Milestone 3: Read-only Codebase Understanding

- Add `read_file`, `list_files`, `glob`, `grep`.
- Add context builder.
- Add project memory loader.
- Add bounded tool result output.

Exit criteria:

- Agent can answer questions about a local repo.
- Agent cannot read denied files.

### Milestone 4: Edits and Permissions

- Add `write_file` and `edit_file`.
- Add permission prompts.
- Add workspace boundary checks.
- Add diff display.

Exit criteria:

- Agent can make an approved edit.
- Agent refuses writes outside workspace by default.

### Milestone 5: Shell Execution

- Add Bash and PowerShell tools.
- Add command classifier.
- Add env scrubber.
- Add timeout/cancellation.

Exit criteria:

- Readonly command can run.
- Mutating command asks.
- Dangerous command denies or requires elevated approval.

### Milestone 6: MCP and Commands

- Add local stdio MCP.
- Add approved HTTP/SSE MCP.
- Add slash command runtime.
- Add `/status`, `/config`, `/permissions`, `/mcp`.

Exit criteria:

- Local MCP server can expose one test tool.
- MCP tool calls pass through policy.

### Milestone 7: Subagents and Memory

- Add subagent profiles.
- Add read-only subagent.
- Add local memory update commands.
- Add transcript retention policy.

Exit criteria:

- Parent session can spawn read-only analysis subagent.
- Transcript policy is enforced.

## CI Checks

Required checks:

- Typecheck.
- Unit tests.
- Forbidden endpoint scan.
- Provenance record presence.
- Dependency license summary.
- Endpoint manifest generation.

Forbidden endpoint scan should fail on runtime source matches for:

- private provider web apps
- private provider coding-agent endpoints
- provider console OAuth hosts
- `/v1/sessions`
- `/v1/code`
- provider MCP proxy hosts
- unreviewed telemetry SDKs
- unreviewed remote feature-flag SDKs
- private provider endpoint clients

Allow docs and explicit test fixtures only by path allowlist.

## MVP Staffing Suggestion

Minimum effective team:

- 1 spec/provenance owner
- 1 core runtime implementer
- 1 tools/permissions implementer
- 1 gateway/MCP implementer
- 1 reviewer/security owner

Small team mode:

- Keep spec writer and implementer roles separate for high-risk modules.
- If a contributor has read old source, require explicit provenance note.

## Definition of Done

MVP is done when:

- core local coding workflows work
- all model traffic goes through lab gateway
- no direct private provider cloud services are used
- permission system blocks unsafe writes and commands
- local MCP works
- provenance docs exist for all modules
- data-boundary policy is enforced in code and tests
