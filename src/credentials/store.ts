import fs from "node:fs/promises";
import path from "node:path";
import {
  ConfigRevisionConflictError,
  mutateJsonConfig,
  readJsonConfigSnapshot
} from "../dashboard/config-store.ts";

const CREDENTIAL_STORE_VERSION = 1;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const FORBIDDEN_REFERENCES = new Set(["__proto__", "prototype", "constructor"]);

export { ConfigRevisionConflictError };

/**
 * Store credentials separately from model configuration. Only resolve() is
 * allowed to return a plaintext value; all mutation and descriptor results are
 * safe to serialize.
 *
 * @param {{ filePath: string }} options
 */
export function createCredentialStore({ filePath }: { filePath: string }) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new TypeError("filePath must be a non-empty string");
  }
  const target = path.resolve(filePath);

  return Object.freeze({
    path: target,

    /**
     * Trusted runtime boundary for retrieving a plaintext credential.
     * @param {string} reference
     */
    async resolve(reference: string) {
      validateReference(reference);
      const snapshot = await readJsonConfigSnapshot(target);
      const value = credentialMap(snapshot.data)[reference];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },

    /**
     * @param {string} reference
     * @param {string} secret
     * @param {{ expectedRevision?: string }} [options]
     */
    async set(reference: string, secret: string, options: { expectedRevision?: string } = {}) {
      validateReference(reference);
      validateSecret(secret);
      validateMutationOptions(options);
      await ensureCredentialDirectory(target);

      const written = await mutateJsonConfig(target, (document, context) => {
        assertExpectedRevision(options.expectedRevision, context.revision);
        const credentials = copyCredentialMap(document);
        credentials[reference] = secret;
        return {
          ...document,
          version: CREDENTIAL_STORE_VERSION,
          credentials
        };
      });

      return mutationDescriptor(written, reference, true);
    },

    /**
     * @param {string} reference
     * @param {{ expectedRevision?: string }} [options]
     */
    async clear(reference: string, options: { expectedRevision?: string } = {}) {
      validateReference(reference);
      validateMutationOptions(options);
      await ensureCredentialDirectory(target);

      const written = await mutateJsonConfig(target, (document, context) => {
        assertExpectedRevision(options.expectedRevision, context.revision);
        const credentials = copyCredentialMap(document);
        delete credentials[reference];
        return {
          ...document,
          version: CREDENTIAL_STORE_VERSION,
          credentials
        };
      });

      return mutationDescriptor(written, reference, false);
    },

    /** @param {string} reference */
    async describe(reference: string) {
      validateReference(reference);
      const snapshot = await readJsonConfigSnapshot(target);
      const value = credentialMap(snapshot.data)[reference];
      return {
        path: target,
        exists: snapshot.exists,
        revision: snapshot.revision,
        reference,
        configured: typeof value === "string" && value.length > 0
      };
    },

    async describeAll() {
      const snapshot = await readJsonConfigSnapshot(target);
      const references = Object.entries(credentialMap(snapshot.data))
        .filter(([reference, value]) => isValidReference(reference) && typeof value === "string" && value.length > 0)
        .map(([reference]) => ({ reference, configured: true }))
        .sort((left, right) => left.reference.localeCompare(right.reference));
      return {
        path: target,
        exists: snapshot.exists,
        revision: snapshot.revision,
        credentials: references
      };
    }
  });
}

/** @param {string} target */
async function ensureCredentialDirectory(target: string) {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => {});
}

/** @param {unknown} reference */
function validateReference(reference: unknown) {
  if (!isValidReference(reference)) {
    throw new TypeError("Credential reference contains unsupported characters");
  }
}

/** @param {unknown} reference */
function isValidReference(reference: unknown) {
  return typeof reference === "string"
    && REFERENCE_PATTERN.test(reference)
    && !FORBIDDEN_REFERENCES.has(reference);
}

/** @param {unknown} secret */
function validateSecret(secret: unknown) {
  if (typeof secret !== "string" || !secret.trim()) {
    throw new TypeError("Credential value must be a non-empty string");
  }
}

/** @param {unknown} options */
function validateMutationOptions(options: Record<string, unknown>) {
  if (!isPlainObject(options)) {
    throw new TypeError("Credential mutation options must be an object");
  }
  if (
    options.expectedRevision !== undefined
    && (typeof options.expectedRevision !== "string" || !options.expectedRevision)
  ) {
    throw new TypeError("expectedRevision must be a non-empty string");
  }
}

/** @param {string | undefined} expected @param {string} actual */
function assertExpectedRevision(expected: string | undefined, actual: string) {
  if (expected !== undefined && expected !== actual) {
    throw new ConfigRevisionConflictError();
  }
}

/** @param {Record<string, any>} document */
function credentialMap(document: Record<string, unknown>) {
  return isPlainObject(document.credentials) ? document.credentials : {};
}

/** @param {Record<string, any>} document */
function copyCredentialMap(document: Record<string, unknown>) {
  return Object.assign(Object.create(null), credentialMap(document));
}

/**
 * @param {{ path: string, previousRevision: string, revision: string }} written
 * @param {string} reference
 * @param {boolean} configured
 */
function mutationDescriptor(written: { path: string, previousRevision: string, revision: string }, reference: string, configured: boolean) {
  return {
    path: written.path,
    exists: true,
    previousExists: written.previousRevision !== "missing",
    previousRevision: written.previousRevision,
    revision: written.revision,
    reference,
    configured
  };
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
