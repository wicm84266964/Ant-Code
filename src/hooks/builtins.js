import path from "node:path";
import { collectHookTargetPaths, summarizeHookPayload } from "./events.js";

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

export const BUILTIN_HOOKS = Object.freeze({
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

export async function runBuiltinHook(name, context) {
  const hook = BUILTIN_HOOKS[name];
  if (!hook) {
    return {
      ok: false,
      error: { code: "HOOK_BUILTIN_NOT_FOUND", message: `Unknown builtin hook: ${name}` }
    };
  }
  return hook(context);
}

function auditToolUse(context) {
  return {
    ok: true,
    message: summarizeHookPayload(context.payload)
  };
}

function auditPermissionDenied(context) {
  return {
    ok: true,
    message: summarizeHookPayload(context.payload)
  };
}

function recordSensitiveFiles(context) {
  const payload = context.payload ?? {};
  const paths = collectHookTargetPaths(payload.input, payload.result);
  const sensitive = paths.find((candidate) => isSensitivePath(candidate));
  if (!sensitive) {
    return { ok: true, message: "未命中敏感路径" };
  }
  return {
    ok: true,
    message: `敏感路径已命中，交由权限强确认处理：${safePathLabel(sensitive)}`
  };
}

function denySensitiveFiles(context) {
  return recordSensitiveFiles(context);
}

function recordFileChanged(context) {
  return {
    ok: true,
    message: summarizeHookPayload(context.payload)
  };
}

function recordTodoUpdated(context) {
  return {
    ok: true,
    message: summarizeHookPayload(context.payload)
  };
}

function recordSubagentLifecycle(context) {
  return {
    ok: true,
    message: summarizeHookPayload(context.payload)
  };
}

function auditDelegationGuard(context) {
  return {
    ok: true,
    message: summarizeHookPayload(context.payload)
  };
}

function compactAudit(context) {
  return {
    ok: true,
    message: summarizeHookPayload(context.payload)
  };
}

function auditSession(context) {
  return {
    ok: true,
    message: summarizeHookPayload(context.payload)
  };
}

function auditUserPrompt(context) {
  return {
    ok: true,
    message: summarizeHookPayload(context.payload)
  };
}

function isSensitivePath(candidate) {
  const normalized = String(candidate ?? "").replace(/\\/g, "/");
  const base = path.basename(normalized).toLowerCase();
  return SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(base) || pattern.test(normalized));
}

function safePathLabel(candidate) {
  const normalized = String(candidate ?? "").replace(/\\/g, "/");
  return path.basename(normalized) || normalized;
}
