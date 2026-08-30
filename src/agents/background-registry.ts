type BackgroundController = {
  abort?: () => void;
  signal?: { aborted?: boolean };
};

type BackgroundTaskRecord = {
  controller?: BackgroundController;
  taskId?: string;
  groupId?: string | null;
  parentSessionId?: string | null;
  profile?: string | null;
  startedAt?: string;
};

function asController(value: unknown): BackgroundController | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as BackgroundController;
}

const running = new Map<string, BackgroundTaskRecord>();

export function registerBackgroundAgentTask(task: Record<string, unknown>) {
  const id = String(task?.taskId ?? "").trim();
  if (!id) {
    return () => {};
  }
  running.set(id, {
    taskId: id,
    groupId: task.groupId ? String(task.groupId) : null,
    parentSessionId: task.parentSessionId ? String(task.parentSessionId) : null,
    profile: task.profile ? String(task.profile) : null,
    controller: asController(task.controller),
    startedAt: new Date().toISOString()
  });
  return () => {
    running.delete(id);
  };
}

export function listBackgroundAgentTasks(options: Record<string, unknown> = {}) {
  const parentSessionId = options.parentSessionId ? String(options.parentSessionId) : null;
  const groupId = options.groupId ? String(options.groupId) : null;
  const taskId = options.taskId ? String(options.taskId) : null;
  return [...running.values()]
    .filter((task) => !parentSessionId || task.parentSessionId === parentSessionId)
    .filter((task) => !groupId || task.groupId === groupId)
    .filter((task) => !taskId || task.taskId === taskId)
    .map(({ controller, ...task }: BackgroundTaskRecord) => ({
      ...task,
      aborted: controller?.signal?.aborted === true
    }));
}

export function cancelBackgroundAgentTasks(options: Record<string, unknown> = {}) {
  const parentSessionId = options.parentSessionId ? String(options.parentSessionId) : null;
  const groupId = options.groupId ? String(options.groupId) : null;
  const taskId = options.taskId ? String(options.taskId) : null;
  const tasks = [...running.values()]
    .filter((task) => !parentSessionId || task.parentSessionId === parentSessionId)
    .filter((task) => !groupId || task.groupId === groupId)
    .filter((task) => !taskId || task.taskId === taskId);
  for (const task of tasks) {
    if (task.controller && task.controller.signal?.aborted !== true) {
      task.controller.abort?.();
    }
  }
  return tasks.map(({ controller, ...task }: BackgroundTaskRecord) => ({
    ...task,
    aborted: controller?.signal?.aborted === true
  }));
}

export function hasRunningBackgroundAgentTasks(options: Record<string, unknown> = {}) {
  return listBackgroundAgentTasks(options).some((task) => task.aborted !== true);
}
