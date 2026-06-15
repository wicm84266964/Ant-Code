import fs from "node:fs/promises";
import path from "node:path";

const PROJECT_MEMORY_PATH = path.join(".lab-agent", "memory.md");
const MAX_MEMORY_ENTRY_BYTES = 8 * 1024;

/**
 * @param {{ cwd: string; text: string; now?: Date }} options
 */
export async function appendProjectMemory(options) {
  const text = options.text.trim();
  if (!text) {
    return { ok: false, error: { code: "MEMORY_EMPTY", message: "Memory entry must not be empty" } };
  }

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_MEMORY_ENTRY_BYTES) {
    return {
      ok: false,
      error: {
        code: "MEMORY_ENTRY_TOO_LARGE",
        message: `Memory entry exceeds ${MAX_MEMORY_ENTRY_BYTES} bytes`
      }
    };
  }

  const filePath = path.join(options.cwd, PROJECT_MEMORY_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const timestamp = (options.now ?? new Date()).toISOString();
  const entry = `\n## ${timestamp}\n\n${text}\n`;
  const existing = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "# Project Memory\n";
    }
    throw error;
  });

  await fs.writeFile(filePath, `${existing.replace(/\s*$/, "\n")}${entry}`, "utf8");

  return {
    ok: true,
    path: filePath,
    bytesWritten: Buffer.byteLength(entry, "utf8")
  };
}

export function projectMemoryPath(cwd) {
  return path.join(cwd, PROJECT_MEMORY_PATH);
}
