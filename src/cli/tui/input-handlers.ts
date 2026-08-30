import React from "react";
import { APPROVAL_CHOICES, normalizeQuestionPrompt } from "./format.ts";
import {
  deleteBackward,
  deleteForward,
  deleteToEnd,
  deleteToStart,
  displayWidth,
  insertText,
  moveCursor,
  moveCursorLineBoundary,
  moveCursorVertical,
  type InputDraft
} from "./input-editor.ts";
import type {
  InkKey,
  TuiActivity,
  TuiPendingApproval,
  TuiPendingQuestion,
  TuiUiState
} from "./types.ts";
import { isCtrlKey, sanitizeComposerText, splitTrailingSubmitInput } from "./terminal-mode.ts";

export function handleApprovalInput(
  inputValue: unknown,
  key: InkKey,
  current: TuiUiState,
  sessionApprovals: { add: (key: string) => void },
  addEntry: (kind: string, title: string, body?: string | number | null) => void,
  setActivity: (updater: (current: TuiActivity) => TuiActivity) => void,
  setMode: (mode: string) => void,
  setPendingApproval: (value: TuiPendingApproval | null) => void,
  setApprovalChoiceIndex: (value: number | ((current: number) => number)) => void
) {
  let choice = String(inputValue ?? "").toLowerCase();
  if (!current.pendingApproval) {
    return;
  }
  if (key.leftArrow || key.upArrow) {
    setApprovalChoiceIndex((value) => (value + APPROVAL_CHOICES.length - 1) % APPROVAL_CHOICES.length);
    return;
  }
  if (key.rightArrow || key.downArrow || key.tab) {
    setApprovalChoiceIndex((value) => (value + 1) % APPROVAL_CHOICES.length);
    return;
  }
  if (key.return) {
    choice = APPROVAL_CHOICES[current.approvalChoiceIndex]?.key ?? "y";
  }
  if (choice === "escape") {
    const pending = current.pendingApproval;
    setPendingApproval(null);
    setMode("input");
    setApprovalChoiceIndex(0);
    addEntry("approval", `${pending.toolName} 已取消`, "已取消。");
    setActivity((value) => ({ ...value, status: "审批已取消", lastTool: `${pending.toolName} 已取消` }));
    pending.resolve?.(false);
    return;
  }
  if (!["y", "n", "a"].includes(choice)) {
    return;
  }
  const pending = current.pendingApproval;
  setPendingApproval(null);
  setMode("input");
  setApprovalChoiceIndex(0);
  if (choice === "a") {
    if (pending.approvalKey) {
      sessionApprovals.add(pending.approvalKey);
    }
    addEntry("approval", `${pending.toolName} 已批准`, "本会话中匹配的请求已批准。");
    setActivity((value) => ({ ...value, status: "审批已通过", lastTool: `${pending.toolName} 已批准` }));
    pending.resolve?.(true);
  } else if (choice === "y") {
    addEntry("approval", `${pending.toolName} 已批准`, "已允许一次。");
    setActivity((value) => ({ ...value, status: "审批已通过", lastTool: `${pending.toolName} 已批准` }));
    pending.resolve?.(true);
  } else {
    addEntry("approval", `${pending.toolName} 已拒绝`, "已拒绝。");
    setActivity((value) => ({ ...value, status: "审批已拒绝", lastTool: `${pending.toolName} 已拒绝` }));
    pending.resolve?.(false);
  }
}

export function handleQuestionInput(inputValue: unknown, key: InkKey, current: TuiUiState, handlers: {
  addEntry: (kind: string, title: string, body?: string | number | null) => void;
  setActivity: (updater: (current: TuiActivity) => TuiActivity) => void;
  setMode: (mode: string) => void;
  setPendingQuestion: React.Dispatch<React.SetStateAction<TuiPendingQuestion | null>>;
  replaceQuestionDraft: (text: string, cursor?: number | null) => void;
  updateQuestionDraft: (updater: (draft: InputDraft) => InputDraft) => InputDraft;
}) {
  const {
    addEntry,
    setActivity,
    setMode,
    setPendingQuestion,
    replaceQuestionDraft,
    updateQuestionDraft
  } = handlers;
  if (!current.pendingQuestion) {
    return;
  }
  const prompt = normalizeQuestionPrompt(current.pendingQuestion);
  const hasChoices = prompt.choices.length > 0;
  if (key.escape) {
    const pending = current.pendingQuestion;
    setPendingQuestion(null);
    replaceQuestionDraft("");
    setMode("input");
    addEntry("answer", "你已取消回答", "[取消]");
    setActivity((value) => ({ ...value, status: "回答已取消" }));
    pending.resolve?.({
      answer: "",
      selectedChoice: null,
      selectedChoices: [],
      cancelled: true
    });
    return;
  }
  if (hasChoices && key.upArrow) {
    const nextIndex = (prompt.focusedIndex - 1 + prompt.choices.length) % prompt.choices.length;
    setPendingQuestion((pending: TuiUiState["pendingQuestion"]) => pending ? { ...pending, focusedIndex: nextIndex } : pending);
    return;
  }
  if (hasChoices && key.downArrow) {
    const nextIndex = (prompt.focusedIndex + 1) % prompt.choices.length;
    setPendingQuestion((pending: TuiUiState["pendingQuestion"]) => pending ? { ...pending, focusedIndex: nextIndex } : pending);
    return;
  }
  if (hasChoices && inputValue === " " && (!prompt.allowCustom || current.questionBuffer.length === 0)) {
    if (prompt.multiple) {
      const selected = new Set(prompt.selectedIndices);
      if (selected.has(prompt.focusedIndex)) {
        selected.delete(prompt.focusedIndex);
      } else {
        selected.add(prompt.focusedIndex);
      }
      setPendingQuestion((pending: TuiUiState["pendingQuestion"]) => pending ? { ...pending, selectedIndices: [...selected] } : pending);
    } else {
      setPendingQuestion((pending: TuiUiState["pendingQuestion"]) => pending ? { ...pending, selectedIndices: [prompt.focusedIndex] } : pending);
    }
    return;
  }
  if (isCtrlKey(inputValue, key, "a")) {
    updateQuestionDraft((draft) => moveCursor(draft, "start"));
    return;
  }
  if (isCtrlKey(inputValue, key, "e")) {
    updateQuestionDraft((draft) => moveCursor(draft, "end"));
    return;
  }
  if (isCtrlKey(inputValue, key, "k")) {
    updateQuestionDraft(deleteToEnd);
    return;
  }
  if (isCtrlKey(inputValue, key, "u")) {
    updateQuestionDraft(deleteToStart);
    return;
  }
  const trailingSubmitText = splitTrailingSubmitInput(inputValue, key);
  if (trailingSubmitText !== null) {
    const next = updateQuestionDraft((draft) => insertText(draft, trailingSubmitText));
    handleQuestionInput("", { return: true }, {
      ...current,
      questionBuffer: next.text,
      questionCursor: next.cursor
    }, handlers);
    return;
  }
  if (isCtrlKey(inputValue, key, "j")) {
    updateQuestionDraft((draft) => insertText(draft, "\n"));
    return;
  }
  if (key.return && (key.shift || key.meta)) {
    updateQuestionDraft((draft) => insertText(draft, "\n"));
    return;
  }
  if (key.return) {
    const customAnswer = current.questionBuffer.trim();
    const pending = current.pendingQuestion;
    const refreshedPrompt = normalizeQuestionPrompt(pending);
    const selectedIndices = refreshedPrompt.multiple
      ? refreshedPrompt.selectedIndices
      : refreshedPrompt.selectedIndices.length > 0
        ? refreshedPrompt.selectedIndices
        : hasChoices && !customAnswer
          ? [refreshedPrompt.focusedIndex]
          : [];
    const selectedChoices = selectedIndices
      .map((index: number) => refreshedPrompt.choices[index]?.label)
      .filter((label): label is string => Boolean(label));
    const answer = customAnswer || selectedChoices.join(", ");
    setPendingQuestion(null);
    replaceQuestionDraft("");
    setMode("input");
    addEntry("answer", "你已回答", answer || "[空]");
    setActivity((value) => ({ ...value, status: "回答已提交" }));
    pending.resolve?.({
      answer,
      selectedChoice: selectedChoices[0] ?? null,
      selectedChoices,
      customAnswer: customAnswer || null,
      workflowReminder: refreshedPrompt.choices.length > 0
        ? "If this confirmation starts multi-step work, update the visible workflow state with todo_write and/or plan_update. Before the final response, mark completed visible items as completed."
        : null
    });
    return;
  }
  if (!hasChoices && !key.ctrl && (key.upArrow || key.downArrow) && current.questionBuffer) {
    updateQuestionDraft((draft) => moveCursorVertical(draft, key.upArrow ? "up" : "down", {
      columns: composerContentColumns({ ...current, mode: "question" })
    }));
    return;
  }
  if (key.leftArrow) {
    updateQuestionDraft((draft) => moveCursor(draft, key.meta ? "word-left" : "left"));
    return;
  }
  if (key.rightArrow) {
    updateQuestionDraft((draft) => moveCursor(draft, key.meta ? "word-right" : "right"));
    return;
  }
  if (key.home) {
    updateQuestionDraft((draft) => moveCursorLineBoundary(draft, "start", {
      columns: composerContentColumns({ ...current, mode: "question" })
    }));
    return;
  }
  if (key.end) {
    updateQuestionDraft((draft) => moveCursorLineBoundary(draft, "end", {
      columns: composerContentColumns({ ...current, mode: "question" })
    }));
    return;
  }
  if (key.backspace) {
    updateQuestionDraft(deleteBackward);
    return;
  }
  if (key.delete) {
    updateQuestionDraft(deleteForward);
    return;
  }
  const inputText = sanitizeComposerText(inputValue);
  if (!key.ctrl && !key.meta && inputText) {
    updateQuestionDraft((draft) => insertText(draft, inputText));
  }
}

export function recallHistory(
  direction: number,
  history: string[],
  historyIndex: number | null,
  setHistoryIndex: (value: number | null) => void,
  replaceInputDraft: (text: string, cursor?: number | null) => void
) {
  if (history.length === 0) {
    return;
  }
  const nextIndex = historyIndex === null
    ? direction < 0 ? history.length - 1 : 0
    : Math.min(history.length - 1, Math.max(0, historyIndex + direction));
  setHistoryIndex(nextIndex);
  const text = history[nextIndex] ?? "";
  replaceInputDraft(text);
}

export function nextFilter(value: string, filters: readonly string[], direction: number = 1) {
  const list = Array.isArray(filters) && filters.length > 0 ? filters : ["all"];
  const index = list.indexOf(value);
  const current = index >= 0 ? index : 0;
  return list[(current + direction + list.length) % list.length] ?? list[0];
}

export function composerContentColumns(current: Partial<TuiUiState> = {}) {
  const size = current.terminalSize ?? { columns: 100, rows: 30 };
  const width = Math.max(60, Number(size.columns) || 100);
  const prompt = current.mode === "question"
    ? (normalizeQuestionPrompt(current.pendingQuestion ?? {}).choices.length > 0 ? "自定义>" : "回答>")
    : current.busy
      ? "队列>"
      : String(current.inputBuffer ?? "").trimStart().startsWith("!")
        ? "Shell>"
        : ">";
  const draftColumns = Math.max(8, width - 4);
  const promptColumns = displayWidth(prompt) + 1;
  return Math.max(8, draftColumns - Math.max(promptColumns, 2));
}
