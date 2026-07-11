# Ant Code Local Installation

This guide is for installing Ant Code from a checkout or packaged tarball on a
local workstation. Tools run locally. Model traffic, when enabled, goes through
the configured model gateway/model adapter layer.

## Requirements

- Node.js 20 or newer.
- npm, bundled with Node.js.
- PowerShell on Windows, or a POSIX shell on Linux/macOS.

Optional local MCP servers may call `npx` or `uvx` when enabled. The default
package works without enabling those MCP servers.

## Install From Tarball

The npm tarball is useful for install validation and source checkout users. It
contains the runtime source files by npm design; the source is AGPL-3.0
licensed and remains available in this repository.

From the directory containing the release tarball:

```powershell
npm install -g .\dist\ant-code-cli-1.0.0.tgz
ant-code --version
ant-code doctor
```

If you do not want a global install, install into a local tools directory:

```powershell
mkdir .ant-code-tooling
npm install --prefix .\.ant-code-tooling .\dist\ant-code-cli-1.0.0.tgz
.\.ant-code-tooling\node_modules\.bin\ant-code.cmd --version
```

After installation, run Ant Code from the project you want to work on:

```powershell
cd <your-project>
ant-code
```

`lab-agent` is also exposed as a compatibility alias, but user-facing
instructions should prefer `ant-code`.

## Install From Windows Executable

For external Windows distribution, build and ship the executable release
directory:

```powershell
npm run build:exe
.\dist\ant-code-windows-x64\ant-code.exe --version
.\dist\ant-code-windows-x64\ant-code.exe doctor
```

Give users the `dist\ant-code-windows-x64\` directory. It contains:

- `ant-code.exe`: bundled Windows executable.
- `ant-code.cmd` and `lab-agent.cmd`: command aliases.
- `configure-gateway.ps1` and `configure-gateway.cmd`: interactive
  gateway/model/token setup scripts.
- `config\`: config templates and bundled skills.
- `docs\`: installation, gateway, quickstart, and security docs.
- `README.md`, `README.zh-CN.md`, `package.json`, and
  `RELEASE-MANIFEST.md`.

It intentionally does not include `src\`, `tests\`, `node_modules\`, local
sessions, logs, or temporary files.

After unpacking the executable directory, most Windows users should configure
their gateway with:

```powershell
.\configure-gateway.ps1
```

The script writes `%USERPROFILE%\.ant-code\lab-agent.config.json`, sets
user-level `LAB_AGENT_CONFIG` and `LAB_MODEL_GATEWAY_API_KEY`, maps main and
subagent model tiers to the same model id, and runs `ant-code doctor`. Its
default `approved-web` network mode enables built-in `web_search` and
allowlisted `web_fetch` for common public research hosts. Use `lab-only` when a
deployment must block public web access.

## Local Checkout

From a fresh source checkout:

```sh
git clone https://github.com/wicm84266964/Ant-Code.git
cd Ant-Code
npm ci
npm run verify:install
npm run verify:release
node src/cli/index.js doctor
node src/cli/index.js tui
node src/cli/index.js -p "/status"
```

If the repository is already checked out, run the commands from the repository
root, starting with `npm ci`.

This repository uses reviewed public open-source runtime dependencies for the
terminal UI layer, local ripgrep-backed search, and TypeScript/JavaScript
semantic analysis. `npm ci` installs the locked dependency graph from
`package-lock.json`, including `@vscode/ripgrep` and `typescript`; no separate
search or TypeScript setup script is required. Packed releases carry the same
graph through `npm-shrinkwrap.json`. Release checks verify the reviewed
allowlist, lockfile integrity, dependency notices, and shrinkwrap parity.

## Linked CLI

For daily local use from any project directory:

```sh
npm link
ant-code --version
ant-code doctor
ant-code tui
ant-code dashboard --no-open
ant-code -p "/status"
ant-code
```

## Dashboard WebUI

`ant-code` continues to start the terminal UI by default. Users who prefer a
browser-based interface can start the local Dashboard:

```powershell
ant-code dashboard
```

The first Dashboard release is local-only. It binds to `127.0.0.1`, uses port
`7410` by default, automatically moves to the next free port when needed, and
opens the browser unless `--no-open` is set:

```powershell
ant-code dashboard --port 7410
ant-code dashboard --no-open
ant-code dashboard --project .
```

Non-loopback hosts such as `0.0.0.0` are rejected; Dashboard is not a LAN sharing
mode. It reuses the same core session runtime, local permission engine, and
`.lab-agent/sessions` store as the TUI, so history created in one interface can
be inspected from the other. The WebUI keeps tool activity folded by default,
shows permission approvals above the input box, and provides a right-side file
preview panel for images, text, Markdown, code, PDF, and first-release
Office/binary file cards.

### Browser Authentication And Permissions

Dashboard accepts only `127.0.0.1`, `localhost`, or `::1`. Startup creates
random process-local session and CSRF credentials. The root-page bootstrap sets
the session credential in an `HttpOnly; SameSite=Strict` cookie and a separate
`SameSite=Strict` CSRF cookie, which the Dashboard echoes in a request header.
API requests must match the exact bound Host and port; Origin and cross-site
fetch context are also checked. Mutations accept JSON only and require CSRF
validation. Content Security Policy blocks framing, with `X-Frame-Options:
DENY` as an additional control.

Do not publish Dashboard through a reverse proxy, expose it to the LAN, or copy
its cookie values into scripts. Restarting Dashboard creates new credentials.

New tasks default to `plan`. Permission state belongs to one Dashboard session
and is not inherited by a new task or session. Moving to `fullAccess` requires
the explicit risk confirmation shown by the interface; use it only on a
controlled workstation and return to a narrower mode when broad access is no
longer needed.

### Input And File Boundaries

Dashboard rejects requests or previews outside these limits:

| Input or service | Limit |
| --- | --- |
| Generic JSON request body | 1 MiB |
| Turn request body | 40 MiB |
| Prompt text | 256 KiB of UTF-8 |
| Image attachments | 6 images; 8 MiB each; 24 MiB total |
| Dashboard Office preview | 10 MiB |
| Raw file response | 20 MiB |

Image uploads accept PNG, JPEG, GIF, and WebP only. The server verifies
canonical base64, decoded size, and the file signature rather than trusting the
declared MIME type.

File access is restricted by canonical `realpath` checks across symlink and
junction boundaries. Remote images in Markdown are not loaded automatically;
they remain text or external links. SVG is download-only and is never embedded
as same-origin active content. Office parsing runs in a bounded worker with at
most 1,000 archive entries, 16 MiB per extracted entry, 64 MiB total extracted
data, a 200:1 compression ratio, and a 3-second timeout.

### Navigation, Reconnection, And Lifecycle

Mobile and tablet layouts expose three mutually exclusive views: Sessions,
Conversation, and Files. Keyboard navigation supports arrow keys plus Home and
End in radio groups; modal dialogs trap focus, close with Escape, and restore
focus to the control that opened them.

The event stream resumes from the last event sequence after a disconnect and
uses bounded exponential retries. Stale and offline states remain visible, and
the connection-status control can start a manual reconnect. Transcript history
uses cursor pages of 100 messages by default and no more than 200 per request;
the browser keeps at most 300 transcript nodes mounted.

Dashboard keeps at most 50 active runtime sessions by default, reclaims eligible
idle state after 30 minutes, and sweeps once per minute. Running, queued, or
otherwise non-reclaimable work is not evicted, and persisted sessions remain
available. Older transcript metadata and chunks remain readable.

Stop the service from the sidebar "关闭 Dashboard" confirmation action or press
`Ctrl+C` in the launching terminal. Before closing, Dashboard reports active
turns, quarantined turns, queued work, background tasks, and pending
interactions. Active work requires an explicit cancel-and-close choice; the
server then waits for bounded cleanup instead of silently abandoning work.

## Configure Model And Gateway

The easiest durable setup is a config JSON plus one optional secret environment
variable. Avoid editing files inside `node_modules`; package upgrades replace
those files.

### Option A: Project Config

Create `lab-agent.config.json` in each project that needs its own gateway:

```json
{
  "modelAlias": "my-coding-model",
  "models": [
    {
      "id": "my-coding-model",
      "label": "My Coding Model",
      "description": "OpenAI-compatible model exposed by my gateway.",
      "thinking": false,
      "reasoningContentMode": "visible-when-no-content",
      "contextTokens": 200000
    }
  ],
  "networkMode": "lab-only",
  "allowedHosts": [
    "gateway.example.com"
  ],
  "lab": {
    "gatewayProtocol": "openai-chat",
    "gatewayUrl": "https://gateway.example.com/v1/chat/completions",
    "gatewayHealthUrl": "https://gateway.example.com/health"
  },
  "agents": {
    "modelTiers": {
      "cheap": "my-coding-model",
      "default": "my-coding-model",
      "strong": "my-coding-model"
    }
  }
}
```

For OpenAI Chat Completions compatible gateways, use
`"gatewayProtocol": "openai-chat"`. For the native Ant Code gateway protocol, use
`"gatewayProtocol": "lab-agent-gateway"`.

Store gateway bearer tokens outside the JSON:

```powershell
[Environment]::SetEnvironmentVariable("LAB_MODEL_GATEWAY_API_KEY", "<gateway-access-token>", "User")
```

Open a new terminal after setting a Windows user environment variable, then run:

```powershell
cd <your-project>
ant-code doctor
ant-code gateway --live
ant-code -p "Reply exactly: ready"
```

`LAB_MODEL_GATEWAY_API_KEY` is a gateway access token. Do not put provider API
keys in Ant Code config files.

### Option B: Shared Config

For a machine-wide or operator-managed config, copy the template from the installed
package or this checkout:

```powershell
mkdir C:\ant-code
copy .\config\lab-agent.lab-template.json C:\ant-code\lab-agent.config.json
[Environment]::SetEnvironmentVariable("LAB_AGENT_CONFIG", "C:\ant-code\lab-agent.config.json", "User")
```

Edit `C:\ant-code\lab-agent.config.json`, changing these fields:

- `modelAlias`: default model used by the main agent.
- `models`: visible model ids, labels, thinking mode, and context window.
- `agents.modelTiers`: model ids used by subagents.
- `lab.gatewayProtocol`: `openai-chat` or `lab-agent-gateway`.
- `lab.gatewayUrl`: chat endpoint.
- `lab.gatewayHealthUrl`: optional health endpoint for `ant-code gateway --live`.
- `allowedHosts`: hostnames Ant Code may contact when network mode is
  `lab-only` or `approved-web`.
- `context.maxTokens` and `context.maxBytes`: prompt budget for long
  conversations.

Open a new terminal after changing `LAB_AGENT_CONFIG`.

### Switching Gateways Later

When you already have Ant Code installed, do not reinstall or edit
`node_modules` just to change providers. Update the active config JSON and open
a new terminal.

For a single-model gateway, set all model references to the same id:

```json
{
  "modelAlias": "new-model",
  "models": [
    {
      "id": "new-model",
      "label": "New Model",
      "thinking": false,
      "reasoningContentMode": "visible-when-no-content",
      "contextTokens": 200000
    }
  ],
  "lab": {
    "gatewayProtocol": "openai-chat",
    "gatewayUrl": "https://new-gateway.example.com/v1/chat/completions",
    "gatewayHealthUrl": "https://new-gateway.example.com/health"
  },
  "allowedHosts": [
    "new-gateway.example.com"
  ],
  "agents": {
    "modelTiers": {
      "cheap": "new-model",
      "default": "new-model",
      "strong": "new-model"
    }
  }
}
```

Then update only the gateway token:

```powershell
[Environment]::SetEnvironmentVariable("LAB_MODEL_GATEWAY_API_KEY", "<new-gateway-access-token>", "User")
```

Open a new terminal and verify:

```powershell
ant-code doctor
ant-code gateway --live
ant-code -p "Reply exactly: ready"
```

Config precedence is:

```text
defaults < packaged lab-agent.config.json < project lab-agent.config.json < LAB_AGENT_CONFIG file < environment variables
```

The environment layer is convenient for temporary tests, but it can also mask a
JSON change. If Ant Code still shows an old model after editing the config, run
these checks in the same terminal:

```powershell
Get-ChildItem Env:LAB_AGENT_MODEL,Env:LAB_AGENT_MODELS,Env:LAB_MODEL_GATEWAY_PROTOCOL,Env:LAB_MODEL_GATEWAY_URL,Env:LAB_MODEL_GATEWAY_HEALTH_URL,Env:LAB_AGENT_CONFIG,Env:LAB_MODEL_GATEWAY_API_KEY -ErrorAction SilentlyContinue
```

Clear temporary process overrides with `Remove-Item Env:<NAME>` or update the
Windows user variable with `[Environment]::SetEnvironmentVariable(...)`. User
environment variable changes require a new terminal.

### One-Off Environment Override

For temporary testing, environment variables override JSON config:

```powershell
$env:LAB_MODEL_GATEWAY_PROTOCOL = "openai-chat"
$env:LAB_MODEL_GATEWAY_URL = "http://127.0.0.1:8080/v1/chat/completions"
$env:LAB_MODEL_GATEWAY_HEALTH_URL = "http://127.0.0.1:8080/health"
$env:LAB_MODEL_GATEWAY_API_KEY = "<gateway-access-token>"
$env:LAB_AGENT_MODEL = "my-coding-model"
$env:LAB_AGENT_MODELS = "my-coding-model"
$env:LAB_AGENT_NETWORK_MODE = "offline"
ant-code -p "hello"
```

This is convenient for quick tests, but config JSON is easier to maintain when
you switch gateways often.

## PowerShell Environment

For a local model adapter or model gateway:

```powershell
$env:LAB_MODEL_GATEWAY_URL = "http://127.0.0.1:8787/v1/chat"
$env:LAB_MODEL_GATEWAY_HEALTH_URL = "http://127.0.0.1:8787/health"
$env:LAB_AGENT_NETWORK_MODE = "offline"
ant-code gateway
ant-code gateway --live
```

For an OpenAI Chat Completions compatible local adapter:

```powershell
$env:LAB_MODEL_GATEWAY_PROTOCOL = "openai-chat"
$env:LAB_MODEL_GATEWAY_URL = "http://localhost:8080/v1/chat/completions"
$env:LAB_MODEL_GATEWAY_API_KEY = "<adapter-access-token>"
$env:LAB_AGENT_MODEL = "example-coding-model"
$env:LAB_AGENT_NETWORK_MODE = "offline"
node src/cli/index.js -p "hello"
node src/cli/index.js tui
```

`LAB_MODEL_GATEWAY_API_KEY` is a local adapter access token. Do not commit it to config files; use a PowerShell session variable, a Windows user environment variable, or another approved secret store.

Optional TUI appearance variables:

```powershell
$env:LAB_AGENT_TUI_THEME = "sky-blue"       # default sky-blue theme
$env:LAB_AGENT_NO_COLOR = "1"               # no-color fallback for low-color terminals
```

For high-sensitivity projects:

```powershell
$env:LAB_AGENT_SENSITIVITY = "high"
$env:LAB_AGENT_NETWORK_MODE = "lab-only"
ant-code doctor
```

## Startup Checks

Before distributing a candidate, run:

```sh
npm run verify:install
npm run verify:release
ant-code doctor
ant-code -p "/map"
ant-code -p "/verify suggest"
```

Expected result:

- Install readiness passes.
- Release verification passes.
- Doctor shows no unexpected errors.
- Slash commands work without model gateway access.
- The configured gateway, model aliases, and network mode match the intended environment.

`npm run verify:release` includes `npm run check`. That gate verifies syntax,
forbidden endpoints, dependency policy and lockfile parity, the type diagnostic
ratchet, unit/integration tests, the real Microsoft Edge Dashboard suite,
committed Dashboard asset consistency, and `git diff --check`. Windows
executable builds run the Dashboard asset check before creating release output.

## Dashboard Rollback

Roll back the executable, Dashboard assets, runtime source, and documentation as
one complete release. Do not mix assets from one release with a server from
another, and do not restore compatibility by disabling session authentication,
CSRF, Host/Origin checks, or workspace file boundaries.

Preserve `.lab-agent/sessions` and any configured local state during rollback;
back them up before replacing an installation. Older transcript metadata and
chunks remain readable, so a rollback should not require deleting session
history.

## Troubleshooting

- If `ant-code` is not found, rerun `npm link` from the repository root or use `node src/cli/index.js`.
- If the TUI is not comfortable in the current terminal, use line-mode `ant-code chat` or print mode with `ant-code -p`.
- If `doctor` says the model gateway is not configured, local slash commands still work; set `LAB_MODEL_GATEWAY_URL` only when model turns are needed.
- If live gateway checks fail in `offline` mode, use a loopback adapter such as `127.0.0.1` or switch to an approved `lab-only` host.
- If metadata retention is too broad for the project, set `LAB_AGENT_SENSITIVITY=high` or use the high-sensitivity config template.
- If command approvals are confusing, use `/status`, `/next`, and `/report` to inspect the current local workflow state before continuing.
