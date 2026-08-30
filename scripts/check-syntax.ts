#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = Object.freeze(["src", "scripts", "tests"]);
const files: string[] = [];

for (const root of ROOTS) {
  for await (const file of walk(path.join(ROOT, root))) {
    if (file.includes(`${path.sep}vendor${path.sep}`)) continue;
    if (file.endsWith(".ts") && !file.endsWith(".d.ts")) {
      files.push(file);
    } else if (file.endsWith(".js") && !file.endsWith(`${path.sep}app.js`)) {
      files.push(file);
    }
  }
}

for (const file of files) {
  if (file.endsWith(".ts")) {
    const source = await fs.readFile(file, "utf8");
    const result = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: false
      },
      fileName: file,
      reportDiagnostics: true
    });
    const parseErrors = (result.diagnostics ?? []).filter((diag) => diag.category === ts.DiagnosticCategory.Error);
    if (parseErrors.length) {
      for (const diag of parseErrors) {
        process.stderr.write(`${ts.flattenDiagnosticMessageText(diag.messageText, "\n")}\n`);
      }
      process.stderr.write(`Syntax check failed: ${file}\n`);
      process.exitCode = 1;
      break;
    }
    continue;
  }
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exitCode = 1;
    break;
  }
}

if (!process.exitCode) {
  console.log(`Syntax check passed for ${files.length} files.`);
}

async function* walk(root: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}
