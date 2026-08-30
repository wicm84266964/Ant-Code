import {
  clampDraftCursor,
  createDraft,
  type InputDraft,
  cursorToEnd
} from "./input-editor.ts";

export function updateDraftRef(ref: { current?: InputDraft | null }, updater: (draft: InputDraft) => InputDraft) {
  const draft = clampDraftCursor(ref.current ?? createDraft(""));
  const next = clampDraftCursor(updater(draft));
  ref.current = next;
  return next;
}

export function createSynchronousDraftMirror(initial: { text?: string; cursor?: number | null } = {}) {
  const ref = {
    current: clampDraftCursor(createDraft(initial.text ?? "", initial.cursor ?? null))
  };
  return {
    ref,
    replace(text: string, cursor: number | null = null) {
      const next = clampDraftCursor(createDraft(text, cursor === null ? cursorToEnd(text) : cursor));
      ref.current = next;
      return next;
    },
    update(updater: (draft: InputDraft) => InputDraft) {
      return updateDraftRef(ref, updater);
    }
  };
}
