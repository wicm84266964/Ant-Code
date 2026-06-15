const IMPLEMENTATION_AGENT_PATTERN = /^(?:junior|worker|executor|code-worker|junior-executor|verifier|verify|browser-verifier|browser|frontend-verifier|visual-verifier|vision|vision-verifier|visual-reviewer|screenshot-reviewer)$/i;
const REVIEW_AGENT_PATTERN = /reviewer|review/i;
const VERIFY_AGENT_PATTERN = /verifier|verify|browser-verifier|visual-verifier|vision-verifier/i;
const COMPLETED_STATUS = "completed";

/**
 * @param {{ routeDecision?: Record<string, any>; prompt?: string; result?: Record<string, any>; task?: Record<string, any>; config?: Record<string, any> }} options
 */
export function shouldRequestReview(options = {}) {
  const reviewConfig = options.config?.agents?.orchestration ?? {};
  if (reviewConfig.autoReview === false) {
    return {
      required: false,
      reasons: ["autoReview disabled"]
    };
  }
  const reasons = [];
  if (options.routeDecision?.risk === "high") {
    reasons.push("route risk is high");
  }
  if (options.result?.partial === true || options.task?.status === "partial") {
    reasons.push("task ended with partial result");
  }
  return {
    required: reasons.length > 0,
    reasons
  };
}

export function createReviewGate(options = {}) {
  const config = normalizeReviewGateConfig(options.config);
  const state = {
    config,
    prompt: String(options.prompt ?? ""),
    toolCalls: [],
    reviewerSeen: false,
    verifierSeen: false,
    reminderShown: false,
    partialOrBlocked: false,
    executionStarted: false,
    failedOrBlockedTools: 0,
    workflow: {
      todo: emptyWorkflowStats(),
      plan: emptyWorkflowStats()
    },
    agentRuns: {
      implementation: 0,
      readonly: 0
    }
  };

  return {
    get state() {
      return state;
    },
    observeToolResult(toolName, input = {}, execution = {}) {
      if (!state.config.enabled) {
        return null;
      }
      const name = String(toolName ?? "");
      state.toolCalls.push(name);
      if (name === "agent_run") {
        const profile = String(input.profile ?? input.profileName ?? execution.profile ?? "");
        if (REVIEW_AGENT_PATTERN.test(profile)) {
          state.reviewerSeen = true;
        }
        if (VERIFY_AGENT_PATTERN.test(profile)) {
          state.verifierSeen = true;
        }
        if (IMPLEMENTATION_AGENT_PATTERN.test(profile)) {
          state.executionStarted = true;
          state.agentRuns.implementation += 1;
        } else {
          state.agentRuns.readonly += 1;
        }
        if (execution.partial === true || execution.blocked === true || execution.ok === false) {
          state.partialOrBlocked = true;
        }
      }
      if (isImplementationTool(name)) {
        state.executionStarted = true;
      }
      if (name === "todo_write") {
        state.workflow.todo = workflowStatsFromItems(execution.result?.todos ?? input.items ?? input.todos ?? input.tasks ?? input.list);
      }
      if (name === "plan_update") {
        state.workflow.plan = workflowStatsFromItems(execution.result?.steps ?? input.steps ?? input.plan ?? input.items);
      }
      if (execution.partial === true || execution.blocked === true || execution.ok === false) {
        state.partialOrBlocked = true;
        if (isMeaningfulFailureForReview(name)) {
          state.failedOrBlockedTools += 1;
        }
      }
      return null;
    },
    beforeFinal() {
      if (!state.config.enabled || state.reminderShown || state.reviewerSeen || state.verifierSeen) {
        return null;
      }
      const reasons = reviewGateReasons(state);
      if (reasons.length === 0) {
        return null;
      }
      state.reminderShown = true;
      return {
        level: state.config.mode === "require" ? "require" : "remind",
        reasons,
        text: [
          "[Ant Code review gate]",
          `当前任务进入${reviewGateLabel(reasons)}，但尚未看到 reviewer/verifier 结果。`,
          `触发原因：${reasons.join("；")}。`,
          "最终回答前请优先运行 reviewer 或 verifier；如果跳过，请说明具体理由。"
        ].join("\n")
      };
    }
  };
}

export function normalizeReviewGateConfig(config = {}) {
  const raw = config?.agents?.reviewGate ?? {};
  const mode = raw.mode === "require" ? "require" : raw.mode === "off" || raw.mode === "disabled" ? "off" : "remind";
  return {
    enabled: raw.enabled !== false && mode !== "off",
    mode,
    todoThreshold: Number.isInteger(raw.todoThreshold) && raw.todoThreshold > 0 ? raw.todoThreshold : 4,
    planThreshold: Number.isInteger(raw.planThreshold) && raw.planThreshold > 0 ? raw.planThreshold : (Number.isInteger(raw.todoThreshold) && raw.todoThreshold > 0 ? raw.todoThreshold : 4),
    deliveryThreshold: Number.isInteger(raw.deliveryThreshold) && raw.deliveryThreshold > 0 ? raw.deliveryThreshold : (Number.isInteger(raw.todoThreshold) && raw.todoThreshold > 0 ? raw.todoThreshold : 4),
    requireForWrites: raw.requireForWrites === true,
    requireForHighRisk: raw.requireForHighRisk === true
  };
}

function reviewGateReasons(state) {
  const reasons = [];
  const planReason = planReviewReason(state);
  if (planReason) {
    reasons.push(planReason);
  }
  const deliveryReason = deliveryReviewReason(state);
  if (deliveryReason) {
    reasons.push(deliveryReason);
  }
  const exceptionReason = exceptionReviewReason(state);
  if (exceptionReason) {
    reasons.push(exceptionReason);
  }
  return reasons;
}

function planReviewReason(state) {
  if (state.executionStarted) {
    return null;
  }
  if (state.workflow.todo.total >= state.config.todoThreshold && state.workflow.todo.incomplete > 0) {
    return `计划复核：已创建 ${state.workflow.todo.total} 个 todo，正式执行前应复核阶段和验收标准`;
  }
  if (state.workflow.plan.total >= state.config.planThreshold && state.workflow.plan.incomplete > 0) {
    return `计划复核：已创建 ${state.workflow.plan.total} 个 plan step，正式执行前应复核依赖顺序和风险`;
  }
  return null;
}

function deliveryReviewReason(state) {
  const todoDelivered = state.workflow.todo.completed >= state.config.deliveryThreshold
    && state.workflow.todo.completed >= Math.max(1, state.workflow.todo.total - state.workflow.todo.cancelled);
  if (todoDelivered) {
    return `交付复核：${state.workflow.todo.completed} 个 todo 已完成，最终汇报前应复核结果和验证缺口`;
  }
  const planDelivered = state.workflow.plan.completed >= state.config.deliveryThreshold
    && state.workflow.plan.completed >= Math.max(1, state.workflow.plan.total - state.workflow.plan.cancelled);
  if (planDelivered) {
    return `交付复核：${state.workflow.plan.completed} 个 plan step 已完成，最终汇报前应复核结果和验证缺口`;
  }
  return null;
}

function exceptionReviewReason(state) {
  if (!state.partialOrBlocked) {
    return null;
  }
  const workflowTotal = state.workflow.todo.total + state.workflow.plan.total;
  if (state.agentRuns.implementation > 0 || workflowTotal >= state.config.todoThreshold || state.failedOrBlockedTools >= 2) {
    return "异常复核：长任务/子任务出现 partial、blocked 或 failed，收尾前应复核可交付范围";
  }
  return null;
}

function reviewGateLabel(reasons) {
  const text = reasons.join(" ");
  if (text.includes("计划复核")) {
    return "计划复核节点";
  }
  if (text.includes("交付复核")) {
    return "交付复核节点";
  }
  if (text.includes("异常复核")) {
    return "异常复核节点";
  }
  return "复核节点";
}

function isImplementationTool(name) {
  return ["write_file", "edit_file", "powershell", "bash", "skill_run"].includes(name);
}

function isMeaningfulFailureForReview(name) {
  return ["agent_run", "write_file", "edit_file", "powershell", "bash", "skill_run", "todo_write", "plan_update"].includes(name);
}

function workflowStatsFromItems(items) {
  const list = Array.isArray(items) ? items : [];
  const stats = emptyWorkflowStats();
  stats.total = list.length;
  for (const item of list) {
    const status = normalizeWorkflowStatus(item?.status ?? item?.state ?? item?.progress);
    if (status === "completed") {
      stats.completed += 1;
    } else if (status === "cancelled") {
      stats.cancelled += 1;
    } else {
      stats.incomplete += 1;
    }
  }
  return stats;
}

function emptyWorkflowStats() {
  return {
    total: 0,
    completed: 0,
    cancelled: 0,
    incomplete: 0
  };
}

function normalizeWorkflowStatus(value) {
  const text = String(value ?? "pending").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (text === COMPLETED_STATUS || ["done", "complete", "finished", "success", "passed", "ok", "完成", "已完成", "成功", "通过"].includes(text)) {
    return "completed";
  }
  if (["cancelled", "canceled", "cancel", "skipped", "skip", "取消", "已取消", "跳过"].includes(text)) {
    return "cancelled";
  }
  return "pending";
}
