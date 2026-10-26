import type { BootSnapshot, UpdateSnapshot } from "../../update/contracts.ts";

type Reply = { ok?: boolean; accepted?: unknown; jobId?: unknown; code?: unknown; message?: unknown; [key: string]: unknown };
type ExpectedUpdate = { jobId: string; target: string; oldInstanceId: string };
export type SourceUpdateViewState = {
  snapshot: UpdateSnapshot | null;
  busy: boolean;
  message: string;
  recovery: boolean;
  verified: boolean;
};
export type SourceUpdateDependencies = {
  get: (path: string) => Promise<Reply>;
  post: (path: string, body: Record<string, unknown>) => Promise<Reply>;
  bootstrap: () => Promise<void>;
  unsentReason: () => string | null;
  rememberSession: () => void;
  reload: () => void;
  sleep?: (ms: number) => Promise<void>;
};

const REASONS: Record<string, string> = {
  NO_UPSTREAM: "当前分支没有上游，请先在本机配置并确认官方 HTTPS 上游。",
  UNSAFE_UPSTREAM: "当前分支没有安全上游，请先在本机检查分支跟踪配置。",
  UNSUPPORTED_UPSTREAM: "仅支持官方公开 HTTPS 源码仓库的当前分支上游。",
  DIRTY: "源码有未提交或未跟踪文件，请自行处理后重试；更新不会自动清理或暂存。",
  DIRTY_WORKTREE: "源码有未提交或未跟踪文件，请自行处理后重试；更新不会自动清理或暂存。",
  DETACHED_OR_INVALID_HEAD: "当前不在有效分支上，请先在本机检查 Git 分支。",
  GIT_OPERATION_IN_PROGRESS: "Git 合并、变基或其他操作尚未完成，请先自行处理。",
  DIVERGED: "本地分支与上游已分叉，不能安全快进，请在本机检查。",
  NON_FAST_FORWARD: "本地分支不能安全快进，请在本机检查；不会强制覆盖。",
  ROUTE_REQUIRED: "未发现支持的代理。请手填 HTTP(S) 代理，或明确勾选「仅本次直连」。",
  INVALID_PROXY: "代理地址无效，请填写完整的 HTTP(S) 地址，不带路径、查询或片段。",
  UNSUPPORTED_PROXY: "不支持此代理协议；仅支持 HTTP(S)，不执行 SOCKS 或 PAC。",
  PAC_UNSUPPORTED: "检测到 PAC，无法安全执行。请手填 HTTP(S) 代理或明确选择仅本次直连。",
  AMBIGUOUS_ROUTE: "手填代理与仅本次直连不能同时选择。",
  ACTIVE_WORK: "仍有运行、排队、待确认或状态不确定的任务。当前这个窗口可以留着。请先处理那些任务，更新不会自动取消它们。",
  OTHER_DASHBOARD_RUNNING: "另一个 Dashboard 窗口仍在运行，而且还不能确认它是空闲的。你正在用的这个窗口可以留着，它会在更新时自动重启。请关掉另一个窗口后再试。",
  OTHER_DASHBOARD_BUSY: "另一个 Dashboard 里还有活动任务。请先处理那个窗口里的任务。当前窗口可以留着。",
  OTHER_INSTANCE: "另一个 Dashboard 窗口仍在运行。当前这个窗口可以留着，它会在更新时自动重启。",
  OTHER_INSTANCES: "还有其他 Dashboard 窗口在运行。当前这个窗口可以留着，它会在更新时自动重启。",
  UPDATE_BUSY: "更新任务正在进行，请勿重复操作。",
  UPDATE_LOCKED: "更新锁尚未解除，请检查之前的更新记录，不要盲目删除锁重试。",
  PLAN_STALE: "检查结果已过期或源码状态发生变化，请重新检查版本。",
  REPOSITORY_CHANGED: "检查后源码状态发生变化，请重新检查版本。",
  RUNTIME_SOURCE_CHANGED: "源码与当前启动快照不同，请先手动重启 Dashboard 再检查。",
  SOURCE_INSTALL_REQUIRED: "仅支持独立源码安装；成品包、链接工作树等不能在此更新。",
  SOURCE_UPDATE_UNAVAILABLE: "当前安装不支持源码自更新，请使用原安装方式维护。",
  STRICT_RESTART_REQUIRED: "当前服务尚不支持严格同端口重启，不能执行自动更新。",
  UNSAFE_GIT_CONFIG: "Git 执行、重写、TLS 或代理配置不满足安全更新要求，请在本机检查。",
  HIDDEN_INDEX_CHANGES: "Git 索引含隐藏修改或稀疏配置，不能安全更新。",
  IGNORED_COLLISION: "目标源码与本机忽略文件冲突，请自行检查并备份后处理。",
  UNTRACKED_COLLISION: "目标源码与本机文件冲突，请自行检查并备份后处理。",
  UNSAFE_DEPENDENCY: "候选依赖不满足安全约束，已阻止自动更新。",
  UNSUPPORTED_NPM_CONFIG: "候选 npm 配置需要人工审查，已阻止自动更新。",
  CHECK_FAILED: "版本检查失败。请检查上游与所选网络路由；不会自动改为直连。",
  GIT_FAILED: "Git 检查或网络操作失败。请检查上游与所选代理；不会自动改为直连。",
  PROCESS_LIMIT: "更新子进程超时或超出限制，请检查网络和本机环境。",
  WORKER_INTERRUPTED: "更新进程中断，需要检查本机更新记录。",
  WORKER_INTERRUPTED_INSPECT_JOURNAL: "更新进程中断，需要检查本机更新记录。",
  START_FAILED: "更新准备失败，请检查本机更新记录后再操作。",
  AUTH_REQUIRED: "本机鉴权已失效，请保留当前内容并重新打开此 Dashboard。",
  CSRF_INVALID: "本机鉴权已变化，请保留当前内容并重新打开此 Dashboard。"
};

export function sourceUpdateReason(code: unknown): string {
  return typeof code === "string" && Object.hasOwn(REASONS, code)
    ? REASONS[code]!
    : "更新被安全检查阻止或未能完成。请在本机检查更新记录；详细错误不会在此显示。";
}

export function sourceUpdateBoot(value: unknown): BootSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const boot = value as Record<string, unknown>;
  if (typeof boot.productVersion !== "string" || !boot.productVersion || typeof boot.instanceId !== "string" || !boot.instanceId) return null;
  if (boot.bootCommit !== null && (typeof boot.bootCommit !== "string" || !/^[a-f0-9]{40,64}$/i.test(boot.bootCommit))) return null;
  return { productVersion: boot.productVersion, bootCommit: boot.bootCommit as string | null, instanceId: boot.instanceId };
}

function readSnapshot(reply: Reply): UpdateSnapshot {
  const boot = sourceUpdateBoot(reply.boot);
  const phases = ["idle", "checking", "ready", "upToDate", "blocked", "staging", "handingOff", "handoff", "applying", "restarting", "succeeded", "failed", "manualRecovery"];
  if (reply.ok === false || !boot || !phases.includes(String(reply.phase))) throw reply;
  return { ...reply, boot } as unknown as UpdateSnapshot;
}

export function sourceUpdateSucceeded(expected: ExpectedUpdate, snapshot: UpdateSnapshot, status: unknown): boolean {
  const boot = sourceUpdateBoot(status);
  return Boolean(boot && snapshot.phase === "succeeded" && snapshot.jobId === expected.jobId &&
    /^[a-f0-9]{40,64}$/i.test(expected.target) && boot.bootCommit === expected.target &&
    snapshot.boot.bootCommit === expected.target && boot.instanceId !== expected.oldInstanceId &&
    snapshot.boot.instanceId === boot.instanceId && snapshot.boot.productVersion === boot.productVersion);
}

export function sourceUpdateCheckBody(proxyUrl: string, allowDirect: boolean): Record<string, unknown> {
  const value = proxyUrl.trim();
  if (value && allowDirect) throw { code: "AMBIGUOUS_ROUTE" };
  if (value) {
    if (value.length > 2048 || /[\r\n\0]/.test(value)) throw { code: "INVALID_PROXY" };
    let url: URL;
    try { url = new URL(value); } catch { throw { code: "INVALID_PROXY" }; }
    if (!["http:", "https:"].includes(url.protocol)) throw { code: "UNSUPPORTED_PROXY" };
    if (!url.hostname || url.pathname !== "/" || url.search || url.hash) throw { code: "INVALID_PROXY" };
    return { proxyUrl: value };
  }
  return allowDirect ? { allowDirect: true } : {};
}

const PHASE_TEXT: Record<string, string> = {
  idle: "尚未检查版本。", checking: "正在检测真实代理配置并检查当前分支上游…",
  ready: "发现可快进更新。请核对分支和目标提交后确认。", upToDate: "当前分支已是上游最新版本。",
  staging: "正在隔离准备依赖；此阶段失败不会替换旧服务。", handingOff: "准备交接并停止旧服务…",
  handoff: "准备交接并停止旧服务…", applying: "正在快进源码并切换依赖…", restarting: "正在原地址重启，等待新实例核验…",
  succeeded: "服务已报告完成，仍需核验任务、目标提交和新实例。", blocked: "更新已阻止。",
  failed: "更新未完成。", manualRecovery: "更新中断，需要人工恢复。"
};
const RECOVERY = "请勿反复点击更新、删除更新锁或执行 reset/clean。关闭其他 CLI/TUI，在本机源码安装的 .git/ant-source-update 中检查 journal.json、实际 HEAD 和依赖备份；确认完成步骤后再恢复依赖并按原地址手动启动 Dashboard。请先备份，不要盲目回滚。";
const activePhase = (phase: string | undefined) => ["checking", "staging", "handingOff", "handoff", "applying", "restarting"].includes(phase ?? "");
const errorCode = (error: unknown) => error && typeof error === "object" ? (error as Reply).code : undefined;

export function createSourceUpdateController(deps: SourceUpdateDependencies, render: (view: SourceUpdateViewState) => void) {
  const view: SourceUpdateViewState = { snapshot: null, busy: false, message: "尚未检查版本。", recovery: false, verified: false };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const paint = () => render({ ...view });
  const apply = (snapshot: UpdateSnapshot) => {
    view.snapshot = snapshot;
    view.message = PHASE_TEXT[snapshot.phase] ?? "正在等待更新状态…";
    view.recovery = ["failed", "manualRecovery"].includes(snapshot.phase);
    if (["blocked", "failed", "manualRecovery"].includes(snapshot.phase)) view.message += ` ${sourceUpdateReason(snapshot.message)}`;
    paint();
  };
  const finishReload = () => {
    const reason = deps.unsentReason();
    if (reason) { view.message = `新实例已核验，但尚未刷新：${reason} 处理后可点击「刷新新版页面」。`; paint(); return; }
    deps.rememberSession();
    deps.reload();
  };
  return {
    isBusy: () => view.busy,
    async open() {
      if (view.busy || view.verified) { paint(); return; }
      view.busy = true; view.message = "正在读取本机更新能力…"; paint();
      try { apply(readSnapshot(await deps.get("/api/source-update"))); }
      catch (error) { view.message = sourceUpdateReason(errorCode(error)); }
      finally { view.busy = false; paint(); }
    },
    invalidate() {
      if (view.busy || view.verified) return;
      if (view.snapshot?.phase === "ready") view.snapshot = { ...view.snapshot, phase: "idle", plan: undefined };
      view.message = "网络选择已改变，请重新检查版本。"; paint();
    },
    async check(proxyUrl: string, allowDirect: boolean) {
      if (view.busy || view.verified || view.recovery || activePhase(view.snapshot?.phase) || view.snapshot?.phase === "manualRecovery") return;
      view.busy = true; view.recovery = false; view.message = PHASE_TEXT.checking!;
      if (view.snapshot?.phase === "ready") view.snapshot = { ...view.snapshot, phase: "idle", plan: undefined };
      paint();
      try {
        const body = sourceUpdateCheckBody(proxyUrl, allowDirect);
        // The only credential-bearing object is this one-shot request; never persist it.
        proxyUrl = "";
        let reply: Reply;
        try { reply = await deps.post("/api/source-update/check", body); }
        finally { delete body.proxyUrl; }
        if (reply.ok === false || reply.accepted !== true) throw reply;
        view.snapshot = null;
        for (let attempt = 0; attempt < 45; attempt += 1) {
          await sleep(2000);
          const snapshot = readSnapshot(await deps.get("/api/source-update"));
          apply(snapshot);
          if (["ready", "upToDate", "blocked", "failed", "manualRecovery"].includes(snapshot.phase)) return;
        }
        view.message = "检查等待已超时。未启动更新；请稍后重新读取状态，不要重复发起检查。";
      } catch (error) { view.message = sourceUpdateReason(errorCode(error)); }
      finally { proxyUrl = ""; view.busy = false; paint(); }
    },
    async start(confirmed: boolean) {
      const snapshot = view.snapshot, plan = snapshot?.plan;
      if (view.busy || view.verified || view.recovery || snapshot?.phase !== "ready" || !plan) return;
      if (!confirmed) { view.message = "请确认分支与目标提交。当前窗口会自动重启；其他 CLI/TUI 仍须自行关闭。"; paint(); return; }
      if (!snapshot.strictRestartSupported) { view.message = sourceUpdateReason("STRICT_RESTART_REQUIRED"); paint(); return; }
      if (!sourceUpdateBoot(snapshot.boot) || !/^[a-f0-9]{40,64}$/i.test(plan.target) || !Number.isFinite(plan.expiresAt) || Date.now() >= plan.expiresAt) {
        view.message = sourceUpdateReason("PLAN_STALE"); paint(); return;
      }
      const reason = deps.unsentReason();
      if (reason) { view.message = `${reason} 请先关闭此窗口并处理；更新不会保存或丢弃这些内容。`; paint(); return; }
      view.busy = true; view.recovery = false; view.message = "正在提交更新任务，请勿重复操作…"; paint();
      deps.rememberSession();
      try {
        const reply = await deps.post("/api/source-update/start", { planId: plan.id });
        if (reply.ok === false) throw reply;
        if (reply.accepted !== true || typeof reply.jobId !== "string" || !reply.jobId) throw { code: "START_FAILED" };
        const expected = { jobId: reply.jobId, target: plan.target, oldInstanceId: snapshot.boot.instanceId };
        // Both total polling and each request are bounded. Bootstrap precedes ALL reconnect API reads.
        const reconnectDeadline = Date.now() + 10 * 60_000;
        for (let attempt = 0; attempt < 180 && Date.now() < reconnectDeadline; attempt += 1) {
          await sleep(2000);
          try {
            await deps.bootstrap();
            const status = await deps.get("/api/status");
            if (status.ok === false || !sourceUpdateBoot(status)) throw status;
            const current = readSnapshot(await deps.get("/api/source-update"));
            apply(current);
            if (current.jobId === expected.jobId && ["failed", "manualRecovery", "blocked"].includes(current.phase)) { view.recovery = true; return; }
            if (sourceUpdateSucceeded(expected, current, status)) {
              view.verified = true; view.message = "任务、目标提交与新实例已核验，正在刷新新版页面…"; paint();
              finishReload(); return;
            }
          } catch {
            view.message = "服务正在交接或鉴权尚未恢复，等待原地址的新实例；尚未确认更新成功…"; paint();
          }
        }
        view.recovery = true; view.message = "重连等待已结束，尚未核验更新成功。请按恢复指引检查，不要重复启动更新。";
      } catch (error) {
        // A lost start response is ambiguous: never automatically retry a mutating request.
        view.recovery = true; view.message = `${sourceUpdateReason(errorCode(error))} 尚未确认任务是否被接受，请先检查本机更新记录。`;
        if (view.snapshot) view.snapshot = { ...view.snapshot, phase: "failed", plan: undefined };
      } finally { view.busy = false; paint(); }
    },
    refresh() { if (view.verified && !view.busy) finishReload(); }
  };
}

function routeText(snapshot: UpdateSnapshot | null): string {
  if (!snapshot?.route) return "检查时自动读取配置、环境变量、Git/npm 和 Windows 静态系统代理；不猜测端口、不扫描。";
  if (snapshot.route.mode === "direct") return "路由：仅本次明确授权的直连。";
  const source = String(snapshot.route.source ?? "");
  const label = source === "manual" ? "一次性手填" : source === "config" ? "产品配置" : source.startsWith("env:") ? "环境变量" : source === "git" ? "Git 配置" : source.startsWith("npm:") ? "npm 配置" : source === "windows" ? "Windows 静态系统代理" : "自动配置";
  // Intentionally omit endpoint: even malformed server summaries cannot disclose proxy credentials.
  return `路由：HTTP(S) 代理（${label}）。代理失效不会自动直连。`;
}

export function bindSourceUpdateUI(root: Document, deps: SourceUpdateDependencies) {
  const dialog = root.querySelector<HTMLDialogElement>("#source-update-dialog");
  const trigger = root.querySelector<HTMLButtonElement>("#source-update-button");
  if (!dialog || !trigger) return { setBoot(_value: unknown) {} };
  const find = <T>(id: string) => dialog.querySelector(`#${id}`) as unknown as T;
  const progress = find<HTMLElement>("source-update-progress"), route = find<HTMLElement>("source-update-route");
  const plan = find<HTMLElement>("source-update-plan"), recovery = find<HTMLElement>("source-update-recovery");
  const proxy = find<HTMLInputElement>("source-update-proxy"), direct = find<HTMLInputElement>("source-update-direct");
  const confirm = find<HTMLInputElement>("source-update-confirm"), check = find<HTMLButtonElement>("source-update-check");
  const start = find<HTMLButtonElement>("source-update-start"), close = find<HTMLButtonElement>("source-update-close");
  const refresh = find<HTMLButtonElement>("source-update-refresh");
  let lastPlanId: string | undefined;
  const controller = createSourceUpdateController(deps, (view) => {
    progress.textContent = view.message;
    dialog.dataset.busy = String(view.busy);
    route.textContent = routeText(view.snapshot);
    const currentPlan = view.snapshot?.phase === "ready" ? view.snapshot.plan : undefined;
    if (lastPlanId !== currentPlan?.id) confirm.checked = false;
    lastPlanId = currentPlan?.id;
    plan.hidden = !currentPlan;
    find<HTMLElement>("source-update-branch").textContent = currentPlan?.branch ?? "";
    find<HTMLElement>("source-update-target").textContent = currentPlan?.target ?? "";
    const ready = Boolean(currentPlan && !view.busy && !view.verified && !view.recovery && view.snapshot?.strictRestartSupported);
    start.hidden = !currentPlan;
    start.disabled = !ready || !confirm.checked;
    confirm.disabled = !ready;
    check.disabled = view.busy || view.verified || view.recovery || activePhase(view.snapshot?.phase) || view.snapshot?.phase === "manualRecovery";
    proxy.disabled = direct.disabled = view.busy || view.verified;
    close.disabled = view.busy;
    refresh.hidden = !view.verified;
    recovery.hidden = !view.recovery;
    recovery.textContent = RECOVERY;
    find<HTMLElement>("source-update-capability").textContent = view.snapshot && !view.snapshot.strictRestartSupported ? sourceUpdateReason("STRICT_RESTART_REQUIRED") : "";
  });
  trigger.addEventListener("click", () => {
    confirm.checked = false;
    if (!dialog.open) dialog.showModal();
    void controller.open();
  });
  close.addEventListener("click", () => { if (!controller.isBusy()) dialog.close(); });
  // Native dialog owns Tab/Escape, not the legacy non-native modal key handler.
  dialog.addEventListener("keydown", (event) => { if (event.key === "Tab" || event.key === "Escape") event.stopPropagation(); });
  dialog.addEventListener("cancel", (event) => { if (controller.isBusy()) event.preventDefault(); });
  dialog.addEventListener("close", () => { proxy.value = ""; direct.checked = false; trigger.focus(); });
  proxy.addEventListener("input", () => controller.invalidate());
  direct.addEventListener("change", () => controller.invalidate());
  confirm.addEventListener("change", () => { start.disabled = confirm.disabled || !confirm.checked; });
  check.addEventListener("click", () => {
    const value = proxy.value, allowDirect = direct.checked;
    proxy.value = ""; direct.checked = false;
    void controller.check(value, allowDirect);
  });
  start.addEventListener("click", () => void controller.start(confirm.checked));
  refresh.addEventListener("click", () => controller.refresh());
  return {
    setBoot(value: unknown) {
      const boot = sourceUpdateBoot(value);
      const version = root.querySelector<HTMLElement>("#product-version");
      if (version) version.textContent = boot ? `v${boot.productVersion}` : "版本未知";
      find<HTMLElement>("source-update-current").textContent = boot ? `v${boot.productVersion} · ${boot.bootCommit?.slice(0, 12) ?? "源码提交未知"}` : "无法读取启动版本身份";
    }
  };
}
