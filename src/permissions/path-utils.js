import path from "node:path";

export function normalizeToolPath(value) {
  let text = String(value ?? "").trim();
  for (let index = 0; index < 2; index += 1) {
    const first = text[0];
    const last = text[text.length - 1];
    if (text.length >= 2 && ((first === "\"" && last === "\"") || (first === "'" && last === "'") || (first === "`" && last === "`"))) {
      text = text.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return text;
}

export function resolveToolPath(cwd, targetPath) {
  return path.resolve(cwd, normalizeToolPath(targetPath));
}
