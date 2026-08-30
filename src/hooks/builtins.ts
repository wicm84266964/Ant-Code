import path from "node:path";
import { collectHookTargetPaths, summarizeHookPayload } from "./events.ts";

const SENSITIVE_BASENAME_PATTERNS = Object.freeze([
  /^\.env(?:\.|$)/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i,
  /credentials?/i,
  /secrets?/i,
  /tokens?/i,
  /private[._-]?key/i,
  /\.(?:pem|key|p12|pfx)$/i
]);

type BuiltinHookResult = {
  ok: boolean;
  message?: string;
  error?: { code: string; message: string };
};

type BuiltinHookHandler = (context: Record<string, unknown>) => BuiltinHookResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export const BUILTIN_HOOKS: Readonly<Record<string, BuiltinHookHandler>> = Object.freeze({
  auditToolUse,
  auditPermissionDenied,
  recordSensitiveFiles,
  denySensitiveFiles,
  recordFileChanged,
  recordTodoUpdated,
  recordSubagentLifecycle,
  auditDelegationGuard,
  compactAudit,
  auditSession,
  auditUserPrompt
});

export async function runBuiltinHook(name: string, context: Record<string, unknown>) {
  const hook = BUILTIN_HOOKS[name];
  if (!hook) {
    return {
      ok: false,
      error: { code: "HOOK_BUILTIN_NOT_FOUND", message: `Unknown builtin hook: ${name}` }
    };
  }
  return hook(context);
}

function auditToolUse(context: Record<string, unknown>) {
  return {
    ok: true,
    message: summarizeHookPayload(asRecord(context.payload))
  };
}

function auditPermissionDenied(context: Record<string, unknown>) {
  return {
    ok: true,
    message: summarizeHookPayload(asRecord(context.payload))
  };
}

function recordSensitiveFiles(context: Record<string, unknown>) {
  const payload = asRecord(context.payload);
  const paths = collectHookTargetPaths(asRecord(payload.input), asRecord(payload.result));
  const sensitive = paths.find((candidate) => isSensitivePath(candidate));
  if (!sensitive) {
    return { ok: true, message: "未命中敏感路径" };
  }
  return {
    ok: true,
    message: `敏感路径已命中，交由权限强确认处理：${safePathLabel(sensitive)}`
  };
}

function denySensitiveFiles(context: Record<string, unknown>) {
  return recordSensitiveFiles(context);
}

function recordFileChanged(context: Record<string, unknown>) {
  return {
    ok: true,
    message: summarizeHookPayload(asRecord(context.payload))
  };
}

function recordTodoUpdated(context: Record<string, unknown>) {
  return {
    ok: true,
    message: summarizeHookPayload(asRecord(context.payload))
  };
}

function recordSubagentLifecycle(context: Record<string, unknown>) {
  return {
    ok: true,
    message: summarizeHookPayload(asRecord(context.payload))
  };
}

function auditDelegationGuard(context: Record<string, unknown>) {
  return {
    ok: true,
    message: summarizeHookPayload(asRecord(context.payload))
  };
}

function compactAudit(context: Record<string, unknown>) {
  return {
    ok: true,
    message: summarizeHookPayload(asRecord(context.payload))
  };
}

function auditSession(context: Record<string, unknown>) {
  return {
    ok: true,
    message: summarizeHookPayload(asRecord(context.payload))
  };
}

function auditUserPrompt(context: Record<string, unknown>) {
  return {
    ok: true,
    message: summarizeHookPayload(asRecord(context.payload))
  };
}

function isSensitivePath(candidate: unknown) {
  const normalized = String(candidate ?? "").replace(/\\/g, "/");
  const base = path.basename(normalized).toLowerCase();
  return SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(base) || pattern.test(normalized));
}

function safePathLabel(candidate: unknown) {
  const normalized = String(candidate ?? "").replace(/\\/g, "/");
  return path.basename(normalized) || normalized;
}
