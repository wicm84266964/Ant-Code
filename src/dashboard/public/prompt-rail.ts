import { els, state } from "./app-core.ts";

export const PROMPT_RAIL_MIN_TURNS = 2;
export const PROMPT_RAIL_LABEL_DELAY_MS = 150;

export type PromptRailSourceEntry = {
  role: "user" | "assistant";
  text: string;
  node: HTMLElement;
};

export type PromptRailTurn = {
  id: string;
  prompt: string;
  response: string;
  node: HTMLElement;
};

export function normalizePromptRailText(text: string) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function promptRailWidth(index: number, hoverIndex: number, activeIndex: number) {
  if (hoverIndex >= 0) {
    const distance = Math.abs(index - hoverIndex);
    if (distance === 0) return 40;
    if (distance === 1) return 30;
    if (distance === 2) return 20;
    return index === activeIndex ? 16 : 12;
  }
  return index === activeIndex ? 16 : 12;
}

export function shouldShowPromptRail(count: number) {
  return count >= PROMPT_RAIL_MIN_TURNS;
}

export function promptTextFromEntry(entry: PromptRailSourceEntry) {
  const text = normalizePromptRailText(entry.text);
  if (text) return text;
  const names = typeof entry.node.querySelectorAll === "function"
    ? Array.from(entry.node.querySelectorAll(".attachment-chip"))
      .map((chip) => normalizePromptRailText(chip.textContent ?? ""))
      .filter(Boolean)
    : [];
  return names.length > 0 ? names.join("、") : "附件";
}

export function pairPromptRailTurns(entries: PromptRailSourceEntry[], idFor: (index: number) => string) {
  const turns: PromptRailTurn[] = [];
  let current: PromptRailTurn | null = null;
  for (const entry of entries) {
    if (entry.role === "user") {
      current = {
        id: idFor(turns.length),
        prompt: promptTextFromEntry(entry),
        response: "",
        node: entry.node
      };
      entry.node.dataset.promptTurn = "true";
      entry.node.dataset.promptId = current.id;
      turns.push(current);
      continue;
    }
    if (current) {
      const response = normalizePromptRailText(entry.text);
      if (response) current.response = response;
    }
  }
  return turns;
}

function railElements() {
  return {
    rail: els.promptRail instanceof HTMLElement ? els.promptRail : null,
    frame: els.promptRailFrame instanceof HTMLElement ? els.promptRailFrame : null,
    scroller: els.promptRailScroller instanceof HTMLElement ? els.promptRailScroller : null,
    marks: els.promptRailMarks instanceof HTMLElement ? els.promptRailMarks : null,
    preview: els.promptRailPreview instanceof HTMLElement ? els.promptRailPreview : null
  };
}

function nextPromptId() {
  state.promptRail.nextId += 1;
  return `prompt-${state.promptRail.nextId}`;
}

function markSignature(turns: PromptRailTurn[]) {
  return turns.map((turn) => turn.id).join("\n");
}

function responseFromFollowingNodes(node: HTMLElement) {
  let response = "";
  let sibling = node.nextElementSibling;
  while (sibling) {
    if (sibling.classList.contains("message") && sibling.classList.contains("user")) break;
    if (sibling.classList.contains("message") && sibling.classList.contains("assistant") && !sibling.classList.contains("draft-message")) {
      const text = normalizePromptRailText(sibling.querySelector(".message-body")?.textContent ?? "");
      if (text) response = text;
    }
    sibling = sibling.nextElementSibling;
  }
  return response;
}

function fillMissingResponse(turn: PromptRailTurn) {
  if (turn.response || !turn.node.isConnected) return;
  turn.response = responseFromFollowingNodes(turn.node);
}

export function resetPromptRail() {
  if (state.promptRail.highlightTimer) clearTimeout(state.promptRail.highlightTimer);
  state.promptRail.turns = [];
  state.promptRail.hoverIndex = -1;
  state.promptRail.activeIndex = -1;
  state.promptRail.pointerInside = false;
  state.promptRail.responseOpen = false;
  clearPromptRailLabelTimer();
  state.promptRail.labelIndex = -1;
  state.promptRail.highlightTimer = null;
  renderPromptRail();
}

export function adoptPromptRailEntries(entries: PromptRailSourceEntry[], options: { prepend?: boolean } = {}) {
  const turns = pairPromptRailTurns(entries, () => nextPromptId());
  if (turns.length === 0) {
    renderPromptRail();
    return;
  }
  const last = turns[turns.length - 1];
  if (last) fillMissingResponse(last);
  if (options.prepend) {
    state.promptRail.hoverIndex = -1;
    state.promptRail.turns = [...turns, ...state.promptRail.turns];
    if (state.promptRail.activeIndex >= 0) state.promptRail.activeIndex += turns.length;
  } else {
    state.promptRail.turns = [...state.promptRail.turns, ...turns];
    state.promptRail.responseOpen = true;
  }
  renderPromptRail();
  syncPromptRailActive();
}

export function registerPromptTurn(node: HTMLElement, text: string) {
  node.dataset.promptTurn = "true";
  const turn: PromptRailTurn = {
    id: nextPromptId(),
    prompt: promptTextFromEntry({ role: "user", text, node }),
    response: "",
    node
  };
  node.dataset.promptId = turn.id;
  state.promptRail.turns.push(turn);
  state.promptRail.responseOpen = true;
  renderPromptRail();
  syncPromptRailActive();
}

export function closePromptRailResponse() {
  state.promptRail.responseOpen = false;
}

export function notePromptRailResponse(text: string) {
  const response = normalizePromptRailText(text);
  const turn = state.promptRail.turns[state.promptRail.turns.length - 1];
  if (!state.promptRail.responseOpen || !response || !turn) return;
  turn.response = response;
  renderPromptRail();
}

export function syncPromptRailActive() {
  const transcript = els.transcript instanceof HTMLElement ? els.transcript : null;
  if (!transcript) return;
  const top = transcript.getBoundingClientRect().top + 28;
  let active = -1;
  for (let index = 0; index < state.promptRail.turns.length; index += 1) {
    const node = state.promptRail.turns[index]?.node;
    if (!node?.isConnected) continue;
    if (active < 0 || node.getBoundingClientRect().top <= top) active = index;
  }
  if (active < 0 || active === state.promptRail.activeIndex) return;
  state.promptRail.activeIndex = active;
  renderPromptRail();
}

function announcePromptJump(message: string) {
  const region = els.dashboardLiveRegion;
  if (!region) return;
  region.textContent = "";
  requestAnimationFrame(() => {
    region.textContent = message;
  });
}

export function jumpToPromptTurn(index: number) {
  const turn = state.promptRail.turns[index];
  const transcript = els.transcript instanceof HTMLElement ? els.transcript : null;
  if (!turn || !transcript || !turn.node.isConnected) {
    announcePromptJump("这条提示已不在当前页面");
    return;
  }
  const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const delta = turn.node.getBoundingClientRect().top - transcript.getBoundingClientRect().top;
  transcript.scrollTo({
    top: Math.max(0, transcript.scrollTop + delta - 24),
    behavior: reduceMotion ? "auto" : "smooth"
  });
  for (const item of state.promptRail.turns) item.node.classList.remove("prompt-jump-target");
  turn.node.classList.add("prompt-jump-target");
  if (state.promptRail.highlightTimer) clearTimeout(state.promptRail.highlightTimer);
  state.promptRail.highlightTimer = setTimeout(() => {
    turn.node.classList.remove("prompt-jump-target");
    state.promptRail.highlightTimer = null;
  }, 2000);
  state.promptRail.activeIndex = index;
  state.transcriptFollowing = false;
  announcePromptJump(`已回到第 ${index + 1} 条提示`);
  renderPromptRail();
}

function ensureMarks(marks: HTMLElement, turns: PromptRailTurn[]) {
  const signature = markSignature(turns);
  if (marks.dataset.signature === signature && marks.childElementCount === turns.length) return;
  marks.dataset.signature = signature;
  marks.replaceChildren();
  turns.forEach((turn, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "prompt-rail-mark";
    button.dataset.index = String(index);
    const label = turn.prompt.length > 80 ? `${turn.prompt.slice(0, 79)}…` : turn.prompt;
    button.setAttribute("aria-label", `跳到第 ${index + 1} 条提示：${label}`);
    marks.append(button);
  });
}

function applyMarkState(marks: HTMLElement) {
  const { turns, hoverIndex, activeIndex } = state.promptRail;
  Array.from(marks.children).forEach((node, index) => {
    if (!(node instanceof HTMLElement)) return;
    const width = promptRailWidth(index, hoverIndex, activeIndex);
    node.style.setProperty("--prompt-width", `${width}px`);
    const visual = hoverIndex === index ? "hover" : activeIndex === index ? "active" : "rest";
    node.dataset.state = visual;
    if (activeIndex === index) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
    if (hoverIndex === index) node.setAttribute("aria-describedby", "prompt-rail-preview");
    else node.removeAttribute("aria-describedby");
  });
}

function renderPreview(frame: HTMLElement, marks: HTMLElement, preview: HTMLElement) {
  const index = state.promptRail.labelIndex;
  const turn = index >= 0 ? state.promptRail.turns[index] : undefined;
  const indexLabel = preview.querySelector(".prompt-rail-index");
  const prompt = preview.querySelector(".prompt-rail-prompt");
  const response = preview.querySelector(".prompt-rail-response");
  if (!turn || !(prompt instanceof HTMLElement) || !(response instanceof HTMLElement)) {
    preview.classList.add("hidden");
    preview.hidden = true;
    return;
  }
  if (indexLabel instanceof HTMLElement) indexLabel.textContent = String(index + 1).padStart(2, "0");
  prompt.textContent = turn.prompt;
  response.textContent = turn.response;
  response.classList.toggle("hidden", turn.response.length === 0);
  preview.classList.remove("hidden");
  preview.hidden = false;
  const mark = marks.children[index];
  if (!(mark instanceof HTMLElement)) return;
  const frameRect = frame.getBoundingClientRect();
  const markRect = mark.getBoundingClientRect();
  const height = preview.offsetHeight || 72;
  const center = markRect.top + markRect.height / 2 - frameRect.top;
  const top = Math.max(8, Math.min(Math.max(8, frameRect.height - height - 8), center - height / 2));
  preview.style.top = `${top}px`;
}

function centerActiveMark(scroller: HTMLElement, marks: HTMLElement) {
  if (state.promptRail.pointerInside) return;
  const mark = marks.children[state.promptRail.activeIndex];
  if (!(mark instanceof HTMLElement) || scroller.clientHeight <= 0) return;
  const target = mark.offsetTop - scroller.clientHeight / 2 + mark.offsetHeight / 2;
  scroller.scrollTop = Math.max(0, target);
}

export function renderPromptRail() {
  const { rail, frame, scroller, marks, preview } = railElements();
  if (!rail || !frame || !scroller || !marks || !preview) return;
  const turns = state.promptRail.turns;
  const visible = shouldShowPromptRail(turns.length);
  rail.classList.toggle("hidden", !visible);
  rail.hidden = !visible;
  rail.dataset.open = state.promptRail.hoverIndex >= 0 ? "true" : "false";
  if (!visible) {
    marks.dataset.signature = "";
    marks.replaceChildren();
    preview.classList.add("hidden");
    preview.hidden = true;
    return;
  }
  ensureMarks(marks, turns);
  applyMarkState(marks);
  renderPreview(frame, marks, preview);
  centerActiveMark(scroller, marks);
  syncPromptRailFade(scroller);
}

function indexFromEvent(event: Event) {
  const target = event.target instanceof Element ? event.target.closest(".prompt-rail-mark") : null;
  if (!(target instanceof HTMLElement)) return -1;
  const index = Number(target.dataset.index);
  return Number.isInteger(index) ? index : -1;
}

function clearPromptRailLabelTimer() {
  if (!state.promptRail.labelTimer) return;
  clearTimeout(state.promptRail.labelTimer);
  state.promptRail.labelTimer = null;
}

function setHover(index: number, options: { immediateLabel?: boolean } = {}) {
  const hoverChanged = state.promptRail.hoverIndex !== index;
  state.promptRail.hoverIndex = index;
  if (index < 0) {
    clearPromptRailLabelTimer();
    const labelChanged = state.promptRail.labelIndex !== -1;
    state.promptRail.labelIndex = -1;
    if (hoverChanged || labelChanged) renderPromptRail();
    return;
  }
  if (options.immediateLabel) {
    clearPromptRailLabelTimer();
    state.promptRail.labelIndex = index;
    renderPromptRail();
    return;
  }
  if (!hoverChanged) return;
  clearPromptRailLabelTimer();
  const labelWasVisible = state.promptRail.labelIndex !== -1;
  state.promptRail.labelIndex = -1;
  state.promptRail.labelTimer = setTimeout(() => {
    state.promptRail.labelTimer = null;
    if (state.promptRail.hoverIndex !== index) return;
    state.promptRail.labelIndex = index;
    renderPromptRail();
  }, PROMPT_RAIL_LABEL_DELAY_MS);
  if (hoverChanged || labelWasVisible) renderPromptRail();
}

function syncPromptRailFade(scroller: HTMLElement) {
  const overflow = scroller.scrollHeight - scroller.clientHeight;
  const top = scroller.scrollTop > 1;
  const bottom = overflow > 1 && scroller.scrollTop < overflow - 1;
  scroller.dataset.fade = top && bottom ? "both" : top ? "top" : bottom ? "bottom" : "none";
}

export function bindPromptRail() {
  const { rail, frame, scroller } = railElements();
  if (!rail || !frame || rail.dataset.bound === "true") return;
  rail.dataset.bound = "true";
  frame.addEventListener("pointerenter", () => {
    state.promptRail.pointerInside = true;
  });
  frame.addEventListener("pointerleave", () => {
    state.promptRail.pointerInside = false;
    setHover(-1);
  });
  frame.addEventListener("pointerover", (event) => {
    const index = indexFromEvent(event);
    if (index >= 0) setHover(index);
  });
  frame.addEventListener("pointermove", (event) => {
    const index = indexFromEvent(event);
    if (index >= 0) setHover(index);
  });
  frame.addEventListener("click", (event) => {
    const index = indexFromEvent(event);
    if (index < 0) return;
    event.preventDefault();
    jumpToPromptTurn(index);
  });
  frame.addEventListener("focusin", (event) => {
    state.promptRail.pointerInside = true;
    setHover(indexFromEvent(event), { immediateLabel: true });
  });
  scroller?.addEventListener("scroll", () => syncPromptRailFade(scroller));
  frame.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && frame.contains(next)) return;
    state.promptRail.pointerInside = false;
    setHover(-1);
  });
  frame.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Escape") return;
    const buttons = Array.from(frame.querySelectorAll<HTMLButtonElement>(".prompt-rail-mark"));
    if (event.key === "Escape") {
      setHover(-1);
      return;
    }
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement instanceof HTMLButtonElement ? document.activeElement : buttons[0]);
    const next = event.key === "ArrowDown"
      ? Math.min(buttons.length - 1, Math.max(0, current) + 1)
      : Math.max(0, current - 1);
    buttons[next]?.focus();
  });
}
