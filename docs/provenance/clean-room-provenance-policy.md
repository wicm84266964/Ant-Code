# Clean-room Provenance Policy

本文档定义 Ant Code 主仓库的来源边界、协作方式和审计要求。

## Goal

本仓库的目标是维护一个本地优先的代码智能体。它可以兼容公开协议和公开产品行为，但不能继承任何非公开源码、实现结构、注释、类型命名或私有云端协议细节。

## Current Repository Status

当前公开仓库应被视为独立源码仓库。

理由：

- 新增实现必须来自公开资料、项目自有需求、标准协议、公开依赖或本仓库已有代码。
- 不得复制、反编译或重建非公开实现细节。
- 发布分支应保留可审计提交历史。
- 发布分支必须保留根级许可证和依赖许可证据。

## Allowed Inputs

新仓库可以参考以下来源：

| Source type | Allowed use |
| --- | --- |
| Official public documentation | Feature behavior, public API shapes, public configuration semantics |
| Public SDKs and packages | Normal dependency usage according to their licenses |
| Public standards | JSON-RPC, MCP, POSIX shell behavior, PowerShell behavior, Git behavior |
| Project specifications | Requirements, security policy, deployment policy, UX expectations |
| Black-box behavior observations | User-visible behavior descriptions, without copying implementation |
| Public issue discussions and examples | High-level behavior and edge cases, with citation |

Recommended public reference set:

- Model Context Protocol: `https://modelcontextprotocol.io/`
- OpenAI Chat Completions compatible API documentation from the gateway/provider in use
- Public terminal UI, Git, shell, JSON-RPC, SSE, and HTTP documentation

## Prohibited Inputs

The new repository must not use:

- Code copied from non-public sources.
- Decompiled or reconstructed implementation details.
- Private file layouts as an implementation template.
- Private endpoint schemas not documented publicly.
- Private UI component structure or state machine structure.
- Private test snapshots, fixtures, or golden transcripts.
- Private comments, docstrings, and internal bug references.
- Private feature flag, telemetry, or cloud-service concepts as implementation concepts.

## Team Roles

Use two roles whenever staffing allows.

| Role | Responsibility | Non-public source access |
| --- | --- | --- |
| Spec writer | Convert needs into public-doc-based behavior specs and migration tests | Should avoid it; must not copy code |
| Implementer | Write new code from specs and public docs | Must not inspect non-public source for the task |
| Reviewer | Check provenance, security boundary, and behavior | May inspect relevant evidence, but must flag contamination risk |

If staffing does not allow strict separation, each contributor must record any non-public-source exposure in the module provenance note.

## Module Provenance Requirement

Each new module must include a nearby provenance record before it is merged.

Minimum fields:

```yaml
module: src/tools/read-file
owner: lab-tooling
implementation_status: clean-room
implementer_non_public_source_exposure: none | limited | known
references:
  - public_doc: https://...
  - standard: POSIX shell / JSON-RPC / MCP
design_notes:
  - Short summary of independent design choices.
prohibited_sources_checked:
  - non-public source code was not copied
  - decompiled/generated private source material was not used
```

For a small module, this can live in `docs/provenance/modules/<module>.md`. For larger subsystems, keep one record per subsystem and link to design docs.

## Naming Rules

Use project-owned names, not upstream product names, except when referring to public protocol names or user-configured model IDs.

Avoid:

- private provider product codenames
- `Tengu*`
- `CCR*`
- `Grove*`
- unreviewed telemetry SDK names
- unreviewed remote feature-flag SDK names
- private provider domains

Prefer:

- `LabAgent`
- `SessionRuntime`
- `ToolRuntime`
- `PolicyEngine`
- `LabModelGateway`
- `LabPluginRegistry`
- `LocalMemory`

## New Repository Baseline

Recommended initial tree:

```text
docs/
  provenance/
  specs/
  security/
src/
  core/
  model-gateway/
  tools/
  permissions/
  mcp/
  memory/
  commands/
  agents/
  ui/
  storage/
  config/
```

Do not mirror private or non-public source trees as implementation templates.

## Review Gate

Before a module is merged, reviewers must answer:

- Is the behavior described by a public document, public standard, or project-owned requirement?
- Is the implementation structurally independent from non-public implementations?
- Does the module avoid private endpoints and feature flags?
- Does the module keep research data inside the approved data boundary?
- Does the module have tests written from behavior requirements, not old fixtures?

## Immediate Actions

- Keep non-public source material out of onboarding and implementation tasks.
- Keep onboarding focused on this repository, public docs, and reviewed dependencies.
- Start public release branches from reviewed repository state.
- Create `docs/provenance/modules/` in the new repository.
- Require provenance notes in pull requests.
- Treat non-public references as audit evidence only, not source material.
