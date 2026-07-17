import fs from "node:fs/promises";
import path from "node:path";
import { ensureContainedDirectory, withFileMutationLock } from "../storage/durable-file.js";

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

  const timestamp = (options.now ?? new Date()).toISOString();
  const entry = `\n## ${timestamp}\n\n${text}\n`;
  const lexicalPath = path.join(options.cwd, PROJECT_MEMORY_PATH);
  const directory = await ensureContainedDirectory(options.cwd, path.dirname(lexicalPath));
  const filePath = path.join(directory, path.basename(lexicalPath));
  await withFileMutationLock(filePath, async () => {
    const handle = await fs.open(filePath, "a+", 0o600);
    try {
      const stat = await handle.stat();
      await handle.writeFile(`${stat.size === 0 ? "# Project Memory\n" : ""}${entry}`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });

  return {
    ok: true,
    path: filePath,
    bytesWritten: Buffer.byteLength(entry, "utf8")
  };
}

export function projectMemoryPath(cwd) {
  return path.join(cwd, PROJECT_MEMORY_PATH);
}
