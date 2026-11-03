import {
  validateAgentDebugInspection,
  type AgentDebugInspection,
  type AgentInvocationIdentity,
  type AgentInvocationStatus,
  type AgentRoleId,
  type DebugDimensionState,
  type TokenUsageInspection,
} from '@humanagent/contracts';

export type AgentDebugRole = AgentRoleId;

export const CANONICAL_AGENT_DEBUG_ROLES: readonly AgentRoleId[] = [
  'interaction',
  'orchestration',
  'execution',
  'review',
  'memory',
] as const;

export interface ObservationAgentDebugTurnInput {
  readonly state: DebugDimensionState;
  readonly turnId?: string | null;
  readonly round?: number | null;
  readonly lifecycleState?: 'running' | 'completed' | 'failed' | 'rejected' | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly durationMs?: number | null;
}

export interface ObservationAgentDebugContextInput {
  readonly state: DebugDimensionState;
  readonly contextRootId?: string | null;
  readonly inheritsOrchestratorContext?: boolean | null;
  readonly messageCount?: number | null;
  readonly charCount?: number | null;
  readonly injectedRefs?: readonly string[];
  readonly compacted?: boolean | null;
  readonly omissionReason?: string | null;
}

export interface ObservationAgentDebugModelInput {
  readonly state: DebugDimensionState;
  readonly provider?: string | null;
  readonly requestedModel?: string | null;
  readonly actualModel?: string | null;
  readonly retryCount?: number;
  readonly tokenUsage?: TokenUsageInspection;
}

export interface ObservationAgentDebugToolCallInput {
  readonly callId: string;
  readonly toolName: string;
  readonly state: 'running' | 'succeeded' | 'failed';
  readonly durationMs?: number | null;
  readonly redactedInputSummary?: string;
  readonly outputRef?: string | null;
  readonly errorMessage?: string | null;
}

export interface ObservationAgentDebugToolsInput {
  readonly availableToolsState: 'collected' | 'invoked-without-tools' | 'data-not-collected' | 'not-invoked';
  readonly availableTools?: readonly string[];
  readonly callsState: DebugDimensionState;
  readonly calls?: readonly ObservationAgentDebugToolCallInput[];
}

export interface ObservationAgentDebugErrorInput {
  readonly state: 'present' | 'none' | 'data-not-collected';
  readonly code?: string | null;
  readonly message?: string | null;
  readonly owner?: string | null;
  readonly retryable?: boolean | null;
  readonly readonlyNextActionHint?: string | null;
}

export interface ObservationAgentDebugRoleInput {
  readonly agentRole: AgentRoleId;
  readonly invocationStatus: AgentInvocationStatus;
  readonly latestInvocation?: Partial<AgentInvocationIdentity> | null;
  readonly invocationHistoryCount?: number;
  readonly turn?: ObservationAgentDebugTurnInput;
  readonly context?: ObservationAgentDebugContextInput;
  readonly model?: ObservationAgentDebugModelInput;
  readonly tools?: ObservationAgentDebugToolsInput;
  readonly error?: ObservationAgentDebugErrorInput;
}

export interface ObservationAgentDebugInput {
  readonly byRole?: Partial<Readonly<Record<AgentRoleId, ObservationAgentDebugRoleInput>>>;
}

function defaultSourceNodeId(role: AgentRoleId): string {
  switch (role) {
    case 'interaction':
      return 'explicit.normalize';
    case 'orchestration':
      return 'task.correlate-or-create';
    case 'execution':
      return 'pipeline.execute';
    case 'review':
      return 'settle';
    case 'memory':
      return 'memory.agent';
  }
}

export function createNotInvokedAgentDebugInspection(role: AgentRoleId): AgentDebugInspection {
  const inspection: AgentDebugInspection = {
    agentRole: role,
    invocationStatus: 'not-invoked',
    latestInvocation: null,
    invocationHistoryCount: 0,
    turn: {
      state: 'not-invoked',
      turnId: null,
      round: null,
      lifecycleState: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
    context: {
      state: 'not-invoked',
      contextRootId: null,
      inheritsOrchestratorContext: null,
      messageCount: null,
      charCount: null,
      injectedRefs: [],
      compacted: null,
      omissionReason: null,
    },
    model: {
      state: 'not-invoked',
      provider: null,
      requestedModel: null,
      actualModel: null,
      retryCount: 0,
      tokenUsage: {
        state: 'not-applicable',
        reason: 'no-model-call',
      },
    },
    tools: {
      availableToolsState: 'not-invoked',
      availableTools: [],
      callsState: 'not-invoked',
      calls: [],
    },
    error: {
      state: 'none',
      code: null,
      message: null,
      owner: null,
      retryable: null,
      readonlyNextActionHint: null,
    },
  };
  validateAgentDebugInspection(inspection);
  return inspection;
}

function normalizeLatestInvocation(
  role: AgentRoleId,
  input: ObservationAgentDebugRoleInput,
): AgentInvocationIdentity {
  const raw = input.latestInvocation;
  const rawInvocationId = raw?.invocationId?.trim();
  const turnId = raw?.turnId?.trim() || input.turn?.turnId?.trim() || `turn:${role}:1`;
  const invocationId =
    rawInvocationId && rawInvocationId.startsWith(`inv:${role}:`)
      ? rawInvocationId
      : `inv:${role}:${turnId}`;
  const hasPlanBinding =
    typeof raw?.boundPlanRevisionId === 'string' && raw.boundPlanRevisionId.trim().length > 0 &&
    typeof raw?.boundPlanStepId === 'string' && raw.boundPlanStepId.trim().length > 0;
  const contextRootId =
    raw?.contextIsolation?.contextRootId?.trim()
    || input.context?.contextRootId?.trim()
    || `ctx:${role}:${turnId}`;
  const rawParentContextId = raw?.contextIsolation?.parentContextId?.trim() || null;
  const parentContextId = rawParentContextId === contextRootId ? null : rawParentContextId;
  const rawParentInvocationId = raw?.parentInvocationId?.trim() || null;
  const parentInvocationId = rawParentInvocationId === invocationId ? null : rawParentInvocationId;

  return {
    invocationId,
    agentRole: role,
    sourceNodeId: raw?.sourceNodeId?.trim() || defaultSourceNodeId(role),
    taskId: raw?.taskId?.trim() || null,
    operationId: raw?.operationId?.trim() || null,
    turnId,
    executionEpoch:
      typeof raw?.executionEpoch === 'number' && Number.isSafeInteger(raw.executionEpoch) && raw.executionEpoch >= 1
        ? raw.executionEpoch
        : 1,
    boundPlanRevisionId: hasPlanBinding ? raw!.boundPlanRevisionId!.trim() : null,
    boundPlanStepId: hasPlanBinding ? raw!.boundPlanStepId!.trim() : null,
    parentInvocationId,
    contextIsolation: {
      contextRootId,
      parentContextId,
      inheritsOrchestratorContext: false,
    },
  };
}

function normalizeTurnDimension(
  input: ObservationAgentDebugTurnInput | undefined,
  invocationStatus: AgentInvocationStatus,
  defaultTurnId: string,
): AgentDebugInspection['turn'] {
  if (!input || input.state === 'not-invoked') {
    return {
      state: invocationStatus === 'not-invoked' ? 'not-invoked' : 'data-not-collected',
      turnId: null,
      round: null,
      lifecycleState: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };
  }
  const defaultLifecycle: AgentDebugInspection['turn']['lifecycleState'] =
    invocationStatus === 'active'
      ? 'running'
      : invocationStatus === 'completed'
        ? 'completed'
        : invocationStatus === 'failed'
          ? 'failed'
          : invocationStatus === 'rejected'
            ? 'rejected'
            : null;
  return {
    state: input.state,
    turnId: input.turnId?.trim() || (input.state === 'collected' ? defaultTurnId : null),
    round:
      typeof input.round === 'number' && Number.isSafeInteger(input.round) && input.round >= 0
        ? input.round
        : input.state === 'collected'
          ? 1
          : null,
    lifecycleState: input.lifecycleState !== undefined ? input.lifecycleState : defaultLifecycle,
    startedAt: input.startedAt?.trim() || null,
    completedAt: input.completedAt?.trim() || null,
    durationMs:
      typeof input.durationMs === 'number' && Number.isSafeInteger(input.durationMs) && input.durationMs >= 0
        ? input.durationMs
        : null,
  };
}

function normalizeContextDimension(
  input: ObservationAgentDebugContextInput | undefined,
  invocationStatus: AgentInvocationStatus,
  defaultContextRootId: string | null,
): AgentDebugInspection['context'] {
  if (!input || input.state === 'not-invoked') {
    return {
      state: invocationStatus === 'not-invoked' ? 'not-invoked' : 'data-not-collected',
      contextRootId: defaultContextRootId,
      inheritsOrchestratorContext: defaultContextRootId ? false : null,
      messageCount: null,
      charCount: null,
      injectedRefs: [],
      compacted: null,
      omissionReason: null,
    };
  }
  const injectedRefs = Array.from(
    new Set((input.injectedRefs ?? []).map((ref) => ref.trim()).filter((ref) => ref.length > 0)),
  );
  return {
    state: input.state,
    contextRootId: input.contextRootId?.trim() || defaultContextRootId,
    inheritsOrchestratorContext:
      typeof input.inheritsOrchestratorContext === 'boolean'
        ? input.inheritsOrchestratorContext
        : defaultContextRootId
          ? false
          : null,
    messageCount:
      typeof input.messageCount === 'number' && Number.isSafeInteger(input.messageCount) && input.messageCount >= 0
        ? input.messageCount
        : null,
    charCount:
      typeof input.charCount === 'number' && Number.isSafeInteger(input.charCount) && input.charCount >= 0
        ? input.charCount
        : null,
    injectedRefs,
    compacted: typeof input.compacted === 'boolean' ? input.compacted : null,
    omissionReason: input.omissionReason?.trim() || null,
  };
}

function normalizeTokenUsage(
  usage: TokenUsageInspection | undefined,
  modelState: DebugDimensionState,
): TokenUsageInspection {
  if (modelState === 'invoked-without-model' || modelState === 'not-invoked' || modelState === 'not-applicable') {
    return { state: 'not-applicable', reason: 'no-model-call' };
  }
  if (!usage) {
    return { state: 'data-not-collected', reason: 'provider-protocol-omitted' };
  }
  if (usage.state === 'collected') {
    const inputTokens = Math.max(0, Math.trunc(usage.inputTokens));
    const outputTokens = Math.max(0, Math.trunc(usage.outputTokens));
    return {
      state: 'collected',
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }
  if (usage.state === 'not-applicable') {
    return { state: 'not-applicable', reason: 'no-model-call' };
  }
  return {
    state: 'data-not-collected',
    reason: usage.reason === 'stream-aborted' || usage.reason === 'no-model-call'
      ? usage.reason
      : 'provider-protocol-omitted',
  };
}

function normalizeModelDimension(
  input: ObservationAgentDebugModelInput | undefined,
  invocationStatus: AgentInvocationStatus,
): AgentDebugInspection['model'] {
  if (!input || input.state === 'not-invoked') {
    const state = invocationStatus === 'not-invoked' ? 'not-invoked' : 'data-not-collected';
    return {
      state,
      provider: null,
      requestedModel: null,
      actualModel: null,
      retryCount: 0,
      tokenUsage: normalizeTokenUsage(undefined, state),
    };
  }
  return {
    state: input.state,
    provider: input.provider?.trim() || null,
    requestedModel: input.requestedModel?.trim() || null,
    actualModel: input.actualModel?.trim() || null,
    retryCount:
      typeof input.retryCount === 'number' && Number.isSafeInteger(input.retryCount) && input.retryCount >= 0
        ? input.retryCount
        : 0,
    tokenUsage: normalizeTokenUsage(input.tokenUsage, input.state),
  };
}

function normalizeToolsDimension(
  input: ObservationAgentDebugToolsInput | undefined,
  invocationStatus: AgentInvocationStatus,
): AgentDebugInspection['tools'] {
  if (!input) {
    return {
      availableToolsState: invocationStatus === 'not-invoked' ? 'not-invoked' : 'data-not-collected',
      availableTools: [],
      callsState: invocationStatus === 'not-invoked' ? 'not-invoked' : 'data-not-collected',
      calls: [],
    };
  }
  if (input.availableToolsState === 'invoked-without-tools') {
    return {
      availableToolsState: 'invoked-without-tools',
      availableTools: [],
      callsState: 'invoked-without-tools',
      calls: [],
    };
  }
  const availableTools = Array.from(
    new Set((input.availableTools ?? []).map((name) => name.trim()).filter((name) => name.length > 0)),
  );
  const seenCallIds = new Set<string>();
  const calls: AgentDebugInspection['tools']['calls'][number][] = [];
  let hadIncompleteCall = false;
  for (const call of input.calls ?? []) {
    const callId = call.callId?.trim() || '';
    const toolName = call.toolName?.trim() || '';
    if (callId.length === 0 || toolName.length === 0 || seenCallIds.has(callId)) {
      hadIncompleteCall = true;
      continue;
    }
    seenCallIds.add(callId);
    const rawSummary = typeof call.redactedInputSummary === 'string' ? call.redactedInputSummary : '';
    calls.push({
      callId,
      toolName,
      state: call.state,
      durationMs:
        typeof call.durationMs === 'number' && Number.isSafeInteger(call.durationMs) && call.durationMs >= 0
          ? call.durationMs
          : null,
      redactedInputSummary: rawSummary.length > 256 ? `${rawSummary.slice(0, 253)}...` : rawSummary,
      outputRef: call.outputRef?.trim() || null,
      errorMessage: call.errorMessage?.trim() || null,
    });
  }
  return {
    availableToolsState:
      input.availableToolsState === 'collected' && availableTools.length === 0 && hadIncompleteCall
        ? 'data-not-collected'
        : input.availableToolsState,
    availableTools,
    callsState: hadIncompleteCall ? 'data-not-collected' : input.callsState,
    calls,
  };
}

function normalizeErrorDimension(
  input: ObservationAgentDebugErrorInput | undefined,
): AgentDebugInspection['error'] {
  if (!input || input.state === 'none') {
    return {
      state: 'none',
      code: null,
      message: null,
      owner: null,
      retryable: null,
      readonlyNextActionHint: null,
    };
  }
  if (input.state === 'data-not-collected') {
    return {
      state: 'data-not-collected',
      code: null,
      message: null,
      owner: null,
      retryable: null,
      readonlyNextActionHint: input.readonlyNextActionHint?.trim() || null,
    };
  }
  return {
    state: 'present',
    code: input.code?.trim() || 'runtime.error',
    message: input.message?.trim() || '执行出现异常',
    owner: input.owner?.trim() || 'humanagent.runtime',
    retryable: typeof input.retryable === 'boolean' ? input.retryable : false,
    readonlyNextActionHint:
      input.readonlyNextActionHint?.trim() || '请在任务主界面查看错误详情并按提示操作（观测面只读）',
  };
}

export function projectRoleAgentDebugInspection(
  role: AgentRoleId,
  input?: ObservationAgentDebugRoleInput,
): AgentDebugInspection {
  if (!input || input.invocationStatus === 'not-invoked') {
    return createNotInvokedAgentDebugInspection(role);
  }
  const latestInvocation = normalizeLatestInvocation(role, input);
  const invocationHistoryCount =
    typeof input.invocationHistoryCount === 'number' &&
    Number.isSafeInteger(input.invocationHistoryCount) &&
    input.invocationHistoryCount >= 1
      ? input.invocationHistoryCount
      : 1;
  const inspection: AgentDebugInspection = {
    agentRole: role,
    invocationStatus: input.invocationStatus,
    latestInvocation,
    invocationHistoryCount,
    turn: normalizeTurnDimension(input.turn, input.invocationStatus, latestInvocation.turnId),
    context: normalizeContextDimension(
      input.context,
      input.invocationStatus,
      latestInvocation.contextIsolation.contextRootId,
    ),
    model: normalizeModelDimension(input.model, input.invocationStatus),
    tools: normalizeToolsDimension(input.tools, input.invocationStatus),
    error: normalizeErrorDimension(input.error),
  };
  validateAgentDebugInspection(inspection);
  return inspection;
}

export function projectAgentDebugInspections(
  input?: ObservationAgentDebugInput,
): readonly AgentDebugInspection[] {
  return CANONICAL_AGENT_DEBUG_ROLES.map((role) =>
    projectRoleAgentDebugInspection(role, input?.byRole?.[role]),
  );
}
