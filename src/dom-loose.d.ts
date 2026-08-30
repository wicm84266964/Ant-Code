interface EventTarget {
  closest(selector: string): HTMLElement;
  matches(selector: string): boolean;
  value: string;
  files: FileList;
  checked: boolean;
  disabled: boolean;
  selected: boolean;
  href: string;
  src: string;
  dataset: DOMStringMap;
  classList: DOMTokenList;
  textContent: string;
  innerHTML: string;
  style: CSSStyleDeclaration;
  append(...nodes: (Node | string)[]): void;
  remove(): void;
  click(): void;
  focus(options?: FocusOptions): void;
  blur(): void;
}

interface HTMLElement {
  value: string;
  files: FileList;
  checked: boolean;
  disabled: boolean;
  selected: boolean;
  href: string;
  src: string;
  type: string;
  name: string;
  placeholder: string;
  hidden: boolean;
  tabIndex: number;
  inert: boolean;
}

interface Element {
  closest(selector: string): HTMLElement;
  parentElement: HTMLElement;
  children: HTMLCollectionOf<HTMLElement>;
}

interface Document {
  getElementById(elementId: string): HTMLElement;
}

interface ParentNode {
  querySelector(selectors: string): HTMLElement;
  querySelectorAll(selectors: string): NodeListOf<HTMLElement>;
}

interface Event {
  target: EventTarget;
  currentTarget: EventTarget;
}
