#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_VENDOR_DIR = path.join(ROOT, "src", "dashboard", "public", "vendor");
const RICH_BUNDLE_PATH = path.join(PUBLIC_VENDOR_DIR, "rich-renderers.js");

await fs.mkdir(PUBLIC_VENDOR_DIR, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(ROOT, "src", "dashboard", "vendor", "rich-entry.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: false,
  outfile: RICH_BUNDLE_PATH,
  logLevel: "silent"
});
await normalizeGeneratedText(RICH_BUNDLE_PATH);

const katexCss = await fs.readFile(path.join(ROOT, "node_modules", "katex", "dist", "katex.min.css"), "utf8");
await fs.writeFile(path.join(PUBLIC_VENDOR_DIR, "katex.min.css"), rewriteKatexFontUrls(katexCss), "utf8");

const fontSource = path.join(ROOT, "node_modules", "katex", "dist", "fonts");
const fontTarget = path.join(PUBLIC_VENDOR_DIR, "fonts");
await fs.mkdir(fontTarget, { recursive: true });
const fontEntries = await fs.readdir(fontSource, { withFileTypes: true });
for (const entry of fontEntries) {
  if (entry.isFile()) {
    await fs.copyFile(path.join(fontSource, entry.name), path.join(fontTarget, entry.name));
  }
}

console.log("Dashboard rich rendering assets built.");

function rewriteKatexFontUrls(css) {
  return css.replace(/url\(fonts\//g, "url(/assets/vendor/fonts/");
}

async function normalizeGeneratedText(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  await fs.writeFile(filePath, text.replace(/[ \t]+$/gm, ""), "utf8");
}
