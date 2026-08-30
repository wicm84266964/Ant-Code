import type { LabAgentConfig } from "../../config/load-config.ts";
import type { CreateDashboardRuntimeOptions } from "./types.ts";
import type {
  ActiveSessionMap,
  DashboardActiveSessionPolicy,
  DashboardActiveSessionState,
  DashboardEventListener,
  DashboardRequestInput,
  DashboardRuntimeSelection,
  GatewayDiscoveryEntry,
  RuntimeActivityReader,
  TurnRequestRecord
} from "./types.ts";

export type DashboardFactoryState = {
  cwd: string;
  options: CreateDashboardRuntimeOptions;
  runtimeEnv: NodeJS.ProcessEnv;
  active: ActiveSessionMap;
  sessionMutationLocks: Map<string, Promise<unknown>>;
  sessionConfigMutationLock: symbol;
  activeCapacityLocks: Map<string, Promise<unknown>>;
  turnRequests: Map<string, TurnRequestRecord>;
  clientModelSelections: Map<string, DashboardRuntimeSelection>;
  gatewayDiscoveries: Map<string, GatewayDiscoveryEntry>;
  gatewayDiscoverySecret: Buffer;
  gatewayDiscoveryTtlMs: number;
  gatewayDiscoveryNow: () => number;
  activePolicy: DashboardActiveSessionPolicy;
  processTrusted: boolean;
  selectedModelId: string;
  selectedProviderId: string;
  selectedReasoningEffort: string;
  shuttingDown: boolean;
  activeSweepPromise: Promise<unknown> | null;
  readRuntimeActivity: RuntimeActivityReader;
  cancelBackgroundWork: (state: DashboardActiveSessionState, options?: Record<string, unknown>) => Promise<unknown>;
  resolveConfigEnv: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv | undefined> | undefined;
  maintainSessionRetention: (config: LabAgentConfig, maintenanceOptions?: { force?: boolean }) => Promise<unknown> | unknown;
  rerunWithSessionConfigLock: (input: DashboardRequestInput, rerun: (lockedInput: DashboardRequestInput) => Promise<unknown>) => unknown;
  runtime: DashboardRuntimeApi;
  activeSweepTimer: ReturnType<typeof setInterval>;
};

export type DashboardRuntimeApi = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  active: ActiveSessionMap;
  activePolicy: DashboardActiveSessionPolicy;
  status(input?: DashboardRequestInput): Promise<unknown>;
  saveSettingsConfig(input?: DashboardRequestInput): Promise<unknown>;
  switchModel(input?: DashboardRequestInput): Promise<unknown>;
  switchReasoningEffort(input?: DashboardRequestInput): Promise<unknown>;
  saveModelConfig(input?: DashboardRequestInput): Promise<unknown>;
  probeGateway(input?: DashboardRequestInput): Promise<unknown>;
  probeModelCapabilities(input?: DashboardRequestInput, request?: { signal?: AbortSignal }): Promise<unknown>;
  deleteModelConfig(input?: DashboardRequestInput): Promise<unknown>;
  deleteGatewayProfile(input?: DashboardRequestInput): Promise<unknown>;
  switchGatewayProfile(input?: DashboardRequestInput): Promise<unknown>;
  saveDefaultModelSelection(input?: DashboardRequestInput): Promise<unknown>;
  trustStatus(): Promise<unknown>;
  trustWorkspace(): Promise<unknown>;
  listSessionRecords(): Promise<unknown>;
  readSession(selector: unknown): Promise<unknown>;
  readTranscriptPage(input?: DashboardRequestInput): Promise<unknown>;
  deleteSession(input?: DashboardRequestInput): Promise<unknown>;
  startTurn(input?: DashboardRequestInput): Promise<unknown>;
  applyGoal(input?: DashboardRequestInput): Promise<unknown>;
  interruptTurn(sessionId: string, reason?: string): unknown;
  cancelQueuedTurn(input?: DashboardRequestInput): unknown;
  cancelBackgroundSubagent(input?: DashboardRequestInput): Promise<unknown>;
  cancelBackgroundTerminal(input?: DashboardRequestInput): Promise<unknown>;
  guideTurn(input: DashboardRequestInput): unknown;
  clearContext(input?: DashboardRequestInput): Promise<unknown>;
  compactContext(input?: DashboardRequestInput): Promise<unknown>;
  subscribe(sessionId: string, send: DashboardEventListener, options?: { onDispose?: (reason?: unknown) => void; afterSequence?: unknown }): unknown;
  listActiveEvents(sessionId: string): unknown;
  sessionCwd(sessionId: string): Promise<unknown>;
  resolveApproval(approvalId: unknown, action: unknown): unknown;
  resolveQuestion(questionId: unknown, answer?: unknown): unknown;
  lifecycleStatus(): Promise<unknown>;
  sweepIdleSessions(): Promise<unknown>;
  shutdown(input?: DashboardRequestInput): Promise<unknown>;
  sessionFiles(sessionId: string): unknown;
};
