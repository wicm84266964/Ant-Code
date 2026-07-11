# Ant Code

中文说明见 [README.zh-CN.md](README.zh-CN.md).

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20709743.svg)](https://doi.org/10.5281/zenodo.20709743)

Ant Code is a local-first coding agent for repository-scale software work. It
combines an interactive terminal UI, a loopback Dashboard, local tool
permissions, skills, MCP integration, resumable sessions, and model gateway
adapters into one runtime.

The core idea is simple: tools run on the user's machine, while model traffic
goes only through the gateway configured by the user. File edits, shell
commands, MCP calls, task state, approvals, transcripts, and validation history
stay under local control.

This repository is released under the GNU Affero General Public License v3.0.

## What Makes Ant Code Different

- Local-first execution: file, shell, git, network, MCP, and workflow tools are
  mediated by a local permission engine.
- Subagent orchestration: Ant Code can delegate bounded work to explorer,
  planner, verifier, reviewer, visual-verifier, browser-verifier, junior, and
  code-worker style subagents.
- Background task flow: long-running subagent work can be tracked through task
  records, groups, budgets, wakeups, and parent-session summaries.
- Planner packages: planning agents can persist structured implementation
  plans that later commands and reviewers can inspect.
- Validation-aware workflow: sessions keep local todo state, plans, validation
  results, delivery status, and next-action hints.
- Tiered verification memory: `/verify suggest` groups local checks into
  `minimal`, `related`, and `full` tiers, while `/verify`, `/next`, and
  `/report` show session-local pending, passed, failed, and stale validation
  state.
- Gateway-independent model layer: use the native `lab-agent-gateway` protocol
  or an OpenAI Chat Completions-compatible adapter.
- Text and vision routing: configure separate model aliases for coding and
  image-aware workflows when your gateway supports them.
- Dashboard and TUI over the same runtime: terminal users and browser users see
  the same sessions, permissions, tasks, and local state.
- Skills and MCP extension points: bundled skills and configured MCP servers can
  extend the agent without putting provider credentials in the client.
- High-sensitivity mode: transcript retention, network mode, and metadata
  behavior can be tightened for private repositories or research data.

## Core Capabilities

- Interactive terminal coding agent (`ant-code`)
- One-shot print mode for scripted prompts
- Local Dashboard/WebUI bound to `127.0.0.1`
- File read/write, exact replacement edits, diff previews, and structured git
  read/write tools
- Local ripgrep-backed search tools for regex, glob, context, file listing,
  matching-file discovery, and counts
- Local TypeScript/JavaScript semantic tools for symbols, diagnostics,
  definitions, and references
- Local shell execution with approval boundaries
- Configurable model gateway and health checks
- OpenAI Chat Completions-compatible gateway mode
- Native provider-independent gateway protocol mode
- Local skills loaded from `config/skills`
- Local MCP server configuration
- Session persistence, transcript chunks, model-context resume, and compaction
- Rich Dashboard rendering for Markdown, code, images, PDF, files, Mermaid, and
  KaTeX

## Repository Layout

```text
ant-code/
  src/                         # runtime source
  tests/                       # unit and integration tests
  scripts/                     # verification, build, audit, and mock gateway helpers
  config/                      # configuration templates and bundled skills
  docs/                        # installation, gateway, quickstart, and security docs
  lab-agent.config.json         # default sample config
```

## Requirements

- Node.js 20+
- npm
- PowerShell on Windows, or a POSIX shell on Linux/macOS
- a user-controlled model gateway for real model calls

The tests and mock gateway can run without a real model provider.

## Install From Source

```sh
git clone https://github.com/wicm84266964/Ant-Code.git
cd Ant-Code
npm ci
npm run verify:install
node src/cli/index.js doctor
node src/cli/index.js tui
```

`npm ci` installs the locked local toolchain, including the bundled ripgrep
binary resolver (`@vscode/ripgrep`) and the TypeScript language service. No
separate search or TypeScript setup script is required.

For local development from any project directory:

```sh
npm link
ant-code --version
ant-code doctor
ant-code
```

The package keeps `"private": true` to prevent accidental npm registry
publication. The source repository itself is open under AGPL-3.0.

## Configure A Model Gateway

Create or copy a local config:

```powershell
copy .\config\lab-agent.lab-template.json .\lab-agent.config.json
```

Edit the copied file and set:

- `modelAlias`
- `models`
- `lab.gatewayProtocol`
- `lab.gatewayUrl`
- `lab.gatewayHealthUrl`
- `allowedHosts`
- `agents.modelTiers`

Keep gateway access tokens outside JSON:

```powershell
[Environment]::SetEnvironmentVariable("LAB_MODEL_GATEWAY_API_KEY", "<gateway-access-token>", "User")
```

Open a new terminal, then verify:

```powershell
ant-code doctor
ant-code gateway --live
ant-code -p "Reply exactly: ready"
```

For temporary local testing, use the built-in mock gateway:

```powershell
npm run mock-gateway -- --port 8787
$env:LAB_MODEL_GATEWAY_URL = "http://127.0.0.1:8787/v1/chat"
$env:LAB_MODEL_GATEWAY_PROTOCOL = "openai-chat"
node .\src\cli\index.js -p "hello"
```

## Run Ant Code

Interactive terminal session:

```sh
ant-code
```

One-shot prompt:

```sh
ant-code -p "Summarize this repository and suggest the next validation step."
```

Local Dashboard:

```powershell
ant-code dashboard
```

The Dashboard binds to `127.0.0.1`, defaults to port `7410`, and rejects
non-loopback hosts. It reuses the same local runtime, permission engine, task
store, and `.lab-agent/sessions` session store as the TUI.

Each Dashboard process creates fresh session and CSRF credentials. API requests
must use the exact bound host and port, and state-changing requests also require
same-origin JSON plus CSRF validation. The Dashboard is a local workstation
interface, not a LAN or public sharing service.

New Dashboard tasks start in `plan` mode. Permission changes apply only to the
current session, and selecting `fullAccess` requires an explicit risk
confirmation. On smaller screens, use the Sessions, Conversation, and Files
views; connection status reports stale or offline event streams and supports a
manual reconnect without discarding the persisted session.

Common Dashboard options:

```powershell
ant-code dashboard --port 7410
ant-code dashboard --no-open
ant-code dashboard --project .
```

## Useful Commands

```sh
npm run doctor
npm run check
npm run check:syntax
npm run check:dependencies
npm test
npm run mock-gateway -- --port 8787
node src/cli/index.js --version
node src/cli/index.js -p "/status"
```

`npm run check` is the release gate for syntax, forbidden endpoints, dependency
and lockfile policy, types, unit/integration tests, real Microsoft Edge browser
coverage, committed Dashboard assets, and whitespace errors.

## Security Boundary

Ant Code is a local client. File edits, shell commands, MCP tools, network
access, and workflow actions are mediated by the local permission system.
Provider credentials should live in the configured gateway/model adapter or in
local environment variables. Do not commit `.env`, gateway tokens, session
stores, transcripts, or private project data.

Git tools run through local `git` argument arrays rather than arbitrary shell
strings. Read tools expose status, diff, log, show, branch, stash, and tag
metadata; write tools such as add, commit, branch, stash, and tag still use the
normal local approval flow and reject broad staging such as `git_add` with `.`.

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE).

DOI: [10.5281/zenodo.20709743](https://doi.org/10.5281/zenodo.20709743).

Bundled third-party runtime and Dashboard assets are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
