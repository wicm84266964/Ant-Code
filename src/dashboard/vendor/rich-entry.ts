import katex from "katex";
import mermaid from "mermaid";
import { parse as parseYamlDocument } from "yaml";

let mermaidInitialized = false;

export function renderMath(source: unknown, options: Record<string, unknown> = {}) {
  return katex.renderToString(String(source ?? ""), {
    displayMode: options.displayMode === true,
    output: "html",
    strict: "ignore",
    throwOnError: false,
    trust: false
  });
}

export async function renderMermaid(source: unknown, id: unknown) {
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      securityLevel: "strict",
      theme: "dark",
      themeVariables: {
        background: "#161616",
        primaryColor: "#252726",
        primaryTextColor: "#ecefec",
        primaryBorderColor: "#555b56",
        lineColor: "#8c948e",
        secondaryColor: "#202322",
        tertiaryColor: "#111312",
        noteBkgColor: "#202322",
        noteTextColor: "#ecefec",
        noteBorderColor: "#555b56"
      }
    });
    mermaidInitialized = true;
  }
  return mermaid.render(typeof id === "string" ? id : String(id ?? ""), String(source ?? ""));
}

export function parseYaml(source: unknown) {
  return parseYamlDocument(String(source ?? ""), {
    prettyErrors: false,
    schema: "core"
  });
}
