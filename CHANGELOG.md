# Changelog

## Unreleased

### Security

- Dashboard is restricted to loopback hosts and now uses process-local session
  and CSRF credentials, strict cookie settings, exact Host/port and Origin
  validation, JSON-only mutations, anti-framing headers, and cross-site request
  rejection.
- Dashboard turn, image, file, SVG, remote media, and Office preview paths now
  enforce explicit size, type, canonical-path, signature, extraction, ratio,
  and worker-time boundaries.
- New Dashboard tasks default to `plan`; permission state is session-specific,
  and `fullAccess` requires an explicit risk confirmation.

### Changed

- Dashboard event streams resume from the last sequence with bounded
  exponential retry, visible stale/offline states, and manual reconnect.
- Mobile and tablet layouts provide dedicated Sessions, Conversation, and Files
  views with keyboard and modal focus handling.
- Transcript history uses cursor pagination and a bounded browser DOM. Idle
  active-session state is reclaimed without removing persisted history or
  compatibility with older transcript metadata and chunks.
- Shutdown reports active, quarantined, queued, background, and pending work;
  cancelling active work requires an explicit close decision and bounded
  cleanup.

### Validation

- `npm run check` now covers syntax, forbidden endpoints, dependency and lockfile
  policy, strict release-script types plus the Dashboard diagnostic ratchet,
  unit/integration tests, a real Microsoft Edge Dashboard suite, committed asset
  parity, and `git diff --check`.
- Windows executable builds verify the committed rich-renderer bundle, KaTeX
  CSS, and fonts before release output is changed.

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
