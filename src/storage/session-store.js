import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TRANSCRIPT_CHUNK_SIZE = 50;
const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 100;
const MAX_TRANSCRIPT_PAGE_LIMIT = 200;
const TRANSCRIPT_VISIBLE_ROLES = new Set(["user", "assistant"]);

/**
 * @param {{ cwd: string; transcript?: Record<string, any>; env?: NodeJS.ProcessEnv }} options
 */
export function createSessionStore(options) {
  const root = path.join(options.cwd, ".lab-agent", "sessions");
  const policy = normalizeTranscriptPolicy(options.transcript);
  const env = options.env ?? process.env;

  return {
    root,
    assertReady() {
      assertPolicyReady(policy, env);
    },
    /**
     * @param {Record<string, any>} session
     */
    async writeMetadata(session) {
      if (!policy.enabled) {
        return null;
      }
      if (policy.retentionDays === 0) {
        return null;
      }

      await fs.mkdir(root, { recursive: true });
      const serialized = `${JSON.stringify(session, redactSession, 2)}\n`;
      const encrypted = encryptIfNeeded(serialized, policy, env);
      const filePath = path.join(root, `${session.id}.${encrypted ? "json.enc" : "json"}`);
      await fs.writeFile(filePath, encrypted ?? serialized, "utf8");
      return filePath;
    },

    /**
     * @param {number} retentionDays
     * @param {{ now?: Date }} cleanupOptions
     */
    async cleanupExpiredSessions(retentionDays, cleanupOptions = {}) {
      await fs.mkdir(root, { recursive: true });
      const entries = await fs.readdir(root, { withFileTypes: true });
      const nowMs = (cleanupOptions.now ?? new Date()).getTime();
      const maxAgeMs = Math.max(0, retentionDays) * 24 * 60 * 60 * 1000;
      const deleted = [];

      for (const entry of entries) {
        if (!entry.isFile() || !isSessionFile(entry.name)) {
          continue;
        }
        const filePath = path.join(root, entry.name);
        const stat = await fs.stat(filePath);
        const expired = retentionDays === 0 || nowMs - stat.mtimeMs > maxAgeMs;
        if (expired) {
          await fs.unlink(filePath);
          await removeTranscriptDirectory(root, sessionIdFromFileName(entry.name));
          deleted.push(filePath);
        }
      }

      return { deleted };
    },

    async listSessions() {
      await fs.mkdir(root, { recursive: true });
      const entries = await fs.readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && isSessionFile(entry.name))
        .map((entry) => path.join(root, entry.name));
    },

    /**
     * @param {string} selector
     */
    async deleteSession(selector) {
      await fs.mkdir(root, { recursive: true });
      const records = await this.listSessionRecords();
      const selected = selectRecord(records, selector);
      if (!selected) {
        return {
          ok: false,
          error: { code: "SESSION_NOT_FOUND", message: `No session metadata matched '${selector}'` }
        };
      }

      await fs.unlink(selected.path);
      await removeTranscriptDirectory(root, selected.id);
      return {
        ok: true,
        id: selected.id,
        deleted: [selected.path]
      };
    },

    async listSessionRecords() {
      await fs.mkdir(root, { recursive: true });
      const entries = await fs.readdir(root, { withFileTypes: true });
      const records = [];
      for (const entry of entries) {
        if (!entry.isFile() || !isSessionFile(entry.name)) {
          continue;
        }
        const filePath = path.join(root, entry.name);
        const stat = await fs.stat(filePath);
        records.push({
          id: sessionIdFromFileName(entry.name),
          path: filePath,
          encrypted: entry.name.endsWith(".json.enc"),
          modifiedAt: stat.mtime.toISOString(),
          bytes: stat.size,
          ...await readRecordSummary(filePath, entry.name.endsWith(".json.enc"), policy, env)
        });
      }
      return records.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    },

    /**
     * @param {string} selector
     */
    async readMetadata(selector = "latest") {
      await fs.mkdir(root, { recursive: true });
      const records = await this.listSessionRecords();
      const selected = selectRecord(records, selector);
      if (!selected) {
        return {
          ok: false,
          error: { code: "SESSION_NOT_FOUND", message: `No session metadata matched '${selector}'` }
        };
      }

      const raw = await fs.readFile(selected.path, "utf8");
      const decoded = decodeMetadata(raw, policy, env);
      if (!decoded.ok) {
        return decoded;
      }

      return {
        ok: true,
        path: selected.path,
        encrypted: selected.encrypted,
        metadata: decoded.metadata
      };
    },

    /**
     * Reads a fully-qualified session id without scanning or resolving prefixes.
     *
     * @param {string} sessionId
     */
    async readMetadataExact(sessionId) {
      let id;
      try {
        id = safeSessionId(sessionId);
      } catch (error) {
        return {
          ok: false,
          error: { code: "SESSION_ID_INVALID", message: error instanceof Error ? error.message : String(error) }
        };
      }
      await fs.mkdir(root, { recursive: true });
      for (const encrypted of [false, true]) {
        const filePath = path.join(root, `${id}.${encrypted ? "json.enc" : "json"}`);
        try {
          const raw = await fs.readFile(filePath, "utf8");
          const decoded = decodeMetadata(raw, policy, env);
          if (!decoded.ok) {
            return decoded;
          }
          if (String(decoded.metadata?.id ?? "") !== id) {
            return {
              ok: false,
              error: { code: "SESSION_METADATA_ID_MISMATCH", message: `Session metadata does not match '${id}'` }
            };
          }
          return { ok: true, path: filePath, encrypted, metadata: decoded.metadata };
        } catch (error) {
          if (error?.code !== "ENOENT") {
            return {
              ok: false,
              error: { code: "SESSION_METADATA_READ_ERROR", message: error instanceof Error ? error.message : String(error) }
            };
          }
        }
      }
      return {
        ok: false,
        error: { code: "SESSION_NOT_FOUND", message: `No session metadata matched '${id}'` }
      };
    },

    /**
     * @param {string | Record<string, any>} sessionOrArchive
     * @param {number} chunkIndex
     */
    async readTranscriptChunk(sessionOrArchive, chunkIndex) {
      await fs.mkdir(root, { recursive: true });
      const archive = typeof sessionOrArchive === "string"
        ? await resolveTranscriptArchiveForSession(this, sessionOrArchive)
        : normalizeTranscriptArchive(sessionOrArchive);
      if (!archive) {
        return {
          ok: false,
          error: { code: "TRANSCRIPT_ARCHIVE_NOT_FOUND", message: "No transcript archive is available for this session" }
        };
      }

      const index = positiveInteger(chunkIndex);
      const chunk = archive.chunks.find((item) => item.index === index);
      if (!chunk) {
        return {
          ok: false,
          error: { code: "TRANSCRIPT_CHUNK_NOT_FOUND", message: `No transcript chunk matched '${chunkIndex}'` }
        };
      }

      try {
        const filePath = safeStorePath(root, chunk.file);
        const raw = await fs.readFile(filePath, "utf8");
        const decoded = decodeMetadata(raw, policy, env);
        if (!decoded.ok) {
          return {
            ok: false,
            error: {
              code: "TRANSCRIPT_CHUNK_INVALID",
              message: `Transcript chunk '${chunk.file}' is invalid: ${decoded.error?.message ?? "decode failed"}`,
              cause: decoded.error?.code ?? null
            }
          };
        }
        const metadata = decoded.metadata ?? {};
        const messages = Array.isArray(metadata.messages) ? metadata.messages : [];
        if (Number(metadata.index) !== chunk.index || (chunk.messages > 0 && messages.length !== chunk.messages)) {
          return {
            ok: false,
            error: {
              code: "TRANSCRIPT_CHUNK_INVALID",
              message: `Transcript chunk '${chunk.file}' does not match its archive descriptor`
            }
          };
        }
        return {
          ok: true,
          path: filePath,
          encrypted: chunk.encrypted === true,
          chunk: {
            ...chunk,
            sessionId: metadata.sessionId,
            version: metadata.version,
            messages: messages.length
          },
          messages
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error?.code === "ENOENT" ? "TRANSCRIPT_CHUNK_MISSING" : "TRANSCRIPT_CHUNK_READ_ERROR",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    },

    /**
     * Reads only the chunks needed to cover the requested transcript cursor.
     * Cursor values are absolute message offsets so legacy archives remain readable.
     *
     * @param {string | Record<string, any>} sessionOrArchive
     * @param {{ before?: unknown; limit?: unknown; visibleRoles?: Iterable<string> }} pageOptions
     */
    async readTranscriptPage(sessionOrArchive, pageOptions = {}) {
      let archive;
      if (typeof sessionOrArchive === "string") {
        const metadata = await this.readMetadata(sessionOrArchive);
        if (!metadata.ok) {
          return metadata;
        }
        archive = normalizeTranscriptArchive(metadata.metadata?.transcript?.archive);
      } else {
        archive = normalizeTranscriptArchive(sessionOrArchive);
      }
      if (!archive || archive.chunks.length === 0) {
        return {
          ok: true,
          messages: [],
          positions: [],
          chunksRead: 0,
          summary: emptyTranscriptPageSummary(archive?.totalVisibleMessages ?? archive?.totalMessages ?? 0)
        };
      }

      const chunks = archive.chunks.slice().sort((left, right) => left.index - right.index);
      const ranges = transcriptChunkRanges(chunks);
      const totalMessages = ranges.at(-1)?.end ?? 0;
      const end = transcriptPageCursor(pageOptions.before, totalMessages);
      const limit = transcriptPageLimit(pageOptions.limit);
      const visibleRoles = new Set(pageOptions.visibleRoles ?? TRANSCRIPT_VISIBLE_ROLES);
      const entries = [];
      let chunksRead = 0;

      for (let rangeIndex = ranges.length - 1; rangeIndex >= 0 && entries.length < limit; rangeIndex -= 1) {
        const range = ranges[rangeIndex];
        if (range.start >= end || range.end <= 0) {
          continue;
        }
        const result = await this.readTranscriptChunk(archive, range.chunk.index);
        chunksRead += 1;
        if (!result.ok) {
          return { ...result, chunksRead };
        }
        const upper = Math.max(0, Math.min(result.messages.length, end - range.start));
        const chunkEntries = [];
        for (let index = 0; index < upper; index += 1) {
          const message = result.messages[index];
          if (visibleRoles.has(String(message?.role ?? ""))) {
            chunkEntries.push({ message, position: range.start + index });
          }
        }
        entries.unshift(...chunkEntries);
      }

      const selected = entries.slice(-limit);
      const start = selected[0]?.position ?? 0;
      const messages = selected.map((entry) => entry.message);
      const totalVisible = archive.totalVisibleMessages ?? totalMessages;
      const hasMore = messages.length > 0 && (
        entries.length > selected.length
        || ranges.some((range) => (
          range.end <= start
          && (range.chunk.visibleMessages === null ? range.end > 0 : range.chunk.visibleMessages > 0)
        ))
      );
      return {
        ok: true,
        messages,
        positions: selected.map((entry) => entry.position),
        chunksRead,
        summary: {
          cursor: hasMore ? String(start) : null,
          nextCursor: hasMore ? String(start) : null,
          hasMore,
          total: totalVisible,
          returned: messages.length,
          start,
          end
        }
      };
    },

    /**
     * @param {string} sessionId
     * @param {Array<Record<string, any>>} messages
     * @param {Record<string, any>} archive
     */
    async writeTranscriptChunks(sessionId, messages = [], archive = {}, options = {}) {
      if (!policy.enabled || policy.retentionDays === 0) {
        return normalizeTranscriptArchive(archive);
      }
      const pending = Array.isArray(messages) ? messages.filter(Boolean) : [];
      if (pending.length === 0) {
        return normalizeTranscriptArchive(archive);
      }

      await fs.mkdir(root, { recursive: true });
      const safeId = safeSessionId(sessionId);
      const suffix = safeArchiveSuffix(options.suffix);
      const dirName = `${safeId}.${suffix}`;
      const dirPath = path.join(root, dirName);
      await fs.mkdir(dirPath, { recursive: true });

      const nextArchive = normalizeTranscriptArchive(archive);
      const chunkSize = nextArchive.chunkSize;
      let totalMessages = nextArchive.totalMessages;
      let totalVisibleMessages = nextArchive.totalVisibleMessages;
      const chunks = nextArchive.chunks.slice();
      const encrypted = shouldEncrypt(policy, env);
      let remaining = pending.slice();

      while (remaining.length > 0) {
        let chunk = chunks[chunks.length - 1] ?? null;
        let existingMessages = [];
        if (chunk && chunk.messages < chunkSize) {
          existingMessages = await readTranscriptChunkMessages(root, chunk, policy, env);
        } else {
          chunk = null;
        }

        if (!chunk) {
          const index = chunks.length + 1;
          chunk = {
            index,
            file: transcriptChunkFileName(dirName, index, encrypted),
            messages: 0,
            visibleMessages: 0,
            bytes: 0,
            encrypted
          };
          chunks.push(chunk);
          existingMessages = [];
        }

        const room = Math.max(0, chunkSize - existingMessages.length);
        const addition = remaining.splice(0, room || chunkSize);
        const nextMessages = existingMessages.concat(addition).slice(0, chunkSize);
        const write = await writeTranscriptChunkFile(root, {
          sessionId: safeId,
          dirName,
          chunk,
          messages: nextMessages,
          encrypted,
          policy,
          env
        });

        chunk.file = write.file;
        chunk.messages = nextMessages.length;
        chunk.visibleMessages = countVisibleTranscriptMessages(nextMessages);
        chunk.bytes = write.bytes;
        chunk.encrypted = write.encrypted;
        totalMessages += addition.length;
        if (totalVisibleMessages !== null) {
          totalVisibleMessages += countVisibleTranscriptMessages(addition);
        }
      }

      return {
        version: 1,
        chunkSize,
        totalMessages,
        totalVisibleMessages,
        chunks
      };
    }
  };
}

async function resolveTranscriptArchiveForSession(store, selector) {
  const result = await store.readMetadata(selector);
  if (!result.ok) {
    return null;
  }
  return normalizeTranscriptArchive(result.metadata?.transcript?.archive);
}

async function readRecordSummary(filePath, encrypted, policy, env) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const decoded = decodeMetadata(raw, policy, env);
    if (!decoded.ok) {
      return {
        readable: false,
        readError: decoded.error?.code ?? "SESSION_METADATA_READ_ERROR"
      };
    }
    const metadata = decoded.metadata ?? {};
    return {
      readable: true,
      status: metadata.status ?? "unknown",
      title: sessionTitle(metadata),
      prompt: metadata.prompt ?? "",
      model: metadata.model ?? "",
      turnIndex: metadata.turnIndex,
      transcriptMessages: transcriptMessageCount(metadata),
      transcriptWindowMessages: Array.isArray(metadata.transcript?.messages) ? metadata.transcript.messages.length : 0,
      transcriptChunks: Array.isArray(metadata.transcript?.archive?.chunks) ? metadata.transcript.archive.chunks.length : 0,
      outputBytes: metadata.outputBytes,
      finishedAt: metadata.finishedAt,
      encrypted
    };
  } catch (error) {
    return {
      readable: false,
      readError: error instanceof Error ? error.message : String(error)
    };
  }
}

function transcriptMessageCount(metadata) {
  const total = Number(metadata?.transcript?.archive?.totalMessages);
  if (Number.isFinite(total) && total > 0) {
    return total;
  }
  return Array.isArray(metadata?.transcript?.messages) ? metadata.transcript.messages.length : 0;
}

function sessionTitle(metadata) {
  const explicit = stringOrEmpty(metadata.title ?? metadata.name);
  if (explicit) {
    return truncateTitle(explicit);
  }
  const firstUser = firstUserMessageText(metadata.transcript?.messages);
  if (firstUser) {
    return truncateTitle(firstUser);
  }
  const prompt = stringOrEmpty(metadata.prompt);
  if (prompt) {
    return truncateTitle(prompt);
  }
  return "";
}

function firstUserMessageText(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }
  const first = messages.find((message) => message?.role === "user");
  return stringOrEmpty(messageContentText(first?.content));
}

function messageContentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item && typeof item === "object" && "text" in item) {
      return String(item.text ?? "");
    }
    return "";
  }).filter(Boolean).join(" ");
}

function stringOrEmpty(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncateTitle(value) {
  const text = stringOrEmpty(value);
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

/**
 * @param {{ enabled: boolean; retentionDays: number; encryption: string }} policy
 * @param {NodeJS.ProcessEnv} env
 */
function assertPolicyReady(policy, env) {
  if (!policy.enabled || policy.retentionDays === 0) {
    return;
  }
  if (policy.encryption === "required" && !env.LAB_AGENT_TRANSCRIPT_KEY) {
    throw new Error("LAB_AGENT_TRANSCRIPT_KEY is required when transcript encryption is required");
  }
}

/**
 * @param {Record<string, any> | undefined} transcript
 */
function normalizeTranscriptPolicy(transcript = {}) {
  return {
    enabled: transcript.enabled !== false,
    retentionDays: Number.isFinite(transcript.retentionDays) ? transcript.retentionDays : 30,
    encryption: transcript.encryption ?? "off"
  };
}

/**
 * @param {string} plaintext
 * @param {{ encryption: string }} policy
 * @param {NodeJS.ProcessEnv} env
 */
function encryptIfNeeded(plaintext, policy, env) {
  if (!shouldEncrypt(policy, env)) {
    return null;
  }

  const rawKey = env.LAB_AGENT_TRANSCRIPT_KEY;
  if (!rawKey) {
    if (policy.encryption === "required") {
      assertPolicyReady({
        enabled: true,
        retentionDays: 1,
        encryption: policy.encryption
      }, env);
    }
    return null;
  }

  const iv = crypto.randomBytes(12);
  const key = deriveEncryptionKey(rawKey);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${JSON.stringify({
    version: "lab-agent-session.v1",
    encrypted: true,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  }, null, 2)}\n`;
}

function shouldEncrypt(policy, env) {
  if (policy.encryption === "off") {
    return false;
  }
  if (env.LAB_AGENT_TRANSCRIPT_KEY) {
    return true;
  }
  if (policy.encryption === "required") {
    assertPolicyReady({
      enabled: true,
      retentionDays: 1,
      encryption: policy.encryption
    }, env);
  }
  return false;
}

/**
 * @param {string} raw
 * @param {{ encryption: string }} policy
 * @param {NodeJS.ProcessEnv} env
 */
function decodeMetadata(raw, policy, env) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "SESSION_METADATA_PARSE_ERROR",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }

  if (!parsed?.encrypted) {
    return { ok: true, metadata: parsed };
  }

  const rawKey = env.LAB_AGENT_TRANSCRIPT_KEY;
  if (!rawKey) {
    return {
      ok: false,
      error: { code: "SESSION_METADATA_ENCRYPTED", message: "LAB_AGENT_TRANSCRIPT_KEY is required to read encrypted session metadata" }
    };
  }

  try {
    const iv = Buffer.from(parsed.iv, "base64");
    const tag = Buffer.from(parsed.tag, "base64");
    const ciphertext = Buffer.from(parsed.ciphertext, "base64");
    const key = deriveEncryptionKey(rawKey);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return { ok: true, metadata: JSON.parse(plaintext) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "SESSION_METADATA_DECRYPT_ERROR",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

/**
 * @param {string} rawKey
 */
function deriveEncryptionKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey, "utf8").digest();
}

/**
 * @param {string} name
 */
function isSessionFile(name) {
  return name.endsWith(".json") || name.endsWith(".json.enc");
}

/**
 * @param {string} name
 */
function sessionIdFromFileName(name) {
  return name.replace(/\.json(?:\.enc)?$/, "");
}

function safeSessionId(value) {
  return String(value ?? "session")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 120) || "session";
}

async function removeTranscriptDirectory(root, sessionId) {
  for (const suffix of ["transcript", "model-context"]) {
    const dirPath = path.join(root, `${safeSessionId(sessionId)}.${suffix}`);
    await fs.rm(dirPath, { recursive: true, force: true });
  }
}

function safeArchiveSuffix(value) {
  const suffix = String(value ?? "transcript").trim();
  return /^[A-Za-z0-9._-]+$/.test(suffix) ? suffix : "transcript";
}

function normalizeTranscriptArchive(archive = {}) {
  const chunkSize = positiveInteger(archive.chunkSize) ?? DEFAULT_TRANSCRIPT_CHUNK_SIZE;
  const chunks = Array.isArray(archive.chunks)
    ? archive.chunks.map(normalizeTranscriptChunk).filter(Boolean)
    : [];
  const totalFromChunks = chunks.reduce((sum, chunk) => sum + chunk.messages, 0);
  const totalMessages = positiveIntegerOrZero(archive.totalMessages) ?? totalFromChunks;
  const visibleFromChunks = chunks.reduce((sum, chunk) => sum + (chunk.visibleMessages ?? 0), 0);
  const chunksHaveVisibleCounts = chunks.every((chunk) => chunk.visibleMessages !== null);
  const totalVisibleMessages = positiveIntegerOrZero(archive.totalVisibleMessages)
    ?? (chunks.length === 0 ? 0 : chunksHaveVisibleCounts ? visibleFromChunks : null);
  return {
    version: 1,
    chunkSize,
    totalMessages,
    totalVisibleMessages,
    chunks
  };
}

function normalizeTranscriptChunk(chunk) {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }
  const index = positiveInteger(chunk.index);
  const file = typeof chunk.file === "string" ? chunk.file : "";
  if (!index || !file) {
    return null;
  }
  return {
    index,
    file,
    messages: positiveIntegerOrZero(chunk.messages) ?? 0,
    visibleMessages: positiveIntegerOrZero(chunk.visibleMessages),
    bytes: positiveIntegerOrZero(chunk.bytes) ?? 0,
    encrypted: chunk.encrypted === true || file.endsWith(".json.enc")
  };
}

function transcriptChunkFileName(dirName, index, encrypted) {
  const padded = String(index).padStart(6, "0");
  return `${dirName}/chunk-${padded}.${encrypted ? "json.enc" : "json"}`;
}

async function readTranscriptChunkMessages(root, chunk, policy, env) {
  try {
    const filePath = safeStorePath(root, chunk.file);
    const raw = await fs.readFile(filePath, "utf8");
    const decoded = decodeMetadata(raw, policy, env);
    if (!decoded.ok) {
      throw transcriptChunkError("TRANSCRIPT_CHUNK_INVALID", decoded.error?.message ?? "decode failed");
    }
    const messages = Array.isArray(decoded.metadata?.messages) ? decoded.metadata.messages : null;
    if (!messages || Number(decoded.metadata?.index) !== chunk.index || (chunk.messages > 0 && messages.length !== chunk.messages)) {
      throw transcriptChunkError("TRANSCRIPT_CHUNK_INVALID", `Chunk '${chunk.file}' does not match its archive descriptor`);
    }
    return messages;
  } catch (error) {
    if (error?.code === "TRANSCRIPT_CHUNK_INVALID") {
      throw error;
    }
    throw transcriptChunkError(
      error?.code === "ENOENT" ? "TRANSCRIPT_CHUNK_MISSING" : "TRANSCRIPT_CHUNK_READ_ERROR",
      error instanceof Error ? error.message : String(error)
    );
  }
}

function transcriptChunkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function transcriptChunkRanges(chunks) {
  let offset = 0;
  return chunks.map((chunk) => {
    const range = { chunk, start: offset, end: offset + chunk.messages };
    offset = range.end;
    return range;
  });
}

function transcriptPageLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    return DEFAULT_TRANSCRIPT_PAGE_LIMIT;
  }
  return Math.min(number, MAX_TRANSCRIPT_PAGE_LIMIT);
}

function transcriptPageCursor(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(number, fallback));
}

function emptyTranscriptPageSummary(total = 0) {
  return {
    cursor: null,
    nextCursor: null,
    hasMore: false,
    total,
    returned: 0,
    start: 0,
    end: 0
  };
}

function countVisibleTranscriptMessages(messages) {
  return Array.isArray(messages)
    ? messages.filter((message) => TRANSCRIPT_VISIBLE_ROLES.has(String(message?.role ?? ""))).length
    : 0;
}

async function writeTranscriptChunkFile(root, options) {
  const file = transcriptChunkFileName(options.dirName, options.chunk.index, options.encrypted);
  const filePath = safeStorePath(root, file);
  const payload = {
    version: "ant-code-transcript-chunk.v1",
    sessionId: options.sessionId,
    index: options.chunk.index,
    messages: options.messages
  };
  const serialized = `${JSON.stringify(payload, redactSession, 2)}\n`;
  const encrypted = encryptIfNeeded(serialized, options.policy, options.env);
  await fs.writeFile(filePath, encrypted ?? serialized, "utf8");
  return {
    file,
    encrypted: Boolean(encrypted),
    bytes: Buffer.byteLength(encrypted ?? serialized, "utf8")
  };
}

function safeStorePath(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const rootPath = path.resolve(root);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error("Transcript chunk path is outside the session store");
  }
  return resolved;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function positiveIntegerOrZero(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

/**
 * @param {Array<Record<string, any>>} records
 * @param {string} selector
 */
function selectRecord(records, selector) {
  if (records.length === 0) {
    return null;
  }
  if (!selector || selector === "latest") {
    return records[0];
  }

  const normalized = path.resolve(selector);
  const exact = records.find((record) => (
    record.id === selector ||
    record.path === selector ||
    path.resolve(record.path) === normalized
  ));
  if (exact) {
    return exact;
  }

  const prefixMatches = records.filter((record) => record.id.startsWith(selector));
  return prefixMatches.length === 1 ? prefixMatches[0] : null;
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function redactSession(key, value) {
  if (isContextTokenMetric(key, value)) {
    return value;
  }
  if (/api[_-]?key|secret|password|authorization|credential/i.test(key)) {
    return "[redacted]";
  }
  if (/(^|[_-])token($|[_-])|access[_-]?token|refresh[_-]?token|personal[_-]?access[_-]?token/i.test(key) && typeof value === "string") {
    return "[redacted]";
  }
  return value;
}

function isContextTokenMetric(key, value) {
  if (!Number.isFinite(value)) {
    return false;
  }
  const name = String(key ?? "");
  if (/access|refresh|personal|api|auth|credential|secret|password/i.test(name)) {
    return false;
  }
  return /tokens?|token[_-]?(?:count|estimate|budget|limit)/i.test(name);
}
