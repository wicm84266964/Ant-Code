import { renderStructuredData } from "./structured-data.ts";

type RichVendor = {
  renderMath?: (source: string, options?: { displayMode?: boolean }) => string;
  renderMermaid?: (source: string, id: string) => Promise<{ svg: string }>;
  parseYaml?: (source: string) => unknown;
};

type DeferredDetails = HTMLElement & { open?: boolean };
type TreeExpander = (id?: string) => string;

let vendorPromise: Promise<RichVendor> | null = null;
let mermaidCounter = 0;

export async function hydrateRichContent(root: ParentNode) {
  hydrateRawToggles(root);
  hydrateImageGalleries(root);
  await hydrateMath(root);
  await hydrateData(root);
  await hydrateMermaid(root);
  hydrateToc(root);
}

function hydrateImageGalleries(root: ParentNode) {
  const parents = new Set(Array.from(root.querySelectorAll(".md-image-button")).map((button) => button.parentElement).filter(Boolean));
  for (const parent of parents) {
    const images = parent.querySelectorAll(":scope > .md-image-button");
    parent.classList.toggle("md-image-gallery", images.length > 1);
  }
}

function hydrateRawToggles(root: ParentNode) {
  root.querySelectorAll(".md-toggle-raw").forEach((button) => {
    if (button.dataset.bound === "true") {
      return;
    }
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      const frame = button.closest(".md-mermaid-frame, .md-data-frame");
      const raw = frame?.querySelector(".md-raw-source");
      const rendered = frame?.querySelector(".md-mermaid-output, .md-data-output");
      if (!raw || !rendered) {
        return;
      }
      const showingRaw = raw.classList.toggle("hidden");
      rendered.classList.toggle("hidden", !showingRaw);
      button.textContent = showingRaw ? "查看原文" : "查看预览";
    });
  });
}

async function hydrateMath(root: ParentNode) {
  const targets = Array.from(root.querySelectorAll("[data-math-source]"))
    .filter((node) => node.dataset.rendered !== "true");
  if (targets.length === 0) {
    return;
  }
  const vendor = await loadVendor().catch(() => null);
  for (const node of targets) {
    const source = node.dataset.mathSource ?? "";
    const displayMode = node.dataset.mathDisplay === "true";
    const output = displayMode ? node.querySelector(".md-math-output") ?? node : node;
    if (!vendor?.renderMath) {
      markMathFailure(output, source);
      continue;
    }
    try {
      output.innerHTML = vendor.renderMath(source, { displayMode });
      node.dataset.rendered = "true";
    } catch {
      markMathFailure(output, source);
    }
  }
}

async function hydrateData(root: ParentNode) {
  const frames = Array.from(root.querySelectorAll(".md-data-frame"))
    .filter((node) => node.dataset.rendered !== "true");
  if (frames.length === 0) {
    return;
  }
  const vendor = await loadVendor().catch(() => ({}));
  for (const frame of frames) {
    const kind = frame.dataset.dataKind ?? "";
    const raw = frame.querySelector(".md-raw-source code")?.textContent ?? "";
    const output = frame.querySelector(".md-data-output");
    if (!output) {
      continue;
    }
    const result = renderStructuredData(kind, raw, vendor);
    output.innerHTML = result.ok
      ? `<div class="data-summary">${escapeHtml(result.summary)}</div>${result.html}${result.tsv ? `<button type="button" class="data-copy" data-copy-tsv="${escapeAttribute(result.tsv)}">复制为 TSV</button>` : ""}`
      : result.html;
    bindDeferredTree(output, result.ok ? result.expandTreeNode : undefined);
    frame.dataset.rendered = "true";
    output.querySelectorAll(".data-copy").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copyTsv ?? "");
          button.textContent = "已复制";
          setTimeout(() => { button.textContent = "复制为 TSV"; }, 1200);
        } catch {
          button.textContent = "复制失败";
          setTimeout(() => { button.textContent = "复制为 TSV"; }, 1400);
        }
      });
    });
  }
}

function bindDeferredTree(root: ParentNode, expandTreeNode: unknown) {
  if (typeof expandTreeNode !== "function") {
    return;
  }
  const expand = expandTreeNode as TreeExpander;
  root.addEventListener("toggle", (event: Event) => {
    const node = event.target as DeferredDetails | null;
    if (!node?.open || !node.classList?.contains("data-node-deferred")) {
      return;
    }
    const placeholder = node.querySelector(":scope > .data-tree-placeholder");
    if (!placeholder) {
      return;
    }
    placeholder.innerHTML = expand(node.dataset.treeNode);
    placeholder.classList.remove("data-tree-placeholder");
    node.classList.remove("data-node-deferred");
    delete node.dataset.treeNode;
  }, true);
}

async function hydrateMermaid(root: ParentNode) {
  const frames = Array.from(root.querySelectorAll(".md-mermaid-output"))
    .filter((node) => node.dataset.rendered !== "true");
  if (frames.length === 0) {
    return;
  }
  const vendor = await loadVendor().catch(() => null);
  for (const output of frames) {
    const source = output.dataset.mermaidSource ?? "";
    if (!vendor?.renderMermaid) {
      markMermaidFailure(output);
      continue;
    }
    try {
      const rendered = await vendor.renderMermaid(source, `dashboard-mermaid-${++mermaidCounter}`);
      output.innerHTML = rendered.svg;
      output.dataset.rendered = "true";
    } catch {
      markMermaidFailure(output);
    }
  }
}

function hydrateToc(root: ParentNode) {
  root.querySelectorAll(".md-toc a").forEach((link) => {
    if (link.dataset.bound === "true") {
      return;
    }
    link.dataset.bound = "true";
    link.addEventListener("click", (event: Event) => {
      const href = link.getAttribute("href") ?? "";
      if (!href.startsWith("#")) {
        return;
      }
      const escapeSelector = globalThis.CSS?.escape;
      const target = root.querySelector(escapeSelector ? `#${escapeSelector(href.slice(1))}` : href);
      if (!target) {
        return;
      }
      event.preventDefault();
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  });
}

function markMathFailure(output: HTMLElement, source: string) {
  output.innerHTML = `<code>${escapeHtml(source)}</code><span class="rich-error">公式无法渲染</span>`;
}

function markMermaidFailure(output: HTMLElement) {
  output.textContent = "流程图无法渲染，可查看原文。";
  output.classList.add("rich-error");
  output.dataset.rendered = "true";
}

function loadVendor(): Promise<RichVendor> {
  if (!vendorPromise) {
    vendorPromise = import("./vendor/rich-renderers.js") as Promise<RichVendor>;
  }
  return vendorPromise;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: unknown) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
