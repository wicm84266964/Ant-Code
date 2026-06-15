# Ant Code

中文说明见 [README.zh-CN.md](README.zh-CN.md).

Ant Code is a local coding agent runtime with a terminal UI, local Dashboard,
tool permissions, skills, MCP integration, subagents, session storage, and model
gateway adapters.

Tools run on the user's machine. Model requests are sent only to the gateway
configured by the user. Secrets such as gateway access tokens belong in
environment variables or local user config, not in this repository.

This repository is released under the GNU Affero General Public License v3.0.

## Status

This is a cleaned open-source source release. It intentionally excludes local
runtime state, logs, transcripts, build outputs, private gateway configs,
machine-specific backups, and handoff notes.

The public project name is **Ant Code**. The internal compatibility codename
`lab-agent` remains in config file names, protocol identifiers, and local state
paths to avoid breaking existing installs.

## Features

- terminal coding agent with interactive TUI
- local Dashboard/WebUI bound to `127.0.0.1`
- print mode for one-shot prompts
- local permission engine for file, shell, network, MCP, and workflow tools
- configurable model gateway support
- OpenAI Chat Completions-compatible gateway mode
- native `lab-agent-gateway` protocol mode
- local skills loaded from `config/skills`
- local MCP server configuration
- subagents, background tasks, planner packages, and wakeup flows
- session persistence, transcript chunks, and model-context resume
- dashboard rendering for Markdown, code, images, PDF, files, Mermaid, and KaTeX

## Repository Layout

```text
ant-code/
  src/                         # runtime source
  tests/                       # unit and integration tests
  scripts/                     # verification, build, audit, and mock gateway helpers
  config/                      # sanitized config templates and bundled skills
  docs/                        # architecture, deployment, security, specs, provenance
  lab-agent.config.json         # sanitized default sample config
```

Not included:

- `.lab-agent/` local sessions, memory, plans, tasks, worktrees, and transcripts
- `logs/`, `.tmp/`, `dist/`, `node_modules/`
- private gateway configs or provider credentials
- generated model outputs or user project data

## Requirements

- Node.js 20+
- npm
- PowerShell on Windows, or a POSIX shell on Linux/macOS
- a user-controlled model gateway for real model calls

The tests and mock gateway can run without a real model provider.

## Install From Source

```sh
npm ci
npm run verify:install
node src/cli/index.js doctor
node src/cli/index.js tui
```

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

Keep the gateway access token outside JSON:

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

## Dashboard

Start the local Dashboard:

```powershell
ant-code dashboard
```

The Dashboard binds to `127.0.0.1`, defaults to port `7410`, and rejects
non-loopback hosts. It reuses the same local runtime, permission engine, and
`.lab-agent/sessions` store as the TUI.

Common options:

```powershell
ant-code dashboard --port 7410
ant-code dashboard --no-open
ant-code dashboard --project .
```

## Agent Setup Prompt

Give this prompt to an AI coding agent so it can understand and work with this
repository without making you explain every subsystem by hand:

```text
Please adopt this repository as the Ant Code local coding-agent runtime.

Repository: https://github.com/wicm84266964/ant-code

Read README.md, README.zh-CN.md if useful, docs/branding/public-identity.md,
docs/security/data-boundary.md, docs/deployment/local-installation.md, and
AGENT.md. Treat src/ as the runtime source, tests/ as the executable contract,
config/ as sanitized templates and bundled skills, and docs/ as architecture,
deployment, security, and provenance context.

When helping me work on this project:
- Do not write secrets, gateway tokens, local sessions, transcripts, logs,
  build outputs, node_modules, or machine-specific configs into the repository.
- Keep the public name Ant Code, while preserving lab-agent compatibility names
  in protocol, config, and local state paths unless a migration is explicit.
- Use npm ci for dependency setup and npm test or focused node --test commands
  for verification.
- Prefer the mock gateway for tests and demos that do not need a real model.
- Before release work, run syntax, dependency, provenance, install, and relevant
  unit tests.
- Treat model provider credentials as outside the client boundary.
```

## Useful Commands

```sh
npm run doctor
npm run check:syntax
npm run check:dependencies
npm run check:provenance
npm test
npm run mock-gateway -- --port 8787
node src/cli/index.js --version
node src/cli/index.js -p "/status"
```

## Security Boundary

Ant Code is a local client. File edits, shell commands, MCP tools, network
access, and workflow actions are mediated by the local permission system.
Provider credentials should live in the configured gateway/model adapter or in
local environment variables. Do not commit `.env`, gateway tokens, session
stores, transcripts, or private project data.

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE).
