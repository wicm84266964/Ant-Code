import path from "node:path";
import {
  ConfigRevisionConflictError,
  mutateJsonConfig,
  readJsonConfigSnapshot
} from "../dashboard/config-store.ts";

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_PATH_SEGMENTS = 64;
const MAX_PATH_SEGMENT_LENGTH = 256;
const MAX_ARRAY_INDEX = 100_000;
const REDACTED_VALUE = "[REDACTED]";

type JsonObject = Record<string, unknown>;
type JsonContainer = JsonObject | unknown[];
type DescriptorField = {
  path: string[];
  exists: boolean;
  value?: unknown;
};
type SetEntry = {
  path: string[];
  value: unknown;
};
type NamedPath = {
  name: string;
  path: string[];
};

export { ConfigRevisionConflictError };

/**
 * A revisioned JSON-file repository. Callers patch only fields owned by their
 * form instead of reconstructing a configuration from a merged runtime view.
 *
 * @param {{ filePath: string }} options
 */
export function createFileRepository({ filePath }: { filePath: string }) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new TypeError("filePath must be a non-empty string");
  }
  const target = path.resolve(filePath);

  return Object.freeze({
    path: target,

    async read() {
      const snapshot = await readJsonConfigSnapshot(target);
      return { ...snapshot, path: target };
    },

    /**
     * Replace the raw document after a revision check. This is reserved for
     * whole-document reset and one-way migration; redacted UI callers use
     * patch() so fields they never received cannot be deleted.
     *
     * @param {Record<string, unknown>} document
     * @param {{ expectedRevision?: string }} [options]
     */
    async replace(document: Record<string, unknown>, options: { expectedRevision?: string } = {}) {
      if (!isPlainObject(document) || !isPlainObject(options)) {
        throw new TypeError("Configuration replacement must be a JSON object");
      }
      validateExpectedRevision(options.expectedRevision);
      const replacement = cloneJsonValue(document);
      const written = await mutateJsonConfig(target, (_current, context) => {
        if (options.expectedRevision !== undefined && context.revision !== options.expectedRevision) {
          throw new ConfigRevisionConflictError();
        }
        return replacement;
      });
      return {
        path: written.path,
        exists: true,
        previousExists: written.previousRevision !== "missing",
        previousRevision: written.previousRevision,
        revision: written.revision
      };
    },

    /**
     * @param {{ expectedRevision?: string, set?: Record<string, unknown> | Array<{ path: string | string[], value: unknown } | [string | string[], unknown]>, unset?: Array<string | string[]> }} changes
     */
    async patch(changes: { expectedRevision?: string, set?: Record<string, unknown> | Array<{ path: string | string[], value: unknown } | [string | string[], unknown]>, unset?: Array<string | string[]> }) {
      if (!isPlainObject(changes)) {
        throw new TypeError("Configuration patch must be an object");
      }
      validateExpectedRevision(changes.expectedRevision);
      const setEntries = normalizeSetEntries(changes.set);
      const unsetPaths = normalizeUnsetPaths(changes.unset);

      const written = await mutateJsonConfig(target, (document, context) => {
        if (
          changes.expectedRevision !== undefined
          && context.revision !== changes.expectedRevision
        ) {
          throw new ConfigRevisionConflictError();
        }
        for (const entry of setEntries) {
          setAtPath(document, entry.path, cloneJsonValue(entry.value));
        }
        for (const fieldPath of unsetPaths) {
          unsetAtPath(document, fieldPath);
        }
        return document;
      });

      return {
        path: written.path,
        exists: true,
        previousExists: written.previousRevision !== "missing",
        previousRevision: written.previousRevision,
        revision: written.revision
      };
    },

    /**
     * Return serialization-safe metadata and explicitly selected fields. Keys
     * that look like credentials are always redacted, even when selected.
     *
     * @param {{ select?: Array<string | string[]> | Record<string, string | string[]>, redact?: Array<string | string[]> }} [options]
     */
    async describe(options: { select?: Array<string | string[]> | Record<string, string | string[]>, redact?: Array<string | string[]> } = {}) {
      if (!isPlainObject(options)) {
        throw new TypeError("Descriptor options must be an object");
      }
      const selections = normalizeSelections(options.select);
      const redactions = normalizeRedactions(options.redact);
      const snapshot = await readJsonConfigSnapshot(target);
      const fields: Record<string, DescriptorField> = Object.create(null) as Record<string, DescriptorField>;

      for (const selection of selections) {
        const selected = readAtPath(snapshot.data, selection.path);
        const field: DescriptorField = {
          path: [...selection.path],
          exists: selected.exists
        };
        if (selected.exists) {
          field.value = sanitizeDescriptorValue(selected.value, selection.path, redactions);
        }
        fields[selection.name] = field;
      }

      return {
        path: target,
        exists: snapshot.exists,
        revision: snapshot.revision,
        ...(selections.length > 0 ? { fields } : {})
      };
    }
  });
}

/** @param {unknown} value */
function validateExpectedRevision(value: unknown) {
  if (value !== undefined && (typeof value !== "string" || !value)) {
    throw new TypeError("expectedRevision must be a non-empty string");
  }
}

/**
 * @param {unknown} set
 * @returns {Array<{ path: string[], value: unknown }>}
 */
function normalizeSetEntries(set: unknown): SetEntry[] {
  if (set === undefined) {
    return [];
  }
  if (Array.isArray(set)) {
    return set.map((entry) => {
      if (Array.isArray(entry) && entry.length === 2) {
        return { path: normalizeConfigPath(entry[0]), value: entry[1] };
      }
      if (isPlainObject(entry) && Object.hasOwn(entry, "path") && Object.hasOwn(entry, "value")) {
        return { path: normalizeConfigPath(entry.path), value: entry.value };
      }
      throw new TypeError("set entries must contain a path and value");
    });
  }
  if (!isPlainObject(set)) {
    throw new TypeError("set must be an object or an array of path/value entries");
  }
  return Object.entries(set).map(([fieldPath, value]) => ({
    path: normalizeConfigPath(fieldPath),
    value
  }));
}

/**
 * @param {unknown} unset
 * @returns {string[][]}
 */
function normalizeUnsetPaths(unset: unknown): string[][] {
  if (unset === undefined) {
    return [];
  }
  if (!Array.isArray(unset)) {
    throw new TypeError("unset must be an array of paths");
  }
  return unset.map(normalizeConfigPath);
}

/**
 * @param {unknown} select
 * @returns {Array<{ name: string, path: string[] }>}
 */
function normalizeSelections(select: unknown): NamedPath[] {
  if (select === undefined) {
    return [];
  }
  if (Array.isArray(select)) {
    return select.map((fieldPath) => {
      const normalized = normalizeConfigPath(fieldPath);
      return { name: normalized.join("."), path: normalized };
    });
  }
  if (!isPlainObject(select)) {
    throw new TypeError("select must be an array of paths or a name-to-path object");
  }
  return Object.entries(select).map(([name, fieldPath]) => {
    if (!name || FORBIDDEN_PATH_SEGMENTS.has(name)) {
      throw new TypeError("Descriptor field names must be safe non-empty strings");
    }
    return { name, path: normalizeConfigPath(fieldPath) };
  });
}

/**
 * @param {unknown} redact
 * @returns {string[][]}
 */
function normalizeRedactions(redact: unknown): string[][] {
  if (redact === undefined) {
    return [];
  }
  if (!Array.isArray(redact)) {
    throw new TypeError("redact must be an array of paths");
  }
  return redact.map(normalizeConfigPath);
}

/**
 * @param {unknown} fieldPath
 * @returns {string[]}
 */
function normalizeConfigPath(fieldPath: unknown): string[] {
  const segments = typeof fieldPath === "string"
    ? fieldPath.split(".")
    : Array.isArray(fieldPath) ? [...fieldPath] : null;
  if (!segments || segments.length === 0 || segments.length > MAX_PATH_SEGMENTS) {
    throw new TypeError("Configuration paths must contain between 1 and 64 segments");
  }
  return segments.map((segment) => {
    if (
      typeof segment !== "string"
      || !segment
      || segment.length > MAX_PATH_SEGMENT_LENGTH
      || FORBIDDEN_PATH_SEGMENTS.has(segment)
    ) {
      throw new TypeError("Configuration path contains an invalid segment");
    }
    return segment;
  });
}

function readContainer(container: JsonContainer, key: string | number): unknown {
  return Array.isArray(container) ? container[Number(key)] : container[String(key)];
}

function writeContainer(container: JsonContainer, key: string | number, value: unknown) {
  if (Array.isArray(container)) {
    container[Number(key)] = value;
    return;
  }
  container[String(key)] = value;
}

/**
 * @param {Record<string, any>} document
 * @param {string[]} fieldPath
 * @param {unknown} value
 */
function setAtPath(document: JsonObject, fieldPath: string[], value: unknown) {
  let cursor: JsonContainer = document;
  for (let index = 0; index < fieldPath.length - 1; index += 1) {
    const segment = fieldPath[index];
    const nextSegment = fieldPath[index + 1];
    const key = containerKey(cursor, segment);
    const child = readContainer(cursor, key);
    if (!isContainer(child)) {
      writeContainer(cursor, key, isArrayIndex(nextSegment) ? [] : {});
    }
    const next = readContainer(cursor, key);
    cursor = isContainer(next) ? next : {};
  }
  writeContainer(cursor, containerKey(cursor, fieldPath.at(-1)), value);
}

/**
 * @param {Record<string, any>} document
 * @param {string[]} fieldPath
 */
function unsetAtPath(document: JsonObject, fieldPath: string[]) {
  let cursor: JsonContainer = document;
  for (let index = 0; index < fieldPath.length - 1; index += 1) {
    const segment = fieldPath[index];
    if (!isContainer(cursor)) {
      return;
    }
    const key = containerKey(cursor, segment);
    const child = readContainer(cursor, key);
    if (!Object.hasOwn(cursor, key) || !isContainer(child)) {
      return;
    }
    cursor = child;
  }
  if (!isContainer(cursor)) {
    return;
  }
  const key = containerKey(cursor, fieldPath.at(-1));
  if (Array.isArray(cursor)) {
    const index = Number(key);
    if (index < cursor.length) {
      cursor.splice(index, 1);
    }
    return;
  }
  delete cursor[String(key)];
}

/**
 * @param {unknown} document
 * @param {string[]} fieldPath
 */
function readAtPath(document: unknown, fieldPath: string[]): { exists: boolean; value: unknown } {
  let cursor: unknown = document;
  for (const segment of fieldPath) {
    if (!isContainer(cursor)) {
      return { exists: false, value: undefined };
    }
    const key = containerKey(cursor, segment);
    if (!Object.hasOwn(cursor, key)) {
      return { exists: false, value: undefined };
    }
    cursor = readContainer(cursor, key);
  }
  return { exists: true, value: cursor };
}

/**
 * @param {unknown} value
 * @param {string[]} currentPath
 * @param {string[][]} redactions
 * @returns {unknown}
 */
function sanitizeDescriptorValue(value: unknown, currentPath: string[], redactions: string[][]): unknown {
  if (isSensitivePath(currentPath) || redactions.some((redactionPath) => isPathPrefix(redactionPath, currentPath))) {
    return REDACTED_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeDescriptorValue(item, [...currentPath, String(index)], redactions));
  }
  if (isPlainObject(value)) {
    const sanitized: JsonObject = Object.create(null) as JsonObject;
    for (const [key, child] of Object.entries(value)) {
      sanitized[key] = sanitizeDescriptorValue(child, [...currentPath, key], redactions);
    }
    return sanitized;
  }
  return value;
}

/** @param {string[]} fieldPath */
function isSensitivePath(fieldPath: string[]) {
  return fieldPath.some((segment) => {
    const normalized = segment.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalized === "authorization"
      || normalized === "password"
      || normalized === "credential"
      || normalized === "credentials"
      || normalized.endsWith("apikey")
      || normalized.endsWith("token")
      || normalized.endsWith("secret");
  });
}

/** @param {string[]} prefix @param {string[]} value */
function isPathPrefix(prefix: string[], value: string[]) {
  return prefix.length <= value.length && prefix.every((segment, index) => segment === value[index]);
}

/**
 * @param {Record<string, any> | any[]} container
 * @param {string | undefined} segment
 * @returns {string | number}
 */
function containerKey(container: JsonContainer, segment: string | undefined): string | number {
  if (segment === undefined) {
    throw new TypeError("Configuration path is incomplete");
  }
  if (!Array.isArray(container)) {
    return segment;
  }
  if (!isArrayIndex(segment)) {
    throw new TypeError("Array configuration paths must use bounded numeric indexes");
  }
  return Number(segment);
}

/** @param {string} segment */
function isArrayIndex(segment: string) {
  return /^(0|[1-9]\d*)$/.test(segment) && Number(segment) <= MAX_ARRAY_INDEX;
}

/** @param {unknown} value @returns {any} */
function cloneJsonValue<T>(value: T): T {
  if (value === undefined) {
    throw new TypeError("Configuration values must be JSON serializable");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Configuration values must be JSON serializable");
  }
  if (serialized === undefined) {
    throw new TypeError("Configuration values must be JSON serializable");
  }
  return JSON.parse(serialized) as T;
}

/** @param {unknown} value @returns {value is Record<string, any> | any[]} */
function isContainer(value: unknown): value is JsonContainer {
  return Boolean(value) && typeof value === "object";
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
