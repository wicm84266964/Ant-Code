import fs from "node:fs/promises";
import path from "node:path";
import { listBackgroundAgentTasks } from "../../agents/background-registry.ts";
import { listBackgroundTerminalTasks } from "../../agents/background-terminal-registry.ts";
import type { ActiveSessionMap } from "./types.ts";

// A separate, reversible admission gate, not the runtime's irreversible shutdown flag.
const gates = new WeakMap<ActiveSessionMap, SourceUpdateMaintenance>();
const terminalStatuses = new Set(["completed", "failed", "partial", "blocked", "cancelled", "interrupted"]);
export const sourceUpdateMaintenanceResult = () => ({
  ok: false, status: 503, code: "SOURCE_UPDATE_MAINTENANCE", error: "Dashboard is preparing a source update"
});

export function sourceUpdateWorkBlocked(active: ActiveSessionMap) {
  return gates.get(active)?.held === true;
}

export function createSourceUpdateMaintenance(active: ActiveSessionMap) {
  const gate = new SourceUpdateMaintenance();
  gates.set(active, gate);
  return gate;
}

class SourceUpdateMaintenance {
  held = false;
  pending = 0;
  enter() {
    if (this.held) throw new Error("SOURCE_UPDATE_MAINTENANCE");
    this.held = true;
    let released = false;
    return () => {
      if (!released) { released = true; this.held = false; }
    };
  }

  // Preserve synchronous APIs (approval/queue controls), and count promises before
  // their first await. Work already admitted is never cancelled by the gate.
  wrap<T extends (...args: never[]) => unknown>(operation: T, asynchronous = false): T {
    return ((...args: never[]) => {
      if (this.held) {
        const result = sourceUpdateMaintenanceResult();
        return asynchronous ? Promise.resolve(result) : result;
      }
      this.pending += 1;
      try {
        const result = operation(...args);
        if (result && typeof result === "object" && "then" in result) {
          return Promise.resolve(result).finally(() => { this.pending -= 1; });
        }
        this.pending -= 1;
        return result;
      } catch (error) {
        this.pending -= 1;
        throw error;
      }
    }) as T;
  }
}

/** Strict local record reads: normal list views intentionally hide corrupt files
 * and may be cached/batched. Neither behaviour is safe for an update handoff. */
async function readActivityRecords(cwd: string, directory: string) {
  let root = cwd;
  for (const segment of directory.split("/")) {
    root = path.join(root, segment);
    try {
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("UNCERTAIN_ACTIVITY");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }
  const records: Record<string, unknown>[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error("UNCERTAIN_ACTIVITY");
    const file = path.join(root, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("UNCERTAIN_ACTIVITY");
    const record: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("UNCERTAIN_ACTIVITY");
    records.push(record as Record<string, unknown>);
  }
  return records;
}

export async function sourceUpdateLocalActivity(active: ActiveSessionMap, cwd: string): Promise<string[]> {
  const reasons = new Set<string>();
  for (const state of active.values()) {
    if (state.running || state.interrupting) reasons.add("turn");
    if (state.quarantinedTurnId) reasons.add("quarantined");
    if (state.queuedPrompts.length) reasons.add("queue");
    if (state.pendingApprovals.size || state.pendingQuestions.size) reasons.add("pendingInteraction");
  }
  if (listBackgroundAgentTasks().some((task) => task.aborted !== true)) reasons.add("backgroundAgent");
  const workspaces = new Set([cwd, ...[...active.values()].map((state) => state.session.cwd)]);
  const ownedWorkspaces = new Set([...workspaces].map((workspace) => path.resolve(workspace)));
  // Registry cwd controls loading, not filtering. Unrelated workspaces must not
  // block this handoff; records without ownership remain conservatively busy.
  if (listBackgroundTerminalTasks({ cwd }).some((task) =>
    (!task.cwd || ownedWorkspaces.has(path.resolve(task.cwd)))
    && (!terminalStatuses.has(task.status) || (task.cancelRequestedAt && !task.cancellationConfirmed && !task.finishedAt))
  )) reasons.add("backgroundTerminal");
  for (const workspace of workspaces) {
    for (const directory of [".lab-agent/tasks", ".lab-agent/task-groups", ".lab-agent/background-terminal/tasks"]) {
      for (const record of await readActivityRecords(workspace, directory)) {
        if (typeof record.status !== "string" || !terminalStatuses.has(record.status)) reasons.add("persistedBackground");
        if (record.cancelRequestedAt && !record.cancellationConfirmed && !record.finishedAt) reasons.add("uncertainCancellation");
      }
    }
  }
  return [...reasons];
}

export function sourceUpdateProbeBusy(result: unknown) {
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("activity" in result)) return true;
  const activity = result.activity;
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return true;
  const values = activity as Record<string, unknown>;
  // Require the complete activity contract, not just total (which omits quarantine).
  for (const key of ["total", "activeTurns", "quarantinedTurns", "queuedTurns", "backgroundTasks", "pendingInteractions"]) {
    if (typeof values[key] !== "number" || !Number.isFinite(values[key]) || values[key] !== 0) return true;
  }
  return values.uncertain !== undefined && values.uncertain !== false;
}

/** Local scan owns background records. A probe whose only count is backgroundTasks is the general activity panel, which also counts finished groups waiting to hand off. */
export function sourceUpdateProbeSupplementsLocalScan(result: unknown) {
  if (!sourceUpdateProbeBusy(result)) return false;
  if (!result || typeof result !== "object" || !("activity" in result)) return true;
  const activity = result.activity;
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return true;
  const values = activity as Record<string, unknown>;
  const background = values.backgroundTasks;
  const restClear = ["activeTurns", "quarantinedTurns", "queuedTurns", "pendingInteractions"]
    .every((key) => values[key] === 0);
  const uncertainClear = values.uncertain === undefined || values.uncertain === false;
  return !(restClear && uncertainClear && typeof background === "number" && background > 0 && values.total === background);
}
