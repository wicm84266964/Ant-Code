import { listHookAudit, summarizeHookAudit } from "./audit-store.js";
import { HOOK_EVENTS } from "./events.js";
import { formatHookType, getHookSettings, listConfiguredHooks } from "./registry.js";

export function formatHooksReport(config = {}, options = {}) {
  const settings = getHookSettings(config);
  const hooks = listConfiguredHooks(config);
  const summary = summarizeHookAudit();
  const recent = listHookAudit({ limit: 12 });
  const failed = listHookAudit({ limit: 8, failedOnly: true });
  const byEvent = HOOK_EVENTS
    .map((event) => [event, hooks.filter((hook) => hook.event === event).length])
    .filter(([, count]) => count > 0);

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
      const when = hook.when?.paths?.length ? ` paths=${hook.when.paths.join(",")}` : hook.when?.tools?.length ? ` tools=${hook.when.tools.join(",")}` : "";
      return `- ${hook.event} :: ${hook.name} [${formatHookType(hook)}${blocking}] source=${hook.source}${when}`;
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

function formatAuditLine(record) {
  const state = record.status ?? (record.skipped ? "skipped" : record.blocked ? "blocked" : record.ok ? "completed" : "failed");
  const detail = record.message || record.error?.message || record.payloadSummary || "";
  const output = record.output ? ` output=${record.output.slice(0, 120).replace(/\s+/g, " ")}` : "";
  return `- #${record.id} [${state}] ${record.event} :: ${record.name} (${record.durationMs}ms) ${detail}${output}`;
}

function formatEventCounts(value = {}) {
  const entries = Object.entries(value);
  return entries.length === 0
    ? "none"
    : entries.map(([event, count]) => `${event}=${count}`).join(", ");
}
