// Closed built-in-only dependency graph: copied before installation changes.
export type UpdatePhase = "idle" | "checking" | "ready" | "upToDate" | "staging" |
  "handingOff" | "applying" | "restarting" | "succeeded" | "blocked" | "failed" | "manualRecovery";
export type Route = { mode: "direct"; source: "explicit" } |
  { mode: "proxy"; source: string; url: string };
export type RouteSummary = { mode: "proxy" | "direct"; source: string; endpoint?: string };
export type BootSnapshot = { productVersion: string; bootCommit: string | null; instanceId: string };
export type RepositoryIdentity = { root: string; head: string; branch: string; remote: string; mergeRef: string; upstreamUrl: string };
export type UpdatePlan = RepositoryIdentity & { id: string; target: string; createdAt: number; expiresAt: number };
export type RestartSpec = { node: string; cli: string; projectCwd: string; host: string; port: number };
export type Activity = { busy: boolean; reasons?: string[] };
export type JournalStep = "created" | "preparing" | "prepared" | "awaitingExit" | "oldExited" |
  "dependenciesBackupIntent" | "dependenciesBackedUp" | "dependenciesInstallIntent" | "dependenciesInstalled" |
  "fastForwardIntent" | "fastForwarded" | "restartIntent" | "spawned" | "acknowledged";
export type UpdateJournal = {
  schema: 1; jobId: string; nonce: string; phase: UpdatePhase; step: JournalStep;
  sourceRoot: string; plan: UpdatePlan; boot: BootSnapshot; oldPid: number;
  workerPid: number; restart: RestartSpec; candidate: string; backup: string;
  hadDependencies?: boolean; childPid?: number; updatedAt: number; error?: string;
  acknowledgedBy?: { instanceId: string; commit: string; pid: number };
};
export type UpdateSnapshot = {
  boot: BootSnapshot; phase: UpdatePhase; message?: string; route?: RouteSummary;
  plan?: Omit<UpdatePlan, "root" | "upstreamUrl">; jobId?: string;
  limitations: string[]; strictRestartSupported: boolean;
};
export class UpdateError extends Error {
  code: string;
  constructor(code: string, message: string = code) { super(message); this.name = "UpdateError"; this.code = code; }
}
export const OFFICIAL_UPSTREAM = "https://github.com/wicm84266964/Ant-Code.git";
export const TERMINAL_PHASES: UpdatePhase[] = ["succeeded", "failed", "manualRecovery", "blocked"];
