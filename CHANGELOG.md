# Changelog

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

### Validation

- `npm test -- tests/unit/dashboard-runtime.test.js`
- `npm test -- tests/unit/dashboard-runtime.test.js tests/unit/dashboard-server.test.js tests/unit/context-window.test.js tests/unit/config.test.js`
