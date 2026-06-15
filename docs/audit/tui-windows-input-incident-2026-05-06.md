# TUI Windows Input Incident Review - 2026-05-06

## Summary

This incident covered a Windows TUI regression where permission mode switching
and transcript message clicks stopped working reliably after a DeepSeek gateway
configuration change and subsequent TUI input diagnostics.

The DeepSeek configuration was not the causal source. The regression was caused
by an old Windows terminal input-mode defect that became high-frequency after
recent raw input and mouse fallback changes.

## User-Visible Symptoms

- `Shift+Tab` stopped switching permission modes.
- Mouse click and double-click on transcript messages stopped opening the
  excerpt panel.
- After some fixes, the TUI became laggy and a single click could be treated as
  a double-click.
- Narrow terminals could hide the permission mode footer.

## Root Cause

The underlying defect already existed in the historical TUI implementation:

- `runWindowsConsoleModeScript()` treated a spawned PowerShell process as
  success whenever `result.error` was empty. It did not require
  `result.status === 0`.
- On the affected Windows machine, `powershell.exe` could start but the
  `Add-Type` console mode script exited with `status=1`; `pwsh.exe` succeeded.
  The old helper returned after the failing `powershell.exe` attempt and never
  tried `pwsh.exe`.
- `enableWindowsConsoleMouseInput()` set `windowsConsoleInputEnabled = true`
  before verifying that the console mode script had succeeded. Later calls then
  skipped recalibration.
- Terminal mouse mode included `1003`, arbitrary mouse movement tracking. This
  generated a large stream of movement events and made raw input handling noisy.

Git history evidence:

- `git log -S "function runWindowsConsoleModeScript" -- src/cli/tui.js`
  traces the helper back to `60cd9be 保存：Ant Code 重构稳定版`.
- `git log -S "1003h" -- src/cli/tui.js` also traces arbitrary mouse tracking
  back to `60cd9be`.
- `git log -S "windowsConsoleInputEnabled" -- src/cli/tui.js` also traces the
  premature state flag back to `60cd9be`.

## Why It Exploded Now

The old defect was latent because previous interaction paths mostly depended on
Ink-level input handling and did not force as many terminal mode transitions.

Recent diagnostic/fallback work changed the frequency and shape of the input
path:

- raw stdin parsing was added for `Shift+Tab`;
- raw stdin parsing was added for mouse click fallback;
- excerpt mode and native selection mode switched terminal mouse mode more
  often;
- raw and Ink paths could both observe the same physical click;
- `1003` movement tracking produced event storms, making lag and false
  double-clicks more obvious.

So the correct attribution is:

- old implementation bug: yes;
- DeepSeek/key change: temporal correlation only, not causal;
- recent TUI diagnostic patch: did not create the old defect, but triggered and
  amplified it.

## Fixes Applied

- `runWindowsConsoleModeScript()` now only treats `status === 0` as success and
  continues to later PowerShell executables when the first attempt fails.
- `enableWindowsConsoleMouseInput()` marks the internal enabled flag only after
  the script succeeds.
- Mouse reporting no longer enables `1003`; it keeps click/drag modes only.
- Resize and excerpt close still force a Windows console input recalibration.
- raw and Ink mouse click paths are deduplicated by coordinate and short time
  window, so one physical click is not treated as two clicks.
- `debugTuiInput()` was added and is gated behind
  `LAB_AGENT_TUI_DEBUG_INPUT=1`.
- Narrow footer rendering now keeps the permission mode visible in one line.

## Verification

Commands used during the repair:

```powershell
node --test tests/unit/tui-interaction.test.js tests/unit/tui-frame.test.js tests/unit/tui-format.test.js
node scripts/check-syntax.js
npm run check
git diff --check
ant-code gateway
```

Manual smoke that must be repeated for future Windows TUI input changes:

- launch from the active repository and from the global `ant-code` shim;
- press `Shift+Tab` through all three permission modes;
- single-click a transcript message and confirm only highlight is shown;
- double-click a transcript message and confirm the excerpt panel opens;
- press `Esc` from excerpt panel and confirm normal clicking works again;
- resize the terminal and repeat the click and shortcut checks;
- test a narrow terminal and confirm the permission footer remains visible.

## Related Features Restored

During this review we also checked whether an earlier request about gateway
robustness and interrupt drafts had survived the rollback.

Original post-rollback state:

- context budget diagnostics, `metadata.gatewayRounds[]`, and disabled-by-default
  output health checks are present;
- gateway fetch automatic retry is not currently implemented in
  `src/model-gateway/client.js`;
- interrupting a streaming assistant response still persists the turn as
  `"Turn interrupted by the local user."` and does not save the partial assistant
  draft into the transcript.

Follow-up on 2026-05-06 restored the two missing items:

- `src/model-gateway/client.js` now retries transient pre-response fetch
  failures according to `lab.gatewayMaxRetries` / `LAB_MODEL_GATEWAY_MAX_RETRIES`
  and emits `gateway_retry` diagnostics.
- `src/core/session.js` now preserves visible interrupted assistant drafts in
  the local transcript and TUI, marked as non-final interrupted drafts.

## Rules For Future Agents

- Do not add user-visible fallback shortcuts when the root cause is terminal
  input mode state.
- Do not treat process spawn success as script success; always check exit status.
- Do not enable `1003` mouse movement tracking in the main TUI.
- Do not let raw input and Ink input process the same physical mouse click
  independently.
- Any Windows TUI input change requires manual smoke testing; unit tests alone
  are not enough.
