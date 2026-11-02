import { ContractError } from './errors.js';
import { isCanonicalInstant } from './time.js';
import type { AgentModelBinding, SubagentContextIsolationPolicy } from './task-plan-revision.js';

export type AgentRoleId = 'interaction' | 'orchestration' | 'execution' | 'review' | 'memory';
export type AgentInvocationStatus = 'not-invoked' | 'active' | 'completed' | 'failed' | 'rejected';

export type DebugDimensionState =
  | 'collected'
  | 'invoked-without-model'
  | 'invoked-without-tools'
  | 'data-not-collected'
  | 'data-collected-but-not-projected'
  | 'collection-failed'
  | 'not-applicable'
  | 'not-invoked';

export interface AgentInvocationIdentity {
  readonly invocationId: string;
  readonly agentRole: AgentRoleId;
  readonly sourceNodeId: string;
  readonly taskId: string | null;
  readonly operationId: string | null;
  readonly turnId: string;
  readonly executionEpoch: number;
  readonly boundPlanRevisionId: string | null;
  readonly boundPlanStepId: string | null;
  readonly parentInvocationId: string | null;
  readonly contextIsolation: {
    readonly contextRootId: string;
    readonly parentContextId: string | null;
    readonly inheritsOrchestratorContext: boolean;
  };
}

export type TokenUsageInspection =
  | {
      readonly state: 'collected';
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    }
  | {
      readonly state: 'data-not-collected' | 'not-applicable';
      readonly reason: 'provider-protocol-omitted' | 'stream-aborted' | 'no-model-call';
    };

export interface AgentDebugInspection {
  readonly agentRole: AgentRoleId;
  readonly invocationStatus: AgentInvocationStatus;
  readonly latestInvocation: AgentInvocationIdentity | null;
  readonly invocationHistoryCount: number;
  readonly turn: {
    readonly state: DebugDimensionState;
    readonly turnId: string | null;
    readonly round: number | null;
    readonly lifecycleState: 'running' | 'completed' | 'failed' | 'rejected' | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly durationMs: number | null;
  };
  readonly context: {
    readonly state: DebugDimensionState;
    readonly contextRootId: string | null;
    readonly inheritsOrchestratorContext: boolean | null;
    readonly messageCount: number | null;
    readonly charCount: number | null;
    readonly injectedRefs: readonly string[];
    readonly compacted: boolean | null;
    readonly omissionReason: string | null;
  };
  readonly model: {
    readonly state: DebugDimensionState;
    readonly provider: string | null;
    readonly requestedModel: string | null;
    readonly actualModel: string | null;
    readonly retryCount: number;
    readonly tokenUsage: TokenUsageInspection;
  };
  readonly tools: {
    readonly availableToolsState: 'collected' | 'invoked-without-tools' | 'data-not-collected' | 'not-invoked';
    readonly availableTools: readonly string[];
    readonly callsState: DebugDimensionState;
    readonly calls: readonly {
      readonly callId: string;
      readonly toolName: string;
      readonly state: 'running' | 'succeeded' | 'failed';
      readonly durationMs: number | null;
      readonly redactedInputSummary: string;
      readonly outputRef: string | null;
      readonly errorMessage: string | null;
    }[];
  };
  readonly error: {
    readonly state: 'present' | 'none' | 'data-not-collected';
    readonly code: string | null;
    readonly message: string | null;
    readonly owner: string | null;
    readonly retryable: boolean | null;
    readonly readonlyNextActionHint: string | null;
  };
}

export interface AgentInvocationModelBinding extends AgentModelBinding {}

export interface AgentInvocationContextIsolationPolicy
  extends Pick<SubagentContextIsolationPolicy, 'contextRootId' | 'parentContextId' | 'inheritsOrchestratorContext'> {}

const ROLES = ['interaction', 'orchestration', 'execution', 'review', 'memory'] as const;
const DIMENSION_STATES = [
  'collected',
  'invoked-without-model',
  'invoked-without-tools',
  'data-not-collected',
  'data-collected-but-not-projected',
  'collection-failed',
  'not-applicable',
  'not-invoked',
] as const;

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function requireNullableText(value: unknown, label: string): void {
  if (value !== null) requireText(value, label);
}

function requireNullableInteger(value: unknown, label: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new ContractError(`${label} must be a non-negative safe integer or null`);
  }
}

function requireRole(value: unknown): asserts value is AgentRoleId {
  if (!ROLES.includes(value as AgentRoleId)) throw new ContractError(`unsupported agent role: ${String(value)}`);
}

function requireDimensionState(value: unknown, label: string): asserts value is DebugDimensionState {
  if (!DIMENSION_STATES.includes(value as DebugDimensionState)) {
    throw new ContractError(`${label} has an unsupported debug dimension state`);
  }
}

export function validateAgentInvocationIdentity(identity: AgentInvocationIdentity): void {
  if (!identity || typeof identity !== 'object') throw new ContractError('agent invocation identity must be an object');
  requireRole(identity.agentRole);
  requireText(identity.invocationId, 'agent invocation id');
  if (!identity.invocationId.startsWith(`inv:${identity.agentRole}:`)) {
    throw new ContractError('agent invocation id does not match its role');
  }
  requireText(identity.sourceNodeId, 'agent invocation source node id');
  requireNullableText(identity.taskId, 'agent invocation task id');
  requireNullableText(identity.operationId, 'agent invocation operation id');
  requireText(identity.turnId, 'agent invocation turn id');
  if (!Number.isSafeInteger(identity.executionEpoch) || identity.executionEpoch < 1) {
    throw new ContractError('agent invocation execution epoch must be a positive safe integer');
  }
  requireNullableText(identity.boundPlanRevisionId, 'agent invocation bound plan revision id');
  requireNullableText(identity.boundPlanStepId, 'agent invocation bound plan step id');
  if ((identity.boundPlanRevisionId === null) !== (identity.boundPlanStepId === null)) {
    throw new ContractError('agent invocation must bind a plan revision and step together');
  }
  requireNullableText(identity.parentInvocationId, 'agent invocation parent invocation id');
  if (identity.parentInvocationId === identity.invocationId) {
    throw new ContractError('agent invocation cannot be its own parent');
  }
  const context = identity.contextIsolation;
  if (!context || typeof context !== 'object') {
    throw new ContractError('agent invocation context isolation must be an object');
  }
  requireText(context.contextRootId, 'agent invocation context root id');
  requireNullableText(context.parentContextId, 'agent invocation parent context id');
  if (context.parentContextId === context.contextRootId) {
    throw new ContractError('agent invocation context cannot be its own parent context');
  }
  if (context.inheritsOrchestratorContext !== false) {
    throw new ContractError('agent invocation must not inherit orchestrator context');
  }
}

export function validateTokenUsageInspection(usage: TokenUsageInspection): void {
  if (!usage || typeof usage !== 'object') throw new ContractError('token usage inspection must be an object');
  if (usage.state === 'collected') {
    for (const [label, value] of [
      ['inputTokens', usage.inputTokens],
      ['outputTokens', usage.outputTokens],
      ['totalTokens', usage.totalTokens],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new ContractError(`token usage ${label} must be a non-negative safe integer`);
      }
    }
    if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
      throw new ContractError('token usage total must equal input plus output');
    }
    return;
  }
  if (usage.state !== 'data-not-collected' && usage.state !== 'not-applicable') {
    throw new ContractError(`unsupported token usage state: ${String((usage as { state?: unknown }).state)}`);
  }
  if (usage.reason !== 'provider-protocol-omitted' && usage.reason !== 'stream-aborted' && usage.reason !== 'no-model-call') {
    throw new ContractError(`unsupported token usage reason: ${String(usage.reason)}`);
  }
  if (usage.state === 'not-applicable' && usage.reason !== 'no-model-call') {
    throw new ContractError('not-applicable token usage requires the no-model-call reason');
  }
}

function validateInvocationHistory(
  inspection: AgentDebugInspection,
): void {
  if (!Number.isSafeInteger(inspection.invocationHistoryCount) || inspection.invocationHistoryCount < 0) {
    throw new ContractError('agent invocation history count must be a non-negative safe integer');
  }
  if (inspection.invocationStatus === 'not-invoked') {
    if (inspection.latestInvocation !== null || inspection.invocationHistoryCount !== 0) {
      throw new ContractError('not-invoked agent cannot carry invocation history');
    }
  } else if (inspection.latestInvocation === null || inspection.invocationHistoryCount === 0) {
    throw new ContractError('invoked agent requires a latest invocation and history count');
  }
  if (inspection.latestInvocation !== null) {
    validateAgentInvocationIdentity(inspection.latestInvocation);
    if (inspection.latestInvocation.agentRole !== inspection.agentRole) {
      throw new ContractError('latest agent invocation role does not match the debug inspection role');
    }
  }
}

function validateTurnDimension(turn: AgentDebugInspection['turn']): void {
  if (!turn || typeof turn !== 'object') throw new ContractError('agent debug turn dimension must be an object');
  requireDimensionState(turn.state, 'turn');
  requireNullableText(turn.turnId, 'agent debug turn id');
  requireNullableInteger(turn.round, 'agent debug turn round');
  if (turn.lifecycleState !== null && !['running', 'completed', 'failed', 'rejected'].includes(turn.lifecycleState)) {
    throw new ContractError('agent debug turn lifecycle state is invalid');
  }
  for (const [label, value] of [['startedAt', turn.startedAt], ['completedAt', turn.completedAt]] as const) {
    if (value !== null && !isCanonicalInstant(value)) {
      throw new ContractError(`agent debug turn ${label} must be a canonical instant or null`);
    }
  }
  if (turn.durationMs !== null && (!Number.isSafeInteger(turn.durationMs) || turn.durationMs < 0)) {
    throw new ContractError('agent debug turn duration must be a non-negative safe integer or null');
  }
}

function validateContextDimension(context: AgentDebugInspection['context']): void {
  if (!context || typeof context !== 'object') throw new ContractError('agent debug context dimension must be an object');
  requireDimensionState(context.state, 'context');
  requireNullableText(context.contextRootId, 'agent debug context root id');
  if (context.inheritsOrchestratorContext !== null && typeof context.inheritsOrchestratorContext !== 'boolean') {
    throw new ContractError('agent debug context inheritance must be boolean or null');
  }
  requireNullableInteger(context.messageCount, 'agent debug context message count');
  requireNullableInteger(context.charCount, 'agent debug context char count');
  if (!Array.isArray(context.injectedRefs)) throw new ContractError('agent debug context injected refs must be an array');
  for (const ref of context.injectedRefs) requireText(ref, 'agent debug context injected ref');
  if (context.compacted !== null && typeof context.compacted !== 'boolean') {
    throw new ContractError('agent debug context compacted must be boolean or null');
  }
  requireNullableText(context.omissionReason, 'agent debug context omission reason');
}

function validateModelDimension(model: AgentDebugInspection['model']): void {
  if (!model || typeof model !== 'object') throw new ContractError('agent debug model dimension must be an object');
  requireDimensionState(model.state, 'model');
  requireNullableText(model.provider, 'agent debug model provider');
  requireNullableText(model.requestedModel, 'agent debug requested model');
  requireNullableText(model.actualModel, 'agent debug actual model');
  if (!Number.isSafeInteger(model.retryCount) || model.retryCount < 0) {
    throw new ContractError('agent debug model retry count must be a non-negative safe integer');
  }
  validateTokenUsageInspection(model.tokenUsage);
  if (model.state === 'invoked-without-model') {
    if (model.tokenUsage.state !== 'not-applicable') {
      throw new ContractError('model invoked without a model requires not-applicable token usage');
    }
    if (model.tokenUsage.reason !== 'no-model-call') {
      throw new ContractError('model invoked without a model requires the no-model-call reason');
    }
  }
}

function validateToolsDimension(tools: AgentDebugInspection['tools']): void {
  if (!tools || typeof tools !== 'object') throw new ContractError('agent debug tools dimension must be an object');
  if (!['collected', 'invoked-without-tools', 'data-not-collected', 'not-invoked'].includes(tools.availableToolsState)) {
    throw new ContractError('agent debug available tools state is invalid');
  }
  if (!Array.isArray(tools.availableTools)) throw new ContractError('agent debug available tools must be an array');
  const names = new Set<string>();
  for (const name of tools.availableTools) {
    requireText(name, 'agent debug available tool');
    if (names.has(name)) throw new ContractError('agent debug available tools must not contain duplicates');
    names.add(name);
  }
  requireDimensionState(tools.callsState, 'tools calls');
  if (!Array.isArray(tools.calls)) throw new ContractError('agent debug tool calls must be an array');
  const callIds = new Set<string>();
  for (const call of tools.calls) {
    if (!call || typeof call !== 'object') throw new ContractError('agent debug tool call must be an object');
    requireText(call.callId, 'agent debug tool call id');
    if (callIds.has(call.callId)) throw new ContractError('agent debug tool call ids must be unique');
    callIds.add(call.callId);
    requireText(call.toolName, 'agent debug tool call name');
    if (!['running', 'succeeded', 'failed'].includes(call.state)) {
      throw new ContractError('agent debug tool call state is invalid');
    }
    if (call.durationMs !== null && (!Number.isSafeInteger(call.durationMs) || call.durationMs < 0)) {
      throw new ContractError('agent debug tool call duration must be a non-negative safe integer or null');
    }
    if (typeof call.redactedInputSummary !== 'string' || call.redactedInputSummary.length > 256) {
      throw new ContractError('agent debug tool call input summary must be at most 256 characters');
    }
    requireNullableText(call.outputRef, 'agent debug tool call output ref');
    requireNullableText(call.errorMessage, 'agent debug tool call error message');
  }
  if (tools.availableToolsState === 'invoked-without-tools' && (tools.availableTools.length > 0 || tools.calls.length > 0)) {
    throw new ContractError('invoked-without-tools cannot carry tools or calls');
  }
}

function validateErrorDimension(error: AgentDebugInspection['error']): void {
  if (!error || typeof error !== 'object') throw new ContractError('agent debug error dimension must be an object');
  if (!['present', 'none', 'data-not-collected'].includes(error.state)) {
    throw new ContractError('agent debug error state is invalid');
  }
  requireNullableText(error.code, 'agent debug error code');
  requireNullableText(error.message, 'agent debug error message');
  requireNullableText(error.owner, 'agent debug error owner');
  if (error.retryable !== null && typeof error.retryable !== 'boolean') {
    throw new ContractError('agent debug error retryable must be boolean or null');
  }
  requireNullableText(error.readonlyNextActionHint, 'agent debug readonly next action hint');
  if (error.state === 'present' && (error.code === null || error.message === null || error.owner === null || error.retryable === null)) {
    throw new ContractError('present agent debug error requires code, message, owner and retryable');
  }
  if (error.state === 'none' && (error.code !== null || error.message !== null || error.owner !== null || error.retryable !== null)) {
    throw new ContractError('absent agent debug error cannot carry an error');
  }
}

export function validateAgentDebugInspection(inspection: AgentDebugInspection): void {
  if (!inspection || typeof inspection !== 'object') throw new ContractError('agent debug inspection must be an object');
  requireRole(inspection.agentRole);
  if (!['not-invoked', 'active', 'completed', 'failed', 'rejected'].includes(inspection.invocationStatus)) {
    throw new ContractError('agent invocation status is invalid');
  }
  validateInvocationHistory(inspection);
  validateTurnDimension(inspection.turn);
  validateContextDimension(inspection.context);
  validateModelDimension(inspection.model);
  validateToolsDimension(inspection.tools);
  validateErrorDimension(inspection.error);
}
