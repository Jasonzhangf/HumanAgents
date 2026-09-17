import {
  ContractError,
  assertContextBudget,
  assertExecutionEpoch,
  assertScope,
  type AgentMemoryContext,
  type AgentMemoryContextEntry,
  type AgentMemoryContextInjectionPort,
  type AgentMemoryContextRequest,
  type ContextLayer,
  type MemoryOperationsPort,
  type MemoryBinding,
  type MemoryForgettingPlan,
  type MemoryForgettingRequest,
  type MemoryPromotionReceipt,
  type MemoryQueryRequest,
  type MemoryQueryResponse,
  type MemoryReviewReceipt,
  type MemoryScope,
  type MemorySubmission,
  type MemorySubmissionReceipt,
  type NextAction,
  type TaskId,
} from '../../../contracts/src/index.js';

export const MEMORY_COORDINATOR_OWNER = 'memory-coordinator';

export class MemoryCoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryCoordinatorError';
  }
}

export type MemoryFailureState = 'waiting' | 'attention';
export type MemoryFailurePolicy = MemoryFailureState;

export interface MemoryIssue {
  readonly code:
    | 'memory-binding-missing'
    | 'memory-binding-mismatch'
    | 'memory-context-unavailable'
    | 'memory-context-invalid'
    | 'memory-context-unbound'
    | 'memory-attach-unavailable'
    | 'memory-search-unavailable'
    | 'memory-binding-invalid'
    | 'memory-query-unavailable'
    | 'memory-submission-unavailable'
    | 'memory-review-unavailable'
    | 'memory-promotion-unavailable'
    | 'memory-forgetting-unavailable'
    | 'memory-capability-denied';
  readonly state: MemoryFailureState;
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: NextAction;
}

export type MemoryOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: MemoryFailureState; readonly issue: MemoryIssue };

export interface MemoryTaskBinding {
  readonly bindingId: string;
  readonly kind: 'task';
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly executionEpoch: number;
  readonly projectKey: string;
  readonly scope: MemoryScope;
  readonly backendRef: string;
  readonly indexVersion?: string;
  readonly operations: MemoryOperationsPort;
  readonly injection: AgentMemoryContextInjectionPort;
  readonly ownerId: string;
  readonly failurePolicy: MemoryFailurePolicy;
}

export interface MemoryTaskBindingReceipt {
  readonly bindingId: string;
  readonly kind: 'task';
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly executionEpoch: number;
  readonly projectKey: string;
  readonly scope: MemoryScope;
  readonly backendRef: string;
  readonly indexVersion?: string;
  readonly ownerId: string;
}

export interface MemoryRuntimeBinding {
  readonly agentRuntimeId: string;
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly roleId: string;
  readonly executionEpoch: number;
}

export interface MemoryInteractionBinding {
  readonly bindingId: string;
  readonly kind: 'interaction';
  readonly interactionScopeId: string;
  readonly projectKey: string;
  readonly backendRef: string;
  readonly indexVersion?: string;
  readonly operations: MemoryOperationsPort;
  readonly injection: AgentMemoryContextInjectionPort;
  readonly ownerId: string;
  readonly failurePolicy: MemoryFailurePolicy;
}

export interface MemoryBindingReceipt {
  readonly bindingId: string;
  readonly kind: 'task' | 'interaction';
  readonly taskId?: TaskId;
  readonly assignmentId?: string;
  readonly interactionScopeId?: string;
  readonly projectKey?: string;
  readonly backendRef: string;
  readonly indexVersion?: string;
  readonly ownerId: string;
}

export interface MemoryRuntimeBindingReceipt extends MemoryRuntimeBinding {
  readonly bindingId: string;
}

export interface MemoryContextEvidenceEntry {
  readonly layer: ContextLayer;
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly scope: string;
  readonly tokenCost: number;
}

export interface MemoryContextReceipt {
  readonly contextId: string;
  readonly bindingId: string;
  readonly agentRuntimeId: string;
  readonly taskId: TaskId;
  readonly roleId: string;
  readonly scope: MemoryScope;
  readonly layers: readonly ContextLayer[];
  readonly executionEpoch: number;
  readonly indexVersion?: string;
  readonly entries: readonly MemoryContextEvidenceEntry[];
  readonly omitted: AgentMemoryContext['omitted'];
}

export interface MemorySearchEntry {
  readonly sourceRef: string;
  readonly summary: string;
}

export interface MemoryContextAttachRequest {
  readonly agentRuntimeId: string;
  readonly taskId: TaskId;
  readonly scope: MemoryScope;
  readonly executionEpoch: number;
  readonly context: AgentMemoryContext;
}

export type SkillCandidateUniqueness = 'unique' | 'variant' | 'duplicate' | 'unknown';
export type SkillCandidateRepeatability = 'one-off' | 'observed' | 'recurring' | 'unknown';
export type SkillCandidateValue = 'low' | 'review' | 'high' | 'unknown';

export interface SkillCandidate {
  readonly candidateId: string;
  readonly taskId: TaskId;
  readonly pattern: string;
  readonly proposedRule: string;
  readonly evidenceRefs: readonly string[];
  readonly memoryRefs: readonly string[];
  readonly runtimeSessionRefs: readonly string[];
  readonly uniqueness: SkillCandidateUniqueness;
  readonly repeatability: SkillCandidateRepeatability;
  readonly value: SkillCandidateValue;
}

export interface SkillCandidateReviewRequest {
  readonly state: 'review-required';
  readonly candidate: SkillCandidate;
  readonly ownerId: string;
  readonly nextAction: NextAction;
}

interface StoredContext {
  readonly receipt: MemoryContextReceipt;
  readonly fingerprint: string;
}

const SKILL_UNIQUENESS: readonly SkillCandidateUniqueness[] = ['unique', 'variant', 'duplicate', 'unknown'];
const SKILL_REPEATABILITY: readonly SkillCandidateRepeatability[] = ['one-off', 'observed', 'recurring', 'unknown'];
const SKILL_VALUES: readonly SkillCandidateValue[] = ['low', 'review', 'high', 'unknown'];

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new MemoryCoordinatorError(`${label} is required`);
  return value;
}

function sameId(
  left: { readonly scope: string; readonly value: string },
  right: { readonly scope: string; readonly value: string },
): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function sameMemoryScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.kind === right.kind
    && sameId(left.organId, right.organId)
    && (left.taskId === undefined) === (right.taskId === undefined)
    && (left.taskId === undefined || sameId(left.taskId, right.taskId!));
}

function memoryScopeKey(scope: MemoryScope): string {
  return `${scope.kind}:${scope.organId.value}:${scope.taskId?.value ?? ''}`;
}

function entryScopeMatches(entryScope: string, request: AgentMemoryContextRequest): boolean {
  return entryScope === memoryScopeKey(request.scope);
}

function assertMemoryScope(scope: MemoryScope, taskId?: TaskId): void {
  assertScope(scope.organId, 'organ');
  if (scope.kind !== 'task' && scope.kind !== 'organ' && scope.kind !== 'approved-global') {
    throw new ContractError(`invalid memory scope kind: ${scope.kind}`);
  }
  if (scope.kind === 'task' && !scope.taskId) {
    throw new ContractError('task memory scope requires a task id');
  }
  if (scope.taskId) assertScope(scope.taskId, 'task');
  if (taskId && scope.taskId && !sameId(scope.taskId, taskId)) {
    throw new ContractError('memory scope task does not match binding task');
  }
}

function validateContextLayers(layers: readonly ContextLayer[]): void {
  if (layers.length === 0) throw new ContractError('memory context layers must not be empty');
  const seen = new Set<ContextLayer>();
  for (const layer of layers) {
    if (!['current', 'task-recent', 'related', 'approved-long-term', 'raw'].includes(layer)) {
      throw new ContractError(`invalid memory context layer: ${layer}`);
    }
    if (seen.has(layer)) throw new ContractError(`duplicate memory context layer: ${layer}`);
    seen.add(layer);
  }
}

function validateContextEntry(entry: AgentMemoryContextEntry, request: AgentMemoryContextRequest): void {
  nonEmpty(entry.layer, 'memory context entry layer');
  if (!request.layers.includes(entry.layer)) {
    throw new MemoryCoordinatorError(`memory context entry layer was not requested: ${entry.layer}`);
  }
  nonEmpty(entry.summary, 'memory context entry summary');
  nonEmpty(entry.sourceRef, 'memory context entry source ref');
  nonEmpty(entry.sourceDigest, 'memory context entry source digest');
  nonEmpty(entry.scope, 'memory context entry scope');
  if (!entryScopeMatches(entry.scope, request)) {
    throw new MemoryCoordinatorError(`memory context entry scope does not match requested scope: ${entry.scope}`);
  }
}

function validateContext(context: AgentMemoryContext, request: AgentMemoryContextRequest, indexVersion?: string): void {
  nonEmpty(context.contextId, 'memory context id');
  if (context.executionEpoch !== request.executionEpoch) {
    throw new MemoryCoordinatorError('memory context execution epoch does not match request');
  }
  if (indexVersion !== undefined && context.indexVersion !== indexVersion) {
    throw new MemoryCoordinatorError('memory context index version does not match task binding');
  }
  for (const entry of context.entries) validateContextEntry(entry, request);
  assertContextBudget(context, request.tokenBudget);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function contextFingerprint(context: AgentMemoryContext): string {
  return stableStringify({
    contextId: context.contextId,
    executionEpoch: context.executionEpoch,
    entries: context.entries,
    omitted: context.omitted,
    indexVersion: context.indexVersion,
  });
}

function issue(
  code: MemoryIssue['code'],
  state: MemoryFailureState,
  message: string,
  ownerId: string,
  target: string,
): MemoryIssue {
  return {
    code,
    state,
    ownerId,
    message,
    nextAction: state === 'waiting' ? { kind: 'wait', ref: target } : { kind: 'recover', ref: target },
  };
}

export class MemoryCoordinator {
  private readonly taskBindings = new Map<string, MemoryTaskBinding>();
  private readonly interactionBindings = new Map<string, MemoryInteractionBinding>();
  private readonly projectBindings = new Map<string, MemoryTaskBinding | MemoryInteractionBinding>();
  private readonly candidateBindings = new Map<string, string>();
  private readonly submissions = new Map<string, { readonly bindingRef: string; readonly actorId: string; readonly projectKey: string; readonly inputDigest: string }>();
  private readonly runtimeBindings = new Map<string, MemoryRuntimeBinding>();
  private readonly latestContexts = new Map<string, StoredContext>();

  bindInteraction(input: {
    readonly interactionScopeId: string;
    readonly projectKey: string;
    readonly backendRef: string;
    readonly indexVersion?: string;
    readonly operations: MemoryOperationsPort;
    readonly injection: AgentMemoryContextInjectionPort;
    readonly ownerId?: string;
    readonly failurePolicy?: MemoryFailurePolicy;
  }): MemoryBindingReceipt {
    const interactionScopeId = nonEmpty(input.interactionScopeId, 'memory interaction scope id');
    const projectKey = nonEmpty(input.projectKey, 'memory project key');
    const backendRef = nonEmpty(input.backendRef, 'memory backend ref');
    if (input.indexVersion !== undefined) nonEmpty(input.indexVersion, 'memory index version');
    const ownerId = input.ownerId === undefined ? MEMORY_COORDINATOR_OWNER : nonEmpty(input.ownerId, 'memory owner');
    const failurePolicy = input.failurePolicy ?? 'attention';
    if (failurePolicy !== 'waiting' && failurePolicy !== 'attention') {
      throw new MemoryCoordinatorError(`invalid memory failure policy: ${failurePolicy}`);
    }
    const existing = this.interactionBindings.get(interactionScopeId);
    if (existing) {
      if (
        existing.backendRef === backendRef
        && existing.projectKey === projectKey
        && existing.indexVersion === input.indexVersion
        && existing.operations === input.operations
        && existing.injection === input.injection
        && existing.ownerId === ownerId
        && existing.failurePolicy === failurePolicy
      ) {
        return this.interactionReceipt(existing);
      }
      throw new MemoryCoordinatorError(`memory interaction binding already exists: ${interactionScopeId}`);
    }
    const binding: MemoryInteractionBinding = {
      bindingId: `memory-binding:interaction:${interactionScopeId}`,
      kind: 'interaction',
      interactionScopeId,
      projectKey,
      backendRef,
      indexVersion: input.indexVersion,
      operations: input.operations,
      injection: input.injection,
      ownerId,
      failurePolicy,
    };
    this.bindProject(projectKey, binding);
    this.interactionBindings.set(interactionScopeId, binding);
    return this.interactionReceipt(binding);
  }

  async query(input: MemoryQueryRequest): Promise<MemoryOutcome<MemoryQueryResponse>> {
    const bindingResult = this.resolveMemoryBinding(input.bindingRef);
    if (bindingResult.status !== 'ready') return bindingResult;
    const { binding, operations, ownerId } = bindingResult.value;
    if (input.projectKey !== binding.projectKey) {
      return this.failure(
        'memory-binding-mismatch',
        undefined,
        'memory query project does not match the binding',
        'memory-binding-refresh',
        'attention',
        ownerId,
      );
    }
    if (!input.actor.permissions.includes('memory.read')) {
      return this.failure(
        'memory-capability-denied',
        undefined,
        'memory query requires memory.read permission',
        'memory-permission',
        'attention',
        ownerId,
      );
    }
    if (input.namespace === 'global' && !input.actor.crossProjectGrantRef) {
      return this.failure(
        'memory-capability-denied',
        undefined,
        'global memory query requires a cross-project grant',
        'memory-permission',
        'attention',
        ownerId,
      );
    }
    try {
      return { status: 'ready', value: await operations.query(input) };
    } catch (error) {
      if (error instanceof ContractError) throw error;
      return this.failure(
        'memory-query-unavailable',
        undefined,
        'memory query operations are unavailable',
        'memory-operations-ready',
        undefined,
        ownerId,
      );
    }
  }

  async submitCandidate(input: MemorySubmission): Promise<MemoryOutcome<MemorySubmissionReceipt>> {
    const bindingResult = this.resolveMemoryBinding(input.bindingRef);
    if (bindingResult.status !== 'ready') return bindingResult;
    const { binding, operations, ownerId } = bindingResult.value;
    if (!input.actor.permissions.includes('memory.propose')) {
      return this.failure(
        'memory-capability-denied',
        undefined,
        'memory submission requires memory.propose permission',
        'memory-permission',
        'attention',
        ownerId,
      );
    }
    if (binding.kind === 'task') {
      const mismatch = this.taskBindingMismatch(binding, input);
      if (mismatch) {
        return this.failure(
          'memory-binding-mismatch',
          binding,
          mismatch,
          'memory-binding-refresh',
          'attention',
          ownerId,
        );
      }
    } else if (input.projectKey !== binding.projectKey) {
      return this.failure(
        'memory-binding-mismatch',
        undefined,
        'memory submission project does not match the interaction binding',
        'memory-binding-refresh',
        'attention',
        ownerId,
      );
    }
    const existingSubmission = this.submissions.get(input.submissionId);
    if (existingSubmission) {
      if (
        existingSubmission.bindingRef !== input.bindingRef
        || existingSubmission.actorId !== input.actor.actorId
        || existingSubmission.projectKey !== input.projectKey
        || existingSubmission.inputDigest !== input.inputDigest
      ) {
        return this.failure(
          'memory-binding-mismatch',
          undefined,
          'memory submission identity conflicts with an existing submission',
          'memory-binding-refresh',
          'attention',
          ownerId,
        );
      }
    }
    try {
      const receipt = await operations.submitCandidate(input);
      if (receipt.status === 'accepted' || receipt.status === 'duplicate' || receipt.status === 'queued') {
        const candidateId = receipt.candidateId;
        if (candidateId?.trim()) {
          const existingBindingRef = this.candidateBindings.get(candidateId);
          if (existingBindingRef !== undefined && existingBindingRef !== input.bindingRef) {
            return this.failure(
              'memory-binding-mismatch',
              undefined,
              'memory candidate identity is already bound to a different backend',
              'memory-binding-refresh',
              'attention',
              ownerId,
            );
          }
          this.candidateBindings.set(candidateId, input.bindingRef);
        }
      }
      this.submissions.set(input.submissionId, {
        bindingRef: input.bindingRef,
        actorId: input.actor.actorId,
        projectKey: input.projectKey,
        inputDigest: input.inputDigest,
      });
      return { status: 'ready', value: receipt };
    } catch (error) {
      if (error instanceof ContractError) throw error;
      return this.failure(
        'memory-submission-unavailable',
        undefined,
        'memory candidate submission is unavailable',
        'memory-operations-ready',
        undefined,
        ownerId,
      );
    }
  }

  async reviewCandidate(input: MemoryReviewReceipt): Promise<MemoryOutcome<MemoryReviewReceipt>> {
    const bindingResult = this.resolveMemoryBindingForCandidate(input.candidateId);
    if (bindingResult.status !== 'ready') return bindingResult;
    const { projectKey, operations, ownerId } = bindingResult.value;
    if (input.actor.projectKey !== projectKey) {
      return this.failure(
        'memory-capability-denied',
        undefined,
        'memory review actor project does not match the candidate binding',
        'memory-permission',
        'attention',
        ownerId,
      );
    }
    if (!input.actor.permissions.includes('memory.review')) {
      return this.failure(
        'memory-capability-denied',
        undefined,
        'memory review requires memory.review permission',
        'memory-permission',
        'attention',
        ownerId,
      );
    }
    try {
      return { status: 'ready', value: await operations.reviewCandidate(input) };
    } catch (error) {
      if (error instanceof ContractError) throw error;
      return this.failure(
        'memory-review-unavailable',
        undefined,
        'memory review operations are unavailable',
        'memory-operations-ready',
        undefined,
        ownerId,
      );
    }
  }

  async promoteCandidate(input: MemoryPromotionReceipt): Promise<MemoryOutcome<MemoryPromotionReceipt>> {
    const bindingResult = this.resolveMemoryBindingForCandidate(input.candidateId);
    if (bindingResult.status !== 'ready') return bindingResult;
    const { projectKey, operations, ownerId } = bindingResult.value;
    if (input.actor.projectKey !== projectKey) {
      return this.failure(
        'memory-capability-denied',
        undefined,
        'memory promotion actor project does not match the candidate binding',
        'memory-permission',
        'attention',
        ownerId,
      );
    }
    if (!input.actor.permissions.includes('memory.promote')) {
      return this.failure(
        'memory-capability-denied',
        undefined,
        'memory promotion requires memory.promote permission',
        'memory-permission',
        'attention',
        ownerId,
      );
    }
    try {
      return { status: 'ready', value: await operations.promoteCandidate(input) };
    } catch (error) {
      if (error instanceof ContractError) throw error;
      return this.failure(
        'memory-promotion-unavailable',
        undefined,
        'memory promotion operations are unavailable',
        'memory-operations-ready',
        undefined,
        ownerId,
      );
    }
  }

  async planForgetting(input: MemoryForgettingRequest): Promise<MemoryOutcome<MemoryForgettingPlan>> {
    if (!input.actor.permissions.includes('memory.forget')) {
      return this.failure(
        'memory-capability-denied',
        undefined,
        'memory forgetting requires memory.forget permission',
        'memory-permission',
        'attention',
      );
    }
    if (input.plan.namespace === 'project' && input.actor.projectKey !== input.plan.projectKey) {
      return this.failure(
        'memory-capability-denied',
        undefined,
        'memory forgetting actor project does not match the plan',
        'memory-permission',
        'attention',
      );
    }
    if (input.plan.namespace === 'global' && !input.actor.crossProjectGrantRef) {
      return this.failure(
        'memory-capability-denied',
        undefined,
        'global memory forgetting requires a cross-project grant',
        'memory-permission',
        'attention',
      );
    }
    const bindingResult = this.resolveProjectBinding(input.actor.projectKey);
    if (bindingResult.status !== 'ready') return bindingResult;
    const { operations, ownerId } = bindingResult.value;
    try {
      return { status: 'ready', value: await operations.planForgetting(input) };
    } catch (error) {
      if (error instanceof ContractError) throw error;
      return this.failure(
        'memory-forgetting-unavailable',
        undefined,
        'memory forgetting operations are unavailable',
        'memory-operations-ready',
        undefined,
        ownerId,
      );
    }
  }

  bindTask(input: {
    readonly taskId: TaskId;
    readonly assignmentId: string;
    readonly executionEpoch: number;
    readonly projectKey: string;
    readonly scope: MemoryScope;
    readonly backendRef: string;
    readonly indexVersion?: string;
    readonly operations: MemoryOperationsPort;
    readonly injection: AgentMemoryContextInjectionPort;
    readonly ownerId?: string;
    readonly failurePolicy?: MemoryFailurePolicy;
  }): MemoryTaskBindingReceipt {
    assertScope(input.taskId, 'task');
    const assignmentId = nonEmpty(input.assignmentId, 'memory assignment id');
    assertExecutionEpoch(input.executionEpoch);
    const projectKey = nonEmpty(input.projectKey, 'memory project key');
    assertMemoryScope(input.scope, input.taskId);
    const backendRef = nonEmpty(input.backendRef, 'memory backend ref');
    if (input.indexVersion !== undefined) nonEmpty(input.indexVersion, 'memory index version');
    const ownerId = input.ownerId === undefined ? MEMORY_COORDINATOR_OWNER : nonEmpty(input.ownerId, 'memory owner');
    const failurePolicy = input.failurePolicy ?? 'attention';
    if (failurePolicy !== 'waiting' && failurePolicy !== 'attention') {
      throw new MemoryCoordinatorError(`invalid memory failure policy: ${failurePolicy}`);
    }
    const existing = this.taskBindings.get(input.taskId.value);
    if (existing) {
      const compatible = sameMemoryScope(existing.scope, input.scope)
        && existing.projectKey === projectKey
        && existing.backendRef === backendRef
        && existing.indexVersion === input.indexVersion
        && existing.operations === input.operations
        && existing.injection === input.injection
        && existing.ownerId === ownerId
        && existing.failurePolicy === failurePolicy;
      if (!compatible) {
        throw new MemoryCoordinatorError(`memory binding identity conflicts for task: ${input.taskId.value}`);
      }
      if (
        existing.assignmentId === assignmentId
        && existing.executionEpoch === input.executionEpoch
      ) {
        return this.taskReceipt(existing);
      }
      if (
        existing.assignmentId === assignmentId
        || existing.executionEpoch >= input.executionEpoch
      ) {
        throw new MemoryCoordinatorError(`memory binding advance must use a new assignment and execution epoch for task: ${input.taskId.value}`);
      }
      const advanced: MemoryTaskBinding = {
        ...existing,
        bindingId: `memory-binding:${input.taskId.value}:${assignmentId}`,
        assignmentId,
        executionEpoch: input.executionEpoch,
      };
      this.taskBindings.set(input.taskId.value, advanced);
      this.invalidateTaskRuntimeBindings(input.taskId);
      return this.taskReceipt(advanced);
    }
    const binding: MemoryTaskBinding = {
      bindingId: `memory-binding:${input.taskId.value}`,
      kind: 'task',
      taskId: input.taskId,
      assignmentId,
      executionEpoch: input.executionEpoch,
      projectKey,
      scope: input.scope,
      backendRef,
      indexVersion: input.indexVersion,
      operations: input.operations,
      injection: input.injection,
      ownerId,
      failurePolicy,
    };
    this.bindProject(projectKey, binding);
    this.taskBindings.set(input.taskId.value, binding);
    return this.taskReceipt(binding);
  }

  bindRuntime(input: {
    readonly agentRuntimeId: string;
    readonly taskId: TaskId;
    readonly assignmentId: string;
    readonly roleId: string;
    readonly executionEpoch: number;
  }): MemoryOutcome<MemoryRuntimeBindingReceipt> {
    const agentRuntimeId = nonEmpty(input.agentRuntimeId, 'agent runtime id');
    assertScope(input.taskId, 'task');
    const assignmentId = nonEmpty(input.assignmentId, 'memory assignment id');
    const roleId = nonEmpty(input.roleId, 'memory role id');
    assertExecutionEpoch(input.executionEpoch);
    const taskBinding = this.taskBindings.get(input.taskId.value);
    if (!taskBinding) return this.failure('memory-binding-missing', taskBinding, 'task memory binding is missing', 'memory-binding');
    if (taskBinding.assignmentId !== assignmentId) {
      return this.failure(
        'memory-binding-mismatch',
        taskBinding,
        'agent runtime assignment does not match the task memory binding',
        'memory-binding-refresh',
      );
    }
    if (taskBinding.executionEpoch !== input.executionEpoch) {
      return this.failure(
        'memory-binding-mismatch',
        taskBinding,
        'agent runtime execution epoch does not match the task memory binding',
        'memory-binding-refresh',
      );
    }

    const existing = this.runtimeBindings.get(agentRuntimeId);
    if (existing) {
      if (
        sameId(existing.taskId, input.taskId)
        && existing.assignmentId === assignmentId
        && existing.roleId === roleId
        && existing.executionEpoch === input.executionEpoch
      ) {
        return {
          status: 'ready',
          value: { ...existing, bindingId: taskBinding.bindingId },
        };
      }
      return this.failure(
        'memory-binding-mismatch',
        taskBinding,
        'agent runtime memory binding already exists with a different task, role, or epoch',
        'memory-binding-conflict',
      );
    }

    const binding: MemoryRuntimeBinding = {
      agentRuntimeId,
      taskId: input.taskId,
      assignmentId,
      roleId,
      executionEpoch: input.executionEpoch,
    };
    this.runtimeBindings.set(agentRuntimeId, binding);
    return { status: 'ready', value: { ...binding, bindingId: taskBinding.bindingId } };
  }

  async search(input: {
    readonly agentRuntimeId: string;
    readonly query: string;
    readonly limit: number;
  }): Promise<MemoryOutcome<readonly MemorySearchEntry[]>> {
    const bindingResult = this.resolveRuntime(input.agentRuntimeId);
    if (bindingResult.status !== 'ready') return bindingResult;
    const { taskBinding } = bindingResult.value;
    const query = nonEmpty(input.query, 'memory query');
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new ContractError('memory search limit must be a positive safe integer');
    }
    try {
      const entries = await taskBinding.operations.search({
        scope: taskBinding.scope,
        query,
        limit: input.limit,
      });
      return { status: 'ready', value: entries.map((entry) => ({ ...entry })) };
    } catch {
      return this.failure(
        'memory-search-unavailable',
        taskBinding,
        'memory operations are unavailable',
        'memory-operations-ready',
      );
    }
  }

  async recall(input: AgentMemoryContextRequest): Promise<MemoryOutcome<MemoryContextReceipt>> {
    const agentRuntimeId = nonEmpty(input.agentRuntimeId, 'agent runtime id');
    assertScope(input.taskId, 'task');
    assertMemoryScope(input.scope, input.taskId);
    const roleId = nonEmpty(input.roleId, 'memory role id');
    assertExecutionEpoch(input.executionEpoch);
    validateContextLayers(input.layers);
    if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 0) {
      throw new ContractError('memory context token budget must be a non-negative safe integer');
    }
    if (input.query !== undefined && !input.query.trim()) {
      throw new ContractError('memory context query must be non-empty when provided');
    }

    const runtimeResult = this.resolveRuntime(agentRuntimeId);
    if (runtimeResult.status !== 'ready') return runtimeResult;
    const { binding: runtimeBinding, taskBinding } = runtimeResult.value;
    if (
      !sameId(runtimeBinding.taskId, input.taskId)
      || runtimeBinding.roleId !== roleId
      || runtimeBinding.executionEpoch !== input.executionEpoch
      || !sameMemoryScope(taskBinding.scope, input.scope)
    ) {
      return this.failure(
        'memory-binding-mismatch',
        taskBinding,
        'memory recall request does not match the bound task, scope, role, or execution epoch',
        'memory-binding-refresh',
      );
    }

    let context: AgentMemoryContext;
    try {
      context = await taskBinding.injection.recall({
        ...input,
        agentRuntimeId,
        roleId,
        layers: [...input.layers],
      });
    } catch {
      return this.failure(
        'memory-context-unavailable',
        taskBinding,
        'memory context injection is unavailable',
        'memory-context-ready',
      );
    }

    try {
      validateContext(context, input, taskBinding.indexVersion);
    } catch (error) {
      const validationMessage = error instanceof Error ? error.message : 'memory context failed validation';
      return this.failure(
        'memory-context-invalid',
        taskBinding,
        `memory context failed evidence, scope, or budget validation: ${validationMessage}`,
        'memory-context-integrity',
        'attention',
      );
    }

    const receipt: MemoryContextReceipt = {
      contextId: context.contextId,
      bindingId: taskBinding.bindingId,
      agentRuntimeId,
      taskId: input.taskId,
      roleId,
      scope: input.scope,
      layers: [...input.layers],
      executionEpoch: input.executionEpoch,
      indexVersion: context.indexVersion,
      entries: context.entries.map((entry) => ({
        layer: entry.layer,
        sourceRef: entry.sourceRef,
        sourceDigest: entry.sourceDigest,
        scope: entry.scope,
        tokenCost: entry.tokenCost,
      })),
      omitted: context.omitted.map((omitted) => ({ ...omitted })),
    };
    this.latestContexts.set(agentRuntimeId, {
      receipt,
      fingerprint: contextFingerprint(context),
    });
    return { status: 'ready', value: receipt };
  }

  async attach(input: MemoryContextAttachRequest): Promise<MemoryOutcome<MemoryContextReceipt>> {
    const agentRuntimeId = nonEmpty(input.agentRuntimeId, 'agent runtime id');
    assertScope(input.taskId, 'task');
    assertMemoryScope(input.scope, input.taskId);
    assertExecutionEpoch(input.executionEpoch);
    const runtimeResult = this.resolveRuntime(agentRuntimeId);
    if (runtimeResult.status !== 'ready') return runtimeResult;
    const { binding: runtimeBinding, taskBinding } = runtimeResult.value;
    if (
      !sameId(runtimeBinding.taskId, input.taskId)
      || runtimeBinding.executionEpoch !== input.executionEpoch
      || !sameMemoryScope(taskBinding.scope, input.scope)
    ) {
      return this.failure(
        'memory-binding-mismatch',
        taskBinding,
        'memory attach request does not match the bound task, scope, or execution epoch',
        'memory-binding-refresh',
      );
    }
    if (input.context.executionEpoch !== input.executionEpoch) {
      return this.failure(
        'memory-context-invalid',
        taskBinding,
        'memory context execution epoch does not match attach request',
        'memory-context-refresh',
        'attention',
      );
    }
    const stored = this.latestContexts.get(agentRuntimeId);
    if (!stored || stored.receipt.contextId !== input.context.contextId) {
      return this.failure(
        'memory-context-unbound',
        taskBinding,
        'memory context is not the latest context recalled for this agent runtime',
        'memory-context-recall',
        'attention',
      );
    }
    if (stored.fingerprint !== contextFingerprint(input.context)) {
      return this.failure(
        'memory-context-invalid',
        taskBinding,
        'memory context changed after recall',
        'memory-context-integrity',
        'attention',
      );
    }

    let attached: { readonly contextId: string; readonly attached: boolean };
    try {
      attached = await taskBinding.injection.attach({ agentRuntimeId, context: input.context });
    } catch {
      return this.attachFailure(taskBinding, 'memory context attach is unavailable');
    }
    if (!attached.attached) return this.attachFailure(taskBinding, 'memory context attach did not complete');
    if (attached.contextId !== input.context.contextId) {
      return this.failure(
        'memory-context-invalid',
        taskBinding,
        'memory context attach returned a different context id',
        'memory-context-integrity',
        'attention',
      );
    }
    return { status: 'ready', value: stored.receipt };
  }

  proposeSkillCandidate(candidate: SkillCandidate): SkillCandidateReviewRequest {
    assertScope(candidate.taskId, 'task');
    nonEmpty(candidate.candidateId, 'skill candidate id');
    nonEmpty(candidate.pattern, 'skill candidate pattern');
    nonEmpty(candidate.proposedRule, 'skill candidate rule');
    if (candidate.evidenceRefs.length === 0) {
      throw new MemoryCoordinatorError('skill candidate requires evidence');
    }
    for (const ref of candidate.evidenceRefs) nonEmpty(ref, 'skill candidate evidence ref');
    for (const ref of candidate.memoryRefs) nonEmpty(ref, 'skill candidate memory ref');
    for (const ref of candidate.runtimeSessionRefs) nonEmpty(ref, 'skill candidate runtime session ref');
    if (!SKILL_UNIQUENESS.includes(candidate.uniqueness)) {
      throw new MemoryCoordinatorError(`invalid skill candidate uniqueness: ${candidate.uniqueness}`);
    }
    if (!SKILL_REPEATABILITY.includes(candidate.repeatability)) {
      throw new MemoryCoordinatorError(`invalid skill candidate repeatability: ${candidate.repeatability}`);
    }
    if (!SKILL_VALUES.includes(candidate.value)) {
      throw new MemoryCoordinatorError(`invalid skill candidate value: ${candidate.value}`);
    }
    return {
      state: 'review-required',
      candidate: {
        ...candidate,
        evidenceRefs: [...candidate.evidenceRefs],
        memoryRefs: [...candidate.memoryRefs],
        runtimeSessionRefs: [...candidate.runtimeSessionRefs],
      },
      ownerId: MEMORY_COORDINATOR_OWNER,
      nextAction: { kind: 'wait', ref: `skill-review:${candidate.candidateId}` },
    };
  }

  private resolveRuntime(agentRuntimeId: string): MemoryOutcome<{
    readonly binding: MemoryRuntimeBinding;
    readonly taskBinding: MemoryTaskBinding;
  }> {
    const runtimeBinding = this.runtimeBindings.get(agentRuntimeId);
    const taskBinding = runtimeBinding ? this.taskBindings.get(runtimeBinding.taskId.value) : undefined;
    if (!runtimeBinding || !taskBinding) {
      return this.failure(
        'memory-binding-missing',
        taskBinding,
        `memory runtime binding is missing: ${agentRuntimeId}`,
        'memory-binding',
      );
    }
    return { status: 'ready', value: { binding: runtimeBinding, taskBinding } };
  }

  private invalidateTaskRuntimeBindings(taskId: TaskId): void {
    const invalidated = [...this.runtimeBindings.entries()]
      .filter(([, binding]) => sameId(binding.taskId, taskId));
    for (const [agentRuntimeId] of invalidated) {
      this.runtimeBindings.delete(agentRuntimeId);
      this.latestContexts.delete(agentRuntimeId);
    }
  }

  private resolveMemoryBinding(bindingRef: string): MemoryOutcome<{
    readonly binding: MemoryTaskBinding | MemoryInteractionBinding;
    readonly operations: MemoryOperationsPort;
    readonly injection: AgentMemoryContextInjectionPort;
    readonly ownerId: string;
  }> {
    const ref = nonEmpty(bindingRef, 'memory binding ref');
    for (const binding of [...this.taskBindings.values(), ...this.interactionBindings.values()]) {
      if (binding.bindingId !== ref) continue;
      return {
        status: 'ready',
        value: {
          binding,
          operations: binding.operations,
          injection: binding.injection,
          ownerId: binding.ownerId,
        },
      };
    }
    return this.failure(
      'memory-binding-missing',
      undefined,
      `memory binding is not registered: ${ref}`,
      'memory-binding',
    );
  }

  private resolveMemoryBindingForCandidate(candidateId: string): MemoryOutcome<{
    readonly projectKey: string;
    readonly operations: MemoryOperationsPort;
    readonly ownerId: string;
  }> {
    const ref = nonEmpty(candidateId, 'memory candidate id');
    const bindingRef = this.candidateBindings.get(ref);
    const binding = bindingRef === undefined
      ? undefined
      : [...this.taskBindings.values(), ...this.interactionBindings.values()]
        .find((candidate) => candidate.bindingId === bindingRef);
    if (!binding) {
      return this.failure(
        'memory-binding-missing',
        undefined,
        `memory candidate is not bound to a registered backend: ${ref}`,
        'memory-binding',
      );
    }
    return {
      status: 'ready',
      value: { projectKey: binding.projectKey, operations: binding.operations, ownerId: binding.ownerId },
    };
  }

  private resolveProjectBinding(projectKey: string): MemoryOutcome<{
    readonly operations: MemoryOperationsPort;
    readonly ownerId: string;
  }> {
    const key = nonEmpty(projectKey, 'memory project key');
    const binding = this.projectBindings.get(key);
    if (!binding) {
      return this.failure(
        'memory-binding-missing',
        undefined,
        `memory binding is not registered for project: ${key}`,
        'memory-binding',
      );
    }
    return {
      status: 'ready',
      value: { operations: binding.operations, ownerId: binding.ownerId },
    };
  }

  private bindProject(projectKey: string, binding: MemoryTaskBinding | MemoryInteractionBinding): void {
    const existing = this.projectBindings.get(projectKey);
    if (existing) {
      if (
        existing.backendRef !== binding.backendRef
        || existing.indexVersion !== binding.indexVersion
        || existing.operations !== binding.operations
        || existing.injection !== binding.injection
        || existing.ownerId !== binding.ownerId
      ) {
        throw new MemoryCoordinatorError(`memory backend binding conflicts for project: ${projectKey}`);
      }
      return;
    }
    this.projectBindings.set(projectKey, binding);
  }

  private taskReceipt(binding: MemoryTaskBinding): MemoryTaskBindingReceipt {
    return {
      bindingId: binding.bindingId,
      kind: 'task',
      taskId: binding.taskId,
      assignmentId: binding.assignmentId,
      executionEpoch: binding.executionEpoch,
      projectKey: binding.projectKey,
      scope: binding.scope,
      backendRef: binding.backendRef,
      indexVersion: binding.indexVersion,
      ownerId: binding.ownerId,
    };
  }

  private taskBindingMismatch(binding: MemoryTaskBinding, input: MemorySubmission): string | null {
    if (input.projectKey !== binding.projectKey) {
      return 'memory submission project does not match the task binding';
    }
    if (input.taskId === undefined || !sameId(input.taskId, binding.taskId)) {
      return 'memory submission task does not match the task binding';
    }
    return null;
  }

  private interactionReceipt(binding: MemoryInteractionBinding): MemoryBindingReceipt {
    return {
      bindingId: binding.bindingId,
      kind: 'interaction',
      interactionScopeId: binding.interactionScopeId,
      projectKey: binding.projectKey,
      backendRef: binding.backendRef,
      indexVersion: binding.indexVersion,
      ownerId: binding.ownerId,
    };
  }

  private attachFailure(taskBinding: MemoryTaskBinding, message: string): MemoryOutcome<never> {
    return this.failure(
      'memory-attach-unavailable',
      taskBinding,
      message,
      'memory-attach-ready',
    );
  }

  private failure(
    code: MemoryIssue['code'],
    taskBinding: MemoryTaskBinding | undefined,
    message: string,
    target: string,
    state?: MemoryFailureState,
    ownerId?: string,
  ): MemoryOutcome<never> {
    const failureState = state ?? taskBinding?.failurePolicy ?? 'attention';
    return {
      status: failureState,
      issue: issue(code, failureState, message, ownerId ?? taskBinding?.ownerId ?? MEMORY_COORDINATOR_OWNER, target),
    };
  }
}
