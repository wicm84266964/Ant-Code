import { listHookAudit, summarizeHookAudit } from "./audit-store.ts";
import { HOOK_EVENTS } from "./events.ts";
import { formatHookType, getHookSettings, listConfiguredHooks } from "./registry.ts";

type ConfiguredHook = ReturnType<typeof listConfiguredHooks>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function hookTypeLabel(hook: ConfiguredHook) {
  return formatHookType({
    type: hook.type,
    builtin: hook.builtin
  });
}

export function formatHooksReport(config: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const settings = getHookSettings(config);
  const hooks = listConfiguredHooks(config);
  const summary = summarizeHookAudit();
  const recent = listHookAudit({ limit: 12 });
  const failed = listHookAudit({ limit: 8, failedOnly: true });
  const byEvent = HOOK_EVENTS
    .map((event): [string, number] => [event, hooks.filter((hook) => hook.event === event).length])
    .filter((entry) => entry[1] > 0);

  return [
    "Ant Code Hooks",
    "",
    "状态",
    `- 启用：${settings.enabled ? "是" : "否"}`,
    `- disableAll：${settings.disableAll ? "true" : "false"}`,
    `- managedOnly：${settings.managedOnly ? "true" : "false"}`,
    `- 默认超时：${settings.defaultTimeoutMs}ms`,
    `- 输出上限：${settings.maxOutputBytes} bytes`,
    `- command hooks：${options.trusted ? "当前工作区已信任，可执行项目 command hook" : "未传入 trusted=true，仅执行内置 hooks"}`,
    "",
    "事件注册",
    ...(byEvent.length === 0 ? ["- 暂无已注册 hooks"] : byEvent.map(([event, count]) => `- ${event}: ${count}`)),
    "",
    "Hook 列表",
    ...(hooks.length === 0 ? ["- 暂无"] : hooks.slice(0, 60).map((hook) => {
      const blocking = hook.blocking ? " blocking" : "";
      const whenPaths = hook.when?.paths;
      const whenTools = hook.when?.tools;
      const when = Array.isArray(whenPaths) && whenPaths.length ? ` paths=${whenPaths.join(",")}` : Array.isArray(whenTools) && whenTools.length ? ` tools=${whenTools.join(",")}` : "";
      return `- ${hook.event} :: ${hook.name} [${hookTypeLabel(hook)}${blocking}] source=${hook.source}${when}`;
    })),
    hooks.length > 60 ? `- ... 还有 ${hooks.length - 60} 个 hook` : null,
    "",
    "审计概览",
    `- 总记录：${summary.total}`,
    `- 运行中：${summary.running}`,
    `- 失败：${summary.failed}`,
    `- 阻断：${summary.blocked}`,
    `- 跳过：${summary.skipped}`,
    `- 按事件：${formatEventCounts(summary.byEvent)}`,
    "",
    "最近记录",
    ...(recent.length === 0 ? ["- 暂无 hook 执行记录"] : recent.map(formatAuditLine)),
    "",
    "最近失败/阻断",
    ...(failed.length === 0 ? ["- 暂无失败或阻断"] : failed.map(formatAuditLine))
  ].filter((line) => line !== null).join("\n");
}

function formatAuditLine(record: Record<string, unknown>) {
  const state = record.status ?? (record.skipped ? "skipped" : record.blocked ? "blocked" : record.ok ? "completed" : "failed");
  const error = asRecord(record.error);
  const detail = record.message || error.message || record.payloadSummary || "";
  const outputText = typeof record.output === "string" ? record.output : "";
  const output = outputText ? ` output=${outputText.slice(0, 120).replace(/\s+/g, " ")}` : "";
  return `- #${record.id} [${state}] ${record.event} :: ${record.name} (${record.durationMs}ms) ${detail}${output}`;
}

function formatEventCounts(value: unknown = {}) {
  const entries = Object.entries(asRecord(value));
  return entries.length === 0
    ? "none"
    : entries.map(([event, count]) => `${event}=${count}`).join(", ");
}
