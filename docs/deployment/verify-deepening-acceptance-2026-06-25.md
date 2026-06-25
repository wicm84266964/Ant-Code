# Verify Deepening Acceptance

Date: 2026-06-25

## Scope

This record accepts the `/verify` deepening work for Ant Code. The change
improves local validation planning and result memory for CLI, TUI, and
interactive chat slash commands. Dashboard slash commands remain out of scope.

## Accepted Behavior

- `/verify suggest` groups local validation suggestions into `minimal`,
  `related`, and `full` tiers.
- Suggestions retain command compatibility while carrying `tier`, `source`,
  `confidence`, and `relatedFiles` metadata.
- `/verify run suggested` still resolves to the first best local validation
  suggestion and runs through the existing shell permission engine.
- `/verify` shows validation memory derived from session-local workflow state:
  suggested, pending, passed, failed, and stale checks.
- `/next` and `/report` include validation memory so the user can see which
  checks remain pending or stale before delivery.
- JavaScript and TypeScript source changes can map to same-name test files such
  as `src/math.ts` -> `tests/math.test.ts` when a local `test:unit` script
  exists.
- Stale passing validations no longer satisfy pending suggestions after later
  file changes.
- Later passing validation clears earlier unresolved failures for the current
  delivery state.

## Boundary

- Dashboard does not currently parse `/verify` as a local slash command.
- Print-mode calls such as `ant-code -p "/verify run suggested"` are separate
  processes; validation memory is not expected to persist across separate
  invocations.
- `/verify run` executes shell commands. It does not run model tool names such
  as `ts_diagnostics` directly.
- Full command output is not persisted into session metadata.

## Automated Verification

```powershell
node --test tests\unit\validation-memory.test.js tests\unit\commands.test.js tests\unit\delivery.test.js tests\unit\task-lifecycle.test.js tests\unit\session.test.js
npm run check:syntax
git diff --check
```

Result:

- 113 relevant tests passed.
- Syntax check passed for 190 files.
- `git diff --check` passed.

## Smoke Verification

- Real CLI print-mode scratch workspace: `/verify suggest` tiers, related test
  mapping, `/verify` pending summary, and `/verify run suggested` execution
  passed.
- Same-process slash-command scratch workspace: `/verify run suggested` records
  history, stale validations re-enter pending, and later passing validation
  clears earlier unresolved failures.
