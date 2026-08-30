import type { DashboardFactoryState } from "./factory-state.ts";
import type { DashboardRequestInput, DashboardEventListener } from "./types.ts";
import { loadConfig, type LabAgentConfig, GATEWAY_PROTOCOLS, localProjectConfigPath, globalConfigPath } from "../../config/load-config.ts";
import { persistSessionSnapshot, runSessionTurn, SessionModelSelectionUnresolvedError } from "../../core/session.ts";
import { listConfiguredModels, normalizeReasoningEfforts, resolveModelSelection } from "../../model-gateway/models.ts";
import { createSessionStore } from "../../storage/session-store.ts";
import { collectSessionFiles } from "../files.ts";
import { applyPermissionMode, normalizePermissionMode, permissionModeSummary } from "../permissions.ts";
import { publicV2ConfigState, saveV2DefaultModel, saveV2ProviderModel, deleteV2Provider, deleteV2ProviderModel, dashboardV2ErrorResult } from "../model-settings-v2.ts";
import { mutateJsonConfig } from "../config-store.ts";
import { getAntCodeVersion } from "../../version.ts";
import { resolveWorkspaceTrust, trustWorkspace as saveWorkspaceTrust } from "../../permissions/workspace-trust.ts";
import { GOAL_CONTINUE_KIND, publicGoalSnapshot } from "../../core/goal.ts";
import { currentRuntimeModelSelection, resolveSessionModelSelection } from "../../config-v2/runtime-selection.ts";
import { cancelBackgroundAgentTasks } from "../../agents/background-registry.ts";
import { cancelBackgroundTerminalTasks, listBackgroundTerminalTasks } from "../../agents/background-terminal-registry.ts";
import { createAgentTaskStore } from "../../agents/task-store.ts";
import { createAgentTaskGroupStore, summarizeGroupStatus } from "../../agents/task-group-store.ts";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  reclaimActiveSessions
} from "./active-map.ts";
import {
  cancelPendingInteractions,
  normalizeQuestionAnswer,
  requestTurnInterrupt
} from "./approvals.ts";
import {
  appendBackgroundSubagentSnapshot,
  buildBackgroundSubagentSnapshot,
  cancelSessionBackgroundWork,
  cancelWorkspaceBackgroundTerminals,
  loadDashboardGroupSnapshots,
  readDashboardGroupTasks
} from "./background.ts";
import {
  mutateDashboardContext
} from "./context-control.ts";
import {
  boundedGatewayDiscoveryTtl,
  consumeGatewayDiscovery,
  mergeReasoningProbeIntoCatalog,
  probeGatewayConnection,
  probeModelReasoningCapabilities,
  rememberGatewayDiscovery,
  resolveGatewayDiscovery,
  validateGatewayDiscoveryEntry
} from "./gateway-probe.ts";
import {
  applyDashboardGoal,
  persistGoalSnapshot,
  sessionRecordGoalStatus
} from "./goal-runtime.ts";
import {
  cancelAllQueuedTurns,
  dashboardMemoryActivity,
  dashboardRuntimeActivity,
  disposeTurnState,
  lifecycleWaitMs,
  waitForLifecycleOperation,
  waitForLifecyclePromise,
  waitForRuntimeActivity
} from "./lifecycle.ts";
import {
  activeGatewayProfileId,
  buildGatewayProfileDeleteConfig,
  buildGatewayProfileSwitchConfig,
  buildLocalAgentModelTiersConfig,
  buildLocalModelConfig,
  buildOwnedDeleteModelConfig,
  clearDanglingGatewayProfileSelection,
  gatewayProfileDeleteTargets,
  gatewayProfileForEndpoint,
  gatewayProfilesFromConfig,
  gatewayProfilesOwnedByConfig,
  parseConfigUrl,
  removeRedundantInheritedGatewayShadows,
  shouldReplaceModelEntries,
  validateGatewayCredentialMigration
} from "./model-config.ts";
import {
  dashboardActiveSessionPolicy
} from "./policy.ts";
import {
  gatewayProfileModelSource,
  gatewayProfileOwner,
  modelOptions,
  publicAgentModelTiers,
  publicDashboardSettings,
  publicGatewayConfig,
  publicGatewayProfiles,
  publicModelOption,
  publicVisionAgent
} from "./public-config.ts";
import {
  activeStateForSession,
  applySessionConfig,
  configForDashboardSelection,
  configForGatewayProfileSelection,
  configForStatusLists,
  configWithModelSelection,
  dashboardRuntimeSelection,
  defaultReasoningEffortForConfig,
  isConfigV2Enabled,
  persistDashboardSessionModelConfig,
  readDashboardSessionMetadataExact,
  reconcileActiveDashboardSessionsAfterV2Mutation,
  reconcileDashboardRuntimeSelections,
  refreshDashboardSessionAfterV2Mutation,
  rememberDashboardRuntimeSelection,
  resolveReasoningEffortSelection,
  sessionStatusForConfigUpdate,
  sessionStatusFromConfig,
  sessionStatusFromMetadata,
  sessionStatusSummary,
  syncIdleSessionConfig,
  unresolvedSessionModelSelectionResult
} from "./session-model.ts";
import {
  activeDashboardStatus,
  activeReplayCursor,
  activeSessionRecord,
  assistantTranscriptText,
  boundedSessionCwd,
  compareSessionRecords,
  createSnapshotReadState,
  createTranscriptPageResult,
  deleteDashboardSession,
  hasTranscriptCursor,
  mergeActiveTranscriptPage,
  persistedSessionFailure,
  publicBackgroundSnapshot,
  readStoredTranscriptPage,
  transcriptPageReadError
} from "./session-records.ts";
import {
  buildDashboardSettingsConfig,
  dashboardConfigEnv,
  dashboardConfigResultError,
  modelConfigTargetPath,
  mutateDashboardConfig,
  normalizeDashboardSettingsInput,
  normalizeModelConfigInput,
  readJsonConfig
} from "./settings.ts";
import {
  resolveDashboardTrust
} from "./trust.ts";
import {
  appendQueueUpdated,
  buildGuidePrompt,
  createQueueItem,
  isStopGuidance,
  normalizeMutationSessionId,
  previewText,
  publicQueueItem,
  quarantinedSessionResult,
  queueFullResult,
  queueHasCapacity,
  queueSnapshot,
  sessionMutationBusyResult,
  startDashboardTurn,
  withIdempotentTurnRequest,
  withKeyedMutation
} from "./turn-queue.ts";
import {
  appendDashboardEvent,
  clonePlainObject,
  eventId,
  isPlainObject,
  nonNegativeInteger
} from "./util.ts";

export async function runtimeTrustStatus(ctx: DashboardFactoryState) {
  const configEnv = await ctx.resolveConfigEnv();
  return {
    ok: true,
    trust: await resolveDashboardTrust({ cwd: ctx.cwd, env: configEnv, processTrusted: ctx.processTrusted })
  };
}

export async function runtimeTrustWorkspace(ctx: DashboardFactoryState) {
  const configEnv = await ctx.resolveConfigEnv();
  await saveWorkspaceTrust({
    cwd: ctx.cwd,
    env: ctx.runtimeEnv,
    version: await getAntCodeVersion()
  });
  ctx.processTrusted = true;
  return {
    ok: true,
    trust: await resolveDashboardTrust({ cwd: ctx.cwd, env: configEnv, processTrusted: ctx.processTrusted })
  };
}

export async function runtimeListSessionRecords(ctx: DashboardFactoryState) {
  const configEnv = await ctx.resolveConfigEnv();
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  await ctx.maintainSessionRetention(config);
  const store = createSessionStore({ cwd: ctx.cwd, transcript: config.transcript, env: ctx.runtimeEnv });
  const records = await store.listSessionRecords();
  const persisted = records.map((record) => ({
    id: String(record.id ?? ""),
    title: record.title || record.prompt || "未命名任务",
    status: record.status ?? "unknown",
    model: record.model ?? "",
    modifiedAt: record.modifiedAt,
    finishedAt: record.finishedAt ?? null,
    transcriptMessages: record.transcriptMessages ?? 0,
    readable: record.readable !== false,
    encrypted: record.encrypted === true,
    goalStatus: sessionRecordGoalStatus(record)
  }));
  const byId = new Map<string, Record<string, unknown>>(persisted.map((record) => [record.id, record]));
  const activeStates = [...ctx.active.values()];
  const groupSnapshots = await loadDashboardGroupSnapshots(activeStates);
  for (const state of activeStates) {
    const snapshot = await buildBackgroundSubagentSnapshot(state, {
      groups: groupSnapshots.get(path.resolve(state.session.cwd)) ?? []
    });
    const activeRecord = activeSessionRecord(state, byId.get(state.session.id), snapshot);
    byId.set(activeRecord.id, activeRecord);
  }
  return Array.from(byId.values()).sort(compareSessionRecords);
}

export async function runtimeReadSession(ctx: DashboardFactoryState, selector: unknown) {
  const configEnv = await ctx.resolveConfigEnv();
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  const store = createSessionStore({ cwd: ctx.cwd, transcript: config.transcript, env: ctx.runtimeEnv });
  const activeState = ctx.active.get(String(selector ?? ""));
  const result = await store.readMetadata(String(selector ?? ""));
  if (!result.ok && !activeState) {
    return result;
  }
  const metadata = result.ok && result.metadata && typeof result.metadata === "object"
    ? result.metadata as Record<string, unknown>
    : {};
  const session = activeState?.session ?? null;
  const storedPage = result.ok
    ? await readStoredTranscriptPage(store, metadata)
    : createTranscriptPageResult([]);
  if (!storedPage.ok) {
    return transcriptPageReadError(storedPage);
  }
  const transcriptPage = activeState
    ? mergeActiveTranscriptPage(storedPage, activeState)
    : storedPage;
  const transcript = transcriptPage.messages;
  const finalText = activeState?.finalOutput || assistantTranscriptText(transcript);
  const snapshotState = activeState ?? createSnapshotReadState(metadata, ctx.cwd);
  const backgroundSnapshot = snapshotState ? await buildBackgroundSubagentSnapshot(snapshotState) : null;
  return {
    ok: true,
    session: {
      id: activeState?.session.id ?? metadata.id,
      title: session?.title || metadata.title || metadata.prompt || "未命名任务",
      status: activeState ? activeDashboardStatus(activeState) : metadata.status ?? "unknown",
      cwd: session?.cwd ?? metadata.cwd ?? ctx.cwd,
      prompt: session?.prompt ?? metadata.prompt ?? "",
      outputBytes: metadata.outputBytes ?? 0,
      model: session?.model ?? metadata.model ?? "",
      context: metadata.context ?? null,
      active: Boolean(activeState),
      running: activeState?.running === true,
      eventCursor: activeState ? activeReplayCursor(activeState) : null,
      sessionStatus: activeState ? sessionStatusSummary(activeState.session) : sessionStatusFromMetadata(metadata, config),
      permission: permissionModeSummary(activeState?.session ?? metadata),
      goal: publicGoalSnapshot(
        activeState?.session?.goal ?? (isPlainObject(metadata.goal) ? metadata.goal : null),
        activeState?.session?.config,
        activeState?.session?.usage ?? metadata.usage
      ),
      transcript,
      transcriptPage: transcriptPage.summary,
      failure: persistedSessionFailure(metadata),
      files: collectSessionFiles({
        cwd: session?.cwd ?? metadata.cwd ?? ctx.cwd,
        workflow: session?.workflow ?? metadata.workflow ?? null
      }, finalText),
      workflow: session?.workflow ?? metadata.workflow ?? null,
      backgroundSnapshot: backgroundSnapshot ? publicBackgroundSnapshot(backgroundSnapshot) : null,
      modifiedAt: metadata.modifiedAt ?? null,
      finishedAt: metadata.finishedAt ?? null
    }
  };
}

export async function runtimeReadTranscriptPage(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  const configEnv = await ctx.resolveConfigEnv();
  const sessionId = String(input.sessionId ?? input.id ?? "").trim();
  if (!sessionId) {
    return { ok: false, status: 400, error: "缺少会话 ID" };
  }
  const config = await loadConfig({ cwd: ctx.cwd, env: configEnv });
  const store = createSessionStore({ cwd: ctx.cwd, transcript: config.transcript, env: ctx.runtimeEnv });
  const activeState = ctx.active.get(sessionId);
  const result = await store.readMetadata(sessionId);
  if (!result.ok && !activeState) {
    return { ok: false, status: 404, error: result.error?.message ?? "会话不存在" };
  }
  const metadata = result.ok ? result.metadata ?? {} : {};
  const storedPage = result.ok
    ? await readStoredTranscriptPage(store, metadata, { before: input.before, limit: input.limit })
    : createTranscriptPageResult([], { before: input.before, limit: input.limit });
  if (!storedPage.ok) {
    return transcriptPageReadError(storedPage);
  }
  const page = activeState && !hasTranscriptCursor(input.before)
    ? mergeActiveTranscriptPage(storedPage, activeState, { limit: input.limit })
    : storedPage;
  return {
    ok: true,
    sessionId: activeState?.session.id ?? metadata.id ?? sessionId,
    transcript: page.messages,
    transcriptPage: page.summary
  };
}

export async function runtimeDeleteSession(ctx: DashboardFactoryState, input: DashboardRequestInput = {}) {
  return deleteDashboardSession({
    active: ctx.active,
    sessionMutationLocks: ctx.sessionMutationLocks,
    activeCapacityLocks: ctx.activeCapacityLocks,
    activePolicy: ctx.activePolicy,
    cwd: ctx.cwd,
    runtimeEnv: ctx.runtimeEnv,
    resolveConfigEnv: ctx.resolveConfigEnv
  }, input);
}
