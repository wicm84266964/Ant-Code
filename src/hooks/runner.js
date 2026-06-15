import { spawn } from "node:child_process";
import { recordHookAudit, updateHookAudit } from "./audit-store.js";
import { createHookPayload, eventMayBlock, summarizeHookPayload, truncateText } from "./events.js";
import { formatHookType, matchHooks } from "./registry.js";
import { runBuiltinHook } from "./builtins.js";

let runningDepth = 0;

export async function runHooks(options = {}) {
  const event = options.event;
  if (!event || runningDepth > 0 || options.skipHooks === true) {
    return { ok: true, blocked: false, results: [] };
  }
  const config = options.config ?? {};
  const cwd = options.cwd ?? options.payload?.cwd ?? process.cwd();
  const payload = createHookPayload(event, options.payload ?? {}, {
    cwd,
    sessionId: options.sessionId,
    taskId: options.taskId
  });
  const hooks = matchHooks(config, event, payload, { cwd });
  if (hooks.length === 0) {
    return { ok: true, blocked: false, results: [] };
  }

  runningDepth += 1;
  const results = [];
  try {
    for (const hook of hooks) {
      const hookOptions = {
        hook,
        payload,
        cwd,
        env: options.env,
        hooksTrusted: options.hooksTrusted === true,
        onRecord: options.onRecord
      };
      const shouldAwait = shouldAwaitHook(hook, {
        event,
        hooksTrusted: options.hooksTrusted === true,
        awaitNonBlockingCommandHooks: options.awaitNonBlockingCommandHooks === true
      });
      if (!shouldAwait) {
        const scheduled = recordHookAudit({
          event: hook.event,
          name: hook.name,
          type: formatHookType(hook),
          source: hook.source,
          ok: true,
          blocking: hook.blocking === true,
          status: "running",
          durationMs: 0,
          message: "后台 command hook 正在运行",
          payloadSummary: summarizeHookPayload(payload)
        });
        void runOneHook({ ...hookOptions, auditRecordId: scheduled.id, background: true }).catch((error) => {
          updateHookAudit(scheduled.id, {
            ok: false,
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
            error: { code: "HOOK_ASYNC_ERROR", message: error instanceof Error ? error.message : String(error) }
          });
        });
        results.push({
          ok: true,
          scheduled: true,
          hook: hook.name,
          event: hook.event,
          auditRecordId: scheduled.id,
          durationMs: 0,
          message: "non-blocking command hook scheduled asynchronously"
        });
        continue;
      }

      const result = await runOneHook(hookOptions);
      results.push(result);
      if (result.blocked && hook.blocking && eventMayBlock(event)) {
        return {
          ok: false,
          blocked: true,
          blockingError: result.error ?? { code: "HOOK_BLOCKED", message: result.message || `${hook.name} blocked ${event}` },
          results
        };
      }
    }
  } finally {
    runningDepth -= 1;
  }

  return {
    ok: results.every((result) => result.ok || result.skipped),
    blocked: false,
    results
  };
}

async function runOneHook(options) {
  const started = Date.now();
  const { hook, payload } = options;
  let result;
  try {
    if (hook.type === "command") {
      result = options.hooksTrusted
        ? await runCommandHook(hook, options)
        : {
          ok: true,
          skipped: true,
          message: "项目 command hook 因工作区未传入 trusted=true 而跳过"
        };
    } else {
      result = await runBuiltinHook(hook.builtin, {
        hook,
        payload,
        cwd: options.cwd,
        env: options.env
      });
    }
  } catch (error) {
    result = {
      ok: false,
      error: {
        code: "HOOK_RUNTIME_ERROR",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
  const durationMs = Date.now() - started;
  const auditRecord = {
    event: hook.event,
    name: hook.name,
    type: formatHookType(hook),
    source: hook.source,
    ok: result.ok === true,
    skipped: result.skipped === true,
    blocked: result.blocked === true,
    blocking: hook.blocking === true,
    status: result.skipped === true ? "skipped" : result.blocked === true ? "blocked" : result.ok === true ? "completed" : "failed",
    durationMs,
    message: result.message ?? result.error?.message ?? "",
    output: result.output ?? "",
    outputTruncated: result.outputTruncated === true,
    error: result.error ?? null,
    payloadSummary: summarizeHookPayload(payload)
  };
  const record = options.auditRecordId
    ? updateHookAudit(options.auditRecordId, auditRecord)
    : recordHookAudit(auditRecord);
  await options.onRecord?.(record);
  return {
    ...result,
    hook: hook.name,
    event: hook.event,
    durationMs
  };
}

function shouldAwaitHook(hook, options = {}) {
  if (hook.type !== "command") {
    return true;
  }
  if (!options.hooksTrusted) {
    return true;
  }
  if (hook.blocking && eventMayBlock(options.event)) {
    return true;
  }
  return options.awaitNonBlockingCommandHooks === true;
}

async function runCommandHook(hook, options) {
  const command = String(hook.command ?? "").trim();
  if (!command) {
    return {
      ok: false,
      error: { code: "HOOK_COMMAND_EMPTY", message: "command hook is empty" }
    };
  }
  const env = buildHookEnv(options.env ?? process.env, hook.envAllowlist);
  env.ANT_CODE_HOOK_EVENT = hook.event;
  env.ANT_CODE_HOOK_NAME = hook.name;
  env.ANT_CODE_HOOK_PAYLOAD = JSON.stringify(options.payload);

  const shell = process.platform === "win32" ? "powershell.exe" : "bash";
  const args = process.platform === "win32"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
    : ["-lc", command];
  const maxOutputBytes = hook.maxOutputBytes;

  return new Promise((resolve) => {
    const child = spawn(shell, args, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputTruncated = false;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({
        ok: false,
        output: truncateText([stdout, stderr].filter(Boolean).join("\n"), maxOutputBytes),
        outputTruncated,
        error: { code: "HOOK_TIMEOUT", message: `hook command timed out after ${hook.timeoutMs}ms` }
      });
    }, hook.timeoutMs);
    if (options.background === true) {
      timeout.unref?.();
      child.unref?.();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
    }

    const append = (kind, chunk) => {
      const text = Buffer.from(chunk).toString("utf8");
      const bytes = Buffer.byteLength(text, "utf8");
      if (outputBytes + bytes > maxOutputBytes) {
        outputTruncated = true;
      }
      outputBytes += bytes;
      if (kind === "stdout") {
        stdout = truncateText(stdout + text, maxOutputBytes);
      } else {
        stderr = truncateText(stderr + text, maxOutputBytes);
      }
    };

    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        error: { code: "HOOK_COMMAND_ERROR", message: error.message }
      });
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const output = truncateText([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"), maxOutputBytes);
      resolve({
        ok: code === 0,
        output,
        outputTruncated,
        message: code === 0 ? "command hook completed" : `command hook exited code=${code} signal=${signal ?? "none"}`,
        error: code === 0 ? null : { code: "HOOK_COMMAND_EXIT", message: `command hook exited code=${code} signal=${signal ?? "none"}` }
      });
    });
  });
}

function buildHookEnv(source, allowlist = []) {
  const env = {};
  const allowed = new Set(allowlist);
  for (const key of allowed) {
    if (source[key] !== undefined && !looksSensitiveKey(key)) {
      env[key] = source[key];
    }
  }
  return env;
}

function looksSensitiveKey(key) {
  return /token|secret|password|api_?key|apikey|credential|authorization|cookie/i.test(String(key ?? ""));
}
