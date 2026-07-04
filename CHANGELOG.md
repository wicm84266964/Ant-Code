# Changelog

## 1.2.4 - 2026-07-04

### Fixed

- Dashboard model settings can now save a user-level global default at
  `~/.ant-code/lab-agent.config.json`, while project defaults continue to save
  under `.lab-agent/config.json`.
- New workspaces now load the user global gateway/model defaults automatically,
  so users do not need to reconfigure the same gateway in every project.
- Project model/gateway settings still override global and environment defaults,
  while gateway API keys from environment variables remain available as a
  fallback when the project does not store a key.
- Environment-provided gateway/model defaults now present a single active
  gateway profile instead of mixing in stale profiles from older global config
  files.
- Template and placeholder project configs no longer override real global
  model/gateway defaults.

### Validation

- `node --test tests/unit/config.test.js`
- `node --test tests/unit/dashboard-runtime.test.js`

## 1.2.3 - 2026-07-01

### Fixed

- Dashboard model configuration now treats a saved model context window as the
  current project's local context budget, so the composer context limit and
  automatic compaction budget stay aligned with the configured model window.
- Saving model configuration while a turn is running no longer resets the
  Dashboard context badge to `0`; existing prompt/context usage is preserved
  while the updated configured limit is displayed.
- Idle Dashboard sessions rebuild their context window after model/config
  changes while retaining existing compaction summary metadata.
- Automatic context compaction now defaults to the configured context window
  itself instead of a hidden ratio, and the byte fallback budget follows larger
  token windows unless explicitly overridden.
- Resuming a compacted session no longer expands archived full context when the
  restored prompt would immediately exceed the configured context budget; Ant
  Code keeps the compacted summary active instead.
- Background terminal tasks can now be listed and cancelled by model tools,
  allowing agents to reuse or recycle an existing server/viewer before starting
  a replacement.

### Validation

- `npm test -- tests/unit/dashboard-runtime.test.js`
- `npm test -- tests/unit/dashboard-runtime.test.js tests/unit/dashboard-server.test.js tests/unit/context-window.test.js tests/unit/config.test.js`
- `npm test -- tests/unit/config.test.js`
- `npm test -- tests/unit/session.test.js`
- `node --test --test-name-pattern "createSession keeps compacted context when restored full archive would exceed prompt budget" tests/unit/session.test.js`
- `npm test -- tests/unit/tools.test.js`
- `npm test -- tests/unit/agent-profiles-config.test.js tests/unit/context.test.js`
