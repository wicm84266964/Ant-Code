import { exitConfirmLines, permissionModalLines, promptLines, startupBannerLines, startupConfirmLines, streamingPanelLines } from "../../src/cli/tui/format.js";

export function makeStartupFrame({ session, cwd, trusted = true }) {
  return [
    ...startupBannerLines(session),
    "",
    ...startupConfirmLines(cwd, trusted)
  ].join("\n");
}

export function makePromptFrame({ mode = "input", busy = false, input = "", cursor = null, question = "", questionCursor = null }) {
  return promptLines(mode, busy, input, question, {
    inputCursor: cursor,
    questionCursor,
    showCursor: true
  }).map((line) => line.text).join("\n");
}

export function makeStreamingFrame(stream) {
  return streamingPanelLines(stream, 0, "compact").map((line) => line.text).join("\n");
}

export function makePermissionFrame(pendingApproval, focusedIndex = 0) {
  return permissionModalLines(pendingApproval, focusedIndex).map((line) => line.text).join("\n");
}

export function makeExitFrame(options = {}) {
  return exitConfirmLines(options).join("\n");
}
