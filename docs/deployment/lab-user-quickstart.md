# Ant Code Lab User Quickstart

This quickstart is for lab members using Ant Code on a local research project. It avoids legacy-source language and focuses on safe daily use.

## First Run

From the project directory:

```sh
node src/cli/index.js doctor
node src/cli/index.js -p "/status"
node src/cli/index.js -p "/map"
node src/cli/index.js
```

After package linking or installation, use:

```sh
ant-code doctor
ant-code -p "/status"
ant-code
```

Expected result:

- `doctor` reports local readiness checks.
- `/status` shows session, repository, delivery, and validation state.
- `/map` shows project type, manifests, key directories, and likely test entrypoints.
- Interactive mode starts with the `ant-code>` prompt.

## Connecting The Lab Gateway

Use the lab-provided configuration or environment variables:

```powershell
$env:LAB_MODEL_GATEWAY_URL = "https://gateway.example.invalid/v1/chat"
$env:LAB_MODEL_GATEWAY_HEALTH_URL = "https://gateway.example.invalid/health"
$env:LAB_AGENT_NETWORK_MODE = "lab-only"
```

Then verify:

```sh
ant-code gateway
ant-code gateway --live
```

The local client should never require provider API keys. Provider credentials belong inside the lab gateway service.

## Dashboard Model And Image Use

Start the WebUI with:

```sh
ant-code dashboard
```

The model selector near the bottom of Dashboard shows the current model and
text/image/thinking labels. It switches models inside the active gateway profile
and, when more than one profile has been saved, can switch the active profile
itself. Use its configuration entry to register same-gateway models, update the
gateway URL or access token, and set subagent defaults. Saving a new gateway URL
or access token snapshots the previous gateway as a profile and activates the
new one; saving another model for the same URL without entering a new key updates
the active profile's model list.

For image or screenshot work:

- Mark only real vision-capable models with `modalities: ["text", "image"]`.
- Set `agents.vision.model` to the same-gateway vision model you want Ant Code
  to use for visual fallback.
- If the current main model is text-only, Ant Code will ask the vision model for
  a visual evidence report before the main model continues.
- If no same-gateway vision model is configured, image turns will be rejected
  with an unsupported-vision message instead of silently continuing.
- Multiple gateway profiles are stored for convenience, but only the active
  profile is used at runtime; Ant Code does not mix providers or keys inside one
  task.

## Dashboard Background Subagents

Dashboard shows background subagent groups in the live-status strip above the
input area. When a model starts an `agent_run` with `background=true` and
`wakeParent=true`, the group remains visible after the parent turn finishes. On
completion, Dashboard consumes the generated wake prompt: if the parent is still
busy the continuation is queued, and if the parent is idle it starts
automatically. The corresponding `.lab-agent/task-groups/<group>.json` record
will contain both `wakePromptQueuedAt` and `wakePromptConsumedAt` when the
WebUI has actually picked up the completion.

## Daily Code Workflow

Useful local commands:

```sh
ant-code -p "/files"
ant-code -p "/diff --stat"
ant-code -p "/verify suggest"
ant-code -p "/next"
ant-code -p "/report"
```

For code changes:

1. Ask Ant Code to inspect before editing.
2. Review write approvals carefully.
3. Use `/edit --dry-run <path> <old text> => <new text>` when you want a local preview.
4. Run `/verify run suggested` after code changes.
5. Use `/report` before handing work to another person.

## Sensitive Research Data

For unpublished papers, private datasets, human-subject-adjacent material, or restricted partner code:

```powershell
$env:LAB_AGENT_SENSITIVITY = "high"
$env:LAB_AGENT_NETWORK_MODE = "lab-only"
```

High sensitivity mode forces zero-retention local metadata and rejects broad network modes. Keep MCP servers disabled unless the project owner approves them.

## Safety Rules

- Do not put provider API keys in the local Ant Code shell.
- Do not approve writes or shell commands you do not understand.
- Do not enable public plugin registries or arbitrary MCP servers for sensitive projects.
- Prefer `/status`, `/next`, and `/report` when deciding whether a task is actually complete.
- Use `/sessions cleanup` when local retention policy allows metadata cleanup.

## Rollback

To disable model turns quickly:

```powershell
Remove-Item Env:\LAB_MODEL_GATEWAY_URL -ErrorAction SilentlyContinue
Remove-Item Env:\LAB_MODEL_GATEWAY_HEALTH_URL -ErrorAction SilentlyContinue
$env:LAB_AGENT_NETWORK_MODE = "offline"
```

Ant Code can still run local slash commands such as `/status`, `/map`, `/sessions cleanup`, and `/doctor` without gateway access.
