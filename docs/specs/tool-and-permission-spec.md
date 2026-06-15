# Tool and Permission Spec

This document defines the MVP tool protocol and permission behavior.

## Tool Protocol Principles

- Tools are typed.
- Tool input is schema-validated before execution.
- Every tool declares risk level.
- Every risky tool call passes through the permission engine.
- Tool results are bounded in size.
- Tool results are redacted before model submission when policy requires it.
- Tool handlers do not own session state.

## Tool Definition

```ts
type ToolDefinition = {
  name: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  risk: ToolRisk
  supportsAbort: boolean
}

type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'mcp'
```

## Tool Call Lifecycle

1. Model emits a tool call.
2. Runtime validates tool name.
3. Runtime validates input schema.
4. Runtime asks permission engine for a decision.
5. If allowed, runtime executes the tool.
6. If ask, UI prompts the user and records session-scoped approval if granted.
7. If denied, runtime returns a structured denial result.
8. Runtime normalizes and redacts result.
9. Runtime appends tool result to conversation.

## Built-in Tools

| Tool | Risk | MVP behavior |
| --- | --- | --- |
| `read_file` | read | read bounded text file region |
| `write_file` | write | create or replace file with approval |
| `edit_file` | write | exact text replacement in an existing file with approval, preflight validation, byte summaries, and optional dry-run diff preview |
| `list_files` | read | list directory entries inside workspace |
| `glob` | read | match paths with project ignore rules |
| `grep` | read | search text with bounded output |
| `git_status` | read | run bounded `git status --short --branch` without shell interpolation |
| `git_diff` | read | run bounded `git diff` or `git diff --stat` without shell interpolation |
| `bash` | execute | run shell command through policy |
| `powershell` | execute | run PowerShell command through policy |
| `todo_read` | read | read session todo state |
| `todo_write` | write | update session todo state |
| `plan_update` | write | update visible plan state |
| `ask_user` | read | ask user for clarification |
| `mcp_call` | mcp | call an approved MCP tool |

Workflow tools are session-local. They are not workspace file edits, do not require workspace write approval, and their raw text is not written into bounded session metadata. `ask_user` requires an interactive callback; print mode returns a structured unavailable result.

The tool runtime records successful `write_file` and `edit_file` executions into session-local change history, and records shell executions into session-local validation history. These records are used by `/review`, `/verify`, and `/report`; bounded metadata stores only summary counts.

Failed validation records may keep a bounded redacted stdout/stderr excerpt in process memory. The session runtime can inject those excerpts into the next model turn as synthetic local workflow context so the assistant can repair failed checks. This context omits raw command text, redacts path-like and secret-like values, and is not persisted in session metadata.

## Local Slash Tool Shortcuts

Interactive and print-mode slash commands may expose local shortcuts for common tool workflows:

- `/files [path]` calls `list_files`.
- `/map` summarizes local repository shape from manifests and top-level directories.
- `/run <command>` calls `powershell` on Windows and `bash` elsewhere unless a shell flag is supplied.
- `/edit <path> <old text> => <new text>` calls `edit_file`.
- `/edit --dry-run <path> <old text> => <new text>` calls `edit_file` in preview mode and returns a bounded diff without writing.
- `/diff [--stat] [path ...]` runs `git diff` without shell interpolation after a readonly permission decision.
- `/review [summary|stat|files|patch]` summarizes recorded changes, validation state, and git diff information.
- `/verify suggest` suggests likely local validation commands from package scripts and common project manifests.
- `/verify run <command>` runs a command through the shell permission engine and records the result as validation history.
- `/verify run suggested` resolves to the first local validation suggestion and still runs through the shell permission engine.
- `/next` formats derived delivery state, next actions, and validation suggestions without contacting the model gateway.
- `/status` includes derived delivery state when workflow state is attached to the active session and defaults to human-readable sectioned text.
- `/status --json` returns the machine-readable status object for automation.
- `/report` formats a local delivery report for the active session, including delivery state and next action hints.
- `/todo` and `/plan` inspect or update session-local workflow state.

These commands must not bypass the same workspace boundary, command classification, approval callback, and bounded-output rules used by model-triggered tool calls.

## Filesystem Rules

Default:

- read inside workspace: allow
- read outside workspace: ask
- write inside workspace: ask
- write outside workspace: deny unless lab policy allows
- read known secret files: deny
- write config/policy files: ask with elevated warning

Workspace boundary:

- resolve paths before policy check
- reject path traversal
- reject symlink escape unless explicitly approved
- MVP file tools reject symlink paths unless a future policy explicitly approves them
- never follow device files that can block indefinitely

Secret files denylist examples:

- `.env`
- `.env.*`
- private keys
- token caches
- cloud credential files
- SSH config and keys
- browser cookie stores

## Shell Rules

Default:

- readonly commands can be allowlisted.
- mutating commands ask.
- non-interactive mutating commands require explicit session approval.
- destructive recursive commands require exact-path approval.
- network commands require network policy approval.
- commands outside workspace require extra approval.

Readonly command examples:

- `git status`
- `git diff`
- `git log`
- `rg`
- `ls`
- `Get-ChildItem`
- `npm test` may be project-specific, not globally readonly.

Model-triggered `git_status` and `git_diff` are preferred over generic shell calls for repository inspection because they pass argument arrays directly to `git`, reject workspace-escaping pathspecs, and return bounded stdout/stderr.

High-risk command patterns:

- recursive delete
- force reset
- credential dumping
- package publish
- network exfiltration
- shell scripts downloaded from the internet
- background daemons
- permission changes across broad paths

## Permission Decision Model

```ts
type PermissionRequest = {
  toolName: string
  risk: ToolRisk
  cwd: string
  targetPaths: string[]
  command?: string
  networkHosts?: string[]
  summary: string
}
```

```ts
type PermissionDecision =
  | { decision: 'allow'; reason: string; scope: 'once' | 'session' | 'policy' }
  | { decision: 'ask'; reason: string; choices: ApprovalChoice[] }
  | { decision: 'deny'; reason: string; policyId?: string }
```

Approval choices:

- allow once
- allow for this session
- deny

Persisted approvals are not in MVP unless lab policy explicitly enables them.

## Non-interactive Write Approval

In print mode, write tools do not prompt interactively. They are blocked unless the session was started with explicit write approval.

MVP CLI flag:

```sh
ant-code --allow-write -p "approved edit request"
```

Rules:

- `--readonly` always wins over `--allow-write`.
- Approval applies only to workspace-internal file writes.
- Writes outside the workspace remain denied.
- Tool results must include a bounded diff.
- `edit_file` uses exact `oldText` to `newText` replacement and defaults to one expected replacement.
- `edit_file` rejects empty `oldText`, identical old/new text, invalid `expectedReplacements`, zero matches, and unexpected multiple matches before writing.
- `edit_file` returns stable preflight error codes, replacement counts, byte counts, and bounded diffs so repair loops can adjust the edit safely.
- `edit_file` with `dryRun: true` performs the same preflight and returns `wouldEdit: true` with a diff preview without modifying the file.

## Non-interactive Command Approval

In print mode, shell tools use command classification before execution.

MVP CLI flag:

```sh
ant-code --allow-command -p "approved shell request"
```

Rules:

- readonly commands can run without `--allow-command`.
- mutating commands require `--allow-command`.
- `--readonly` denies mutating shell commands even when `--allow-command` is present.
- high-risk patterns are denied.
- network-capable shell commands are denied in `offline` mode and otherwise require future network-specific approval.
- child process environments are scrubbed before execution.
- stdout and stderr are bounded.

## Network Guard

Every network-capable component must register its intended hosts:

- model gateway
- lab config service
- lab plugin registry
- lab MCP servers
- approved web hosts

Network calls to undeclared hosts fail closed.

## MCP Permission Rules

MCP tool calls are treated like built-in tools:

- MCP server must be approved.
- Tool risk must be classified.
- Arguments must be recorded for approval prompt.
- Environment passed to server must be scrubbed.
- Server output is bounded and redacted.
- MVP supports explicit local stdio MCP servers only.
- Project config uses `mcp.servers[].toolRisks` to classify tools.

Unknown MCP tool risk defaults to `ask`.

Example project config:

```json
{
  "mcp": {
    "servers": [
      {
        "name": "local-echo",
        "transport": "stdio",
        "command": "node",
        "args": ["tools/local-echo-server.js"],
        "toolRisks": {
          "echo": "read"
        }
      }
    ]
  }
}
```

## Audit Events

Record local audit events for:

- denied tool call
- approved tool call
- file write
- shell command
- MCP call
- network denial
- policy load failure

Audit events must not include raw secrets.
