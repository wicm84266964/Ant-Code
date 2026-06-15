# Public Identity

The public project name is **Ant Code**.

The implementation keeps the internal codename **lab-agent** for stability. Internal names appear in package history, protocol identifiers, local metadata paths, config templates, and audit artifacts where changing them would create avoidable migration risk.

## Public Surface

Use these names in user-facing rollout material:

- Product name: Ant Code
- Primary CLI command: `ant-code`
- Package name: `@ant-code/cli`
- User-facing diagnostics and rollout documents should say Ant Code unless they are naming an internal compatibility anchor.

The package also exposes `lab-agent` as a backward-compatible CLI alias for internal scripts and existing tests.

## Internal Surface Kept Stable

These names remain intentionally unchanged:

- Protocol version: `lab-agent-gateway.v1`
- MCP protocol marker: `lab-agent-mcp.v1`
- Local project directory: `.lab-agent/`
- Project config file: `lab-agent.config.json`
- Lab config template: `config/lab-agent.lab-template.json`
- Runtime metadata envelope: `lab-agent-session.v1`

Rationale: these are internal compatibility anchors, not public branding. Keeping them stable avoids unnecessary migration and reduces the chance of breaking gateway, config, and audit evidence.

## Migration Rule

Future renaming should be compatibility-first:

- Add aliases before removing old names.
- Preserve protocol versions unless the wire contract changes.
- Keep a documented migration path for `.lab-agent/` local state.
- Do not rename audit artifacts in a way that weakens traceability.
