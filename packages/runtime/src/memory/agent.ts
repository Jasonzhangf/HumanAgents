import { createHash } from 'node:crypto';
import {
  ContractError,
  validateAuditPromptSnapshot,
  validateMemoryActor,
  validateMemoryCurationResult,
  validateMemoryFollowUpRequest,
  validateProjectSourceUpdateProposal,
  type AuditPromptSnapshot,
  type MemoryActorContext,
  type MemoryAgentStatePort,
  type MemoryAuditPromptSourcePort,
  type MemoryCandidateCategory,
  type MemoryCurationResult,
  type MemoryFollowUpRequest,
  type MemoryOperationsPort,
  type MemoryProjectSourcePort,
  type MemoryProjectSourceSnapshot,
  type MemoryScope,
  type MemorySessionEvidence,
  type MemorySessionEvidenceSourcePort,
  type MemorySubmission,
  type MemorySubmissionReceipt,
  type OperationId,
  type ProjectSourceUpdateProposal,
  type ScopedId,
  type TaskId,
} from '../../../contracts/src/index.js';

export const MEMORY_AGENT_OWNER = 'memory-agent';

export type MemoryAgentFailureState = 'waiting' | 'attention';

export interface MemoryAgentIssue {
  readonly code:
    | 'memory-agent-binding-missing'
    | 'memory-agent-binding-mismatch'
    | 'memory-agent-source-unavailable'
    | 'memory-agent-source-invalid'
    | 'memory-agent-source-scope-denied'
    | 'memory-agent-prompt-unavailable'
    | 'memory-agent-analysis-unavailable'
    | 'memory-agent-follow-up-stale'
    | 'memory-agent-follow-up-conflict'
    | 'memory-agent-update-denied'
    | 'memory-agent-update-conflict'
    | 'memory-agent-update-validation-failed'
    | 'memory-agent-event-unsupported'
    | 'memory-agent-event-invalid'
    | 'memory-agent-event-scope-mismatch'
    | 'memory-agent-event-evidence-missing';
  readonly state: MemoryAgentFailureState;
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: { readonly kind: 'wait' | 'recover'; readonly ref: string };
}

export type MemoryAgentOutcome<T> =
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: MemoryAgentFailureState; readonly issue: MemoryAgentIssue };

export interface MemoryAnalysisRequest {
  readonly operationId: OperationId;
  readonly bindingRef: string;
  readonly actor: MemoryActorContext;
  readonly projectKey: string;
  readonly scope: MemoryScope;
  readonly taskId?: TaskId;
  readonly interactionScopeId?: string;
  readonly sessionRef?: string;
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
  readonly observation: string;
  readonly requestedKind: 'episodic' | 'semantic' | 'procedural';
  readonly candidateCategory: MemoryCandidateCategory;
  readonly executionEpoch: number;
  readonly trigger: 'blocked' | 'rewind' | 'completion' | 'explicit-submission';
}

export interface MemoryAnalysisBinding {
  readonly bindingRef: string;
  readonly projectKey: string;
  readonly scope: MemoryScope;
  readonly taskId?: TaskId;
  readonly interactionScopeId?: string;
  readonly mainAgentId: string;
  readonly executionEpoch: number;
  readonly ownerId: string;
  readonly operations: MemoryOperationsPort;
}

export interface MemoryFollowUpResult extends MemoryAnalysisResult {
  readonly requestId: string;
  readonly correlationId: string;
  readonly inReplyTo: string;
  readonly operationId: OperationId;
}

export interface MemorySourceUpdateReceipt {
  readonly target: ProjectSourceUpdateProposal['target'];
  readonly sourceRef: string;
  readonly previousRevision: string;
  readonly previousDigest: string;
  readonly nextRevision: string;
  readonly nextDigest: string;
  readonly updated: boolean;
  readonly evidenceRefs: readonly string[];
}

export interface MemoryProjectUpdateOwnerPort {
  apply(input: {
    readonly proposal: ProjectSourceUpdateProposal;
    readonly current: MemoryProjectSourceSnapshot;
    readonly auto: boolean;
  }): Promise<MemorySourceUpdateReceipt>;
}

export interface MemoryAnalysisResult {
  readonly curation: MemoryCurationResult;
  readonly submission?: MemorySubmissionReceipt;
  readonly projectSources: readonly MemoryProjectSourceSnapshot[];
  readonly proposal?: ProjectSourceUpdateProposal;
  readonly liveContextMutated: false;
  readonly promptSnapshot: AuditPromptSnapshot;
}

export interface MemoryAgentOptions {
  readonly projectKey: string;
  readonly auditPromptRef: string;
  readonly autoUpdate: boolean;
  readonly sessions: MemorySessionEvidenceSourcePort;
  readonly projectSources: MemoryProjectSourcePort;
  readonly auditPrompts: MemoryAuditPromptSourcePort;
  readonly projectUpdateOwner: MemoryProjectUpdateOwnerPort;
  readonly state?: MemoryAgentStatePort;
  readonly now?: () => string;
}

interface BoundAnalysis {
  readonly binding: MemoryAnalysisBinding;
  readonly sessionEvidence?: MemorySessionEvidence;
}

interface FollowUpRecord {
  readonly request: MemoryFollowUpRequest;
  readonly acceptedAt: string;
  readonly result?: MemoryFollowUpResult;
}

interface AcceptedAnalysis {
  readonly request: MemoryAnalysisRequest;
  readonly acceptedAt: string;
}

interface PersistedMemoryAgentState {
  readonly version: 1;
  readonly analyses: readonly AcceptedAnalysis[];
  readonly followUps: readonly FollowUpRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidPersistedState(): never {
  throw new ContractError('persisted memory agent state is invalid');
}

function assertPersisted(condition: unknown): asserts condition {
  if (!condition) invalidPersistedState();
}

function validatePersistedId(
  value: unknown,
  expectedScope: 'operation' | 'organ' | 'task',
): asserts value is ScopedId {
  assertPersisted(isRecord(value));
  assertPersisted(value.scope === expectedScope);
  assertPersisted(typeof value.value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.value));
}

function validatePersistedMemoryScope(value: unknown): asserts value is MemoryScope {
  assertPersisted(isRecord(value));
  assertPersisted(value.kind === 'task' || value.kind === 'organ' || value.kind === 'approved-global');
  validatePersistedId(value.organId, 'organ');
  if (value.kind === 'task') {
    validatePersistedId(value.taskId, 'task');
  } else {
    assertPersisted(value.taskId === undefined);
  }
}

function validatePersistedTimestamp(value: unknown): void {
  assertPersisted(typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value)));
}

function validatePersistedStringArray(value: unknown): asserts value is readonly string[] {
  assertPersisted(Array.isArray(value) && value.length > 0);
  for (const entry of value) {
    assertPersisted(typeof entry === 'string' && entry.trim().length > 0);
  }
}

function validatePersistedAnalysisRequest(value: unknown): asserts value is MemoryAnalysisRequest {
  assertPersisted(isRecord(value));
  validatePersistedId(value.operationId, 'operation');
  assertPersisted(typeof value.bindingRef === 'string' && value.bindingRef.trim().length > 0);
  assertPersisted(typeof value.projectKey === 'string' && value.projectKey.trim().length > 0);
  validatePersistedMemoryScope(value.scope);
  assertPersisted((value.taskId === undefined) !== (value.interactionScopeId === undefined));
  if (value.taskId !== undefined) {
    validatePersistedId(value.taskId, 'task');
    assertPersisted(value.scope.kind === 'task');
    assertPersisted(
      (value.scope as MemoryScope).taskId?.scope === 'task'
      && (value.scope as MemoryScope).taskId?.value === value.taskId.value,
    );
  }
  if (value.interactionScopeId !== undefined) {
    assertPersisted(typeof value.interactionScopeId === 'string' && value.interactionScopeId.trim().length > 0);
    assertPersisted(value.scope.kind !== 'task');
  }
  if (value.sessionRef !== undefined) {
    assertPersisted(typeof value.sessionRef === 'string' && value.sessionRef.trim().length > 0);
  }
  validatePersistedStringArray(value.sourceRefs);
  validatePersistedStringArray(value.sourceDigests);
  assertPersisted(value.sourceRefs.length === value.sourceDigests.length);
  assertPersisted(typeof value.observation === 'string' && value.observation.trim().length > 0);
  assertPersisted(value.requestedKind === 'episodic' || value.requestedKind === 'semantic' || value.requestedKind === 'procedural');
  assertPersisted(
    value.candidateCategory === 'project-fact'
    || value.candidateCategory === 'project-experience'
    || value.candidateCategory === 'global'
    || value.candidateCategory === 'user-profile'
    || value.candidateCategory === 'local-skill-update',
  );
  assertPersisted(typeof value.executionEpoch === 'number' && Number.isSafeInteger(value.executionEpoch) && value.executionEpoch >= 1);
  assertPersisted(
    value.trigger === 'blocked'
    || value.trigger === 'rewind'
    || value.trigger === 'completion'
    || value.trigger === 'explicit-submission',
  );
  try {
    validateMemoryActor(value.actor as MemoryActorContext);
  } catch {
    invalidPersistedState();
  }
  const actor = value.actor as MemoryActorContext;
  assertPersisted(actor.projectKey === value.projectKey);
  assertPersisted(actor.permissions.includes('memory.propose'));
}

function validatePersistedFollowUpRequest(value: unknown): asserts value is MemoryFollowUpRequest {
  assertPersisted(isRecord(value));
  validatePersistedId(value.operationId, 'operation');
  try {
    validateMemoryFollowUpRequest(value as unknown as MemoryFollowUpRequest);
  } catch {
    invalidPersistedState();
  }
}

function validatePersistedSourceSnapshot(value: unknown): asserts value is MemoryProjectSourceSnapshot {
  assertPersisted(isRecord(value));
  assertPersisted(typeof value.sourceRef === 'string' && value.sourceRef.trim().length > 0);
  assertPersisted(typeof value.canonicalRef === 'string' && value.canonicalRef.trim().length > 0);
  assertPersisted(typeof value.revision === 'string' && value.revision.trim().length > 0);
  assertPersisted(typeof value.digest === 'string' && value.digest.trim().length > 0);
  validatePersistedTimestamp(value.loadedAt);
  assertPersisted(typeof value.projectKey === 'string' && value.projectKey.trim().length > 0);
  assertPersisted(
    value.target === 'project-architecture'
    || value.target === 'project-agents'
    || value.target === 'project-local-skill',
  );
  assertPersisted(typeof value.content === 'string');
}

function validatePersistedSubmissionReceipt(value: unknown): asserts value is MemorySubmissionReceipt {
  assertPersisted(isRecord(value));
  assertPersisted(typeof value.submissionId === 'string' && value.submissionId.trim().length > 0);
  assertPersisted(
    value.status === 'accepted'
    || value.status === 'duplicate'
    || value.status === 'queued'
    || value.status === 'rejected',
  );
  for (const field of ['candidateId', 'sourceRef', 'sourceFactRef'] as const) {
    if (value[field] !== undefined) assertPersisted(typeof value[field] === 'string' && value[field].trim().length > 0);
  }
  if (value.operationId !== undefined) validatePersistedId(value.operationId, 'operation');
  assertPersisted(
    value.nextAction === 'none'
    || value.nextAction === 'wait-analysis'
    || value.nextAction === 'review-required'
    || value.nextAction === 'attention',
  );
}

function validatePersistedFollowUpResult(value: unknown): asserts value is MemoryFollowUpResult {
  assertPersisted(isRecord(value));
  assertPersisted(typeof value.requestId === 'string' && value.requestId.trim().length > 0);
  assertPersisted(typeof value.correlationId === 'string' && value.correlationId.trim().length > 0);
  assertPersisted(typeof value.inReplyTo === 'string' && value.inReplyTo.trim().length > 0);
  validatePersistedId(value.operationId, 'operation');
  assertPersisted(value.liveContextMutated === false);
  try {
    validateMemoryCurationResult(value.curation as MemoryCurationResult);
    if (value.submission !== undefined) validatePersistedSubmissionReceipt(value.submission);
    assertPersisted(Array.isArray(value.projectSources));
    for (const source of value.projectSources) validatePersistedSourceSnapshot(source);
    if (value.proposal !== undefined) {
      validateProjectSourceUpdateProposal(value.proposal as ProjectSourceUpdateProposal);
    }
    validateAuditPromptSnapshot(value.promptSnapshot as AuditPromptSnapshot);
  } catch {
    invalidPersistedState();
  }
}

function restoreState(input: unknown): PersistedMemoryAgentState | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.analyses) || !Array.isArray(input.followUps)) {
    invalidPersistedState();
  }
  for (const analysis of input.analyses) {
    assertPersisted(isRecord(analysis));
    validatePersistedAnalysisRequest(analysis.request);
    validatePersistedTimestamp(analysis.acceptedAt);
  }
  for (const followUp of input.followUps) {
    assertPersisted(isRecord(followUp));
    validatePersistedFollowUpRequest(followUp.request);
    validatePersistedTimestamp(followUp.acceptedAt);
    if (followUp.result !== undefined) validatePersistedFollowUpResult(followUp.result);
  }
  return input as unknown as PersistedMemoryAgentState;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new ContractError(`${label} is required`);
  return value;
}

function issue(
  code: MemoryAgentIssue['code'],
  state: MemoryAgentFailureState,
  message: string,
  target: string,
  ownerId = MEMORY_AGENT_OWNER,
): MemoryAgentIssue {
  return {
    code,
    state,
    ownerId,
    message,
    nextAction: state === 'waiting' ? { kind: 'wait', ref: target } : { kind: 'recover', ref: target },
  };
}

export const memoryAgentIssue = issue;

function scopeKey(scope: MemoryScope): string {
  return `${scope.kind}:${scope.organId.value}:${scope.taskId?.value ?? ''}`;
}

function sameTask(left: TaskId | undefined, right: TaskId | undefined): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFollowUpRequest(left: MemoryFollowUpRequest, right: MemoryFollowUpRequest): boolean {
  return left.requestId === right.requestId
    && left.operationId.scope === right.operationId.scope
    && left.operationId.value === right.operationId.value
    && left.correlationId === right.correlationId
    && left.inReplyTo === right.inReplyTo
    && left.bindingRef === right.bindingRef
    && left.projectKey === right.projectKey
    && left.namespace === right.namespace
    && sameTask(left.taskId, right.taskId)
    && left.interactionScopeId === right.interactionScopeId
    && left.actor.actorId === right.actor.actorId
    && left.actor.roleId === right.actor.roleId
    && left.actor.projectKey === right.actor.projectKey
    && left.actor.crossProjectGrantRef === right.actor.crossProjectGrantRef
    && sameStrings(left.actor.permissions, right.actor.permissions)
    && sameStrings(left.evidenceRefs, right.evidenceRefs)
    && sameStrings(left.evidenceDigests, right.evidenceDigests)
    && sameStrings(left.sourceRefs, right.sourceRefs)
    && left.inputDigest === right.inputDigest;
}

function followUpAnalysisRequest(input: MemoryFollowUpRequest, prior: MemoryAnalysisRequest): MemoryAnalysisRequest {
  return {
    operationId: input.operationId,
    bindingRef: input.bindingRef,
    actor: {
      ...input.actor,
      permissions: [...input.actor.permissions],
    },
    projectKey: input.projectKey,
    scope: {
      ...prior.scope,
      ...(prior.scope.taskId === undefined ? {} : { taskId: { ...prior.scope.taskId } }),
    },
    ...(input.taskId === undefined ? {} : { taskId: { ...input.taskId } }),
    ...(input.interactionScopeId === undefined ? {} : { interactionScopeId: input.interactionScopeId }),
    ...(prior.sessionRef === undefined ? {} : { sessionRef: prior.sessionRef }),
    sourceRefs: [...input.evidenceRefs],
    sourceDigests: [...input.evidenceDigests],
    observation: prior.observation,
    requestedKind: prior.requestedKind,
    candidateCategory: prior.candidateCategory,
    executionEpoch: prior.executionEpoch,
    trigger: prior.trigger,
  };
}

function sourceErrorOutcome(error: unknown): MemoryAgentOutcome<never> {
  const code = (error as { readonly code?: string }).code;
  if (code === 'memory-source-scope-denied') {
    return { status: 'attention', issue: issue('memory-agent-source-scope-denied', 'attention', error instanceof Error ? error.message : 'memory source scope denied', 'memory-source-scope') };
  }
  if (code === 'memory-source-invalid') {
    return { status: 'attention', issue: issue('memory-agent-source-invalid', 'attention', error instanceof Error ? error.message : 'memory source is invalid', 'memory-source-integrity') };
  }
  const nextAction = (error as { readonly nextAction?: unknown }).nextAction;
  return {
    status: 'attention',
    issue: issue(
      'memory-agent-source-unavailable',
      'attention',
      error instanceof Error ? error.message : 'memory source is unavailable',
      typeof nextAction === 'string' && nextAction.length > 0 ? nextAction : 'project.json#sources.localSkill',
    ),
  };
}

export class MemoryAgent {
  private readonly bindings = new Map<string, MemoryAnalysisBinding>();
  private readonly analyses = new Map<string, AcceptedAnalysis>();
  private readonly followUps = new Map<string, FollowUpRecord>();
  private readonly now: () => string;
  private restored = false;
  private restorePromise?: Promise<void>;

  constructor(private readonly options: MemoryAgentOptions) {
    nonEmpty(options.projectKey, 'memory agent project key');
    nonEmpty(options.auditPromptRef, 'memory agent audit prompt ref');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async restore(): Promise<void> {
    if (this.restored) return;
    if (!this.options.state) {
      this.restored = true;
      return;
    }
    this.restorePromise ??= (async () => {
      const persisted = restoreState(await this.options.state!.readMemoryAgentState());
      if (!persisted) {
        this.restored = true;
        return;
      }
      for (const analysis of persisted.analyses) {
        this.analyses.set(analysis.request.operationId.value, {
          request: {
            ...analysis.request,
            sourceRefs: [...analysis.request.sourceRefs],
            sourceDigests: [...analysis.request.sourceDigests],
          },
          acceptedAt: analysis.acceptedAt,
        });
      }
      for (const followUp of persisted.followUps) {
        this.followUps.set(followUp.request.correlationId, {
          request: {
            ...followUp.request,
            evidenceRefs: [...followUp.request.evidenceRefs],
            evidenceDigests: [...followUp.request.evidenceDigests],
            sourceRefs: [...followUp.request.sourceRefs],
          },
          acceptedAt: followUp.acceptedAt,
          ...(followUp.result === undefined ? {} : {
            result: {
              ...followUp.result,
              curation: {
                ...followUp.result.curation,
                auditPrompt: { ...followUp.result.curation.auditPrompt },
                sourceRefs: [...followUp.result.curation.sourceRefs],
                matchedMemoryIds: [...followUp.result.curation.matchedMemoryIds],
                conflictRefs: [...followUp.result.curation.conflictRefs],
              },
              ...(followUp.result.submission === undefined ? {} : {
                submission: { ...followUp.result.submission },
              }),
              projectSources: followUp.result.projectSources.map((source) => ({ ...source })),
              ...(followUp.result.proposal === undefined ? {} : {
                proposal: {
                  ...followUp.result.proposal,
                  evidenceRefs: [...followUp.result.proposal.evidenceRefs],
                },
              }),
              promptSnapshot: { ...followUp.result.promptSnapshot },
            },
          }),
        });
      }
      this.restored = true;
    })();
    try {
      await this.restorePromise;
    } catch (error) {
      this.restorePromise = undefined;
      throw error;
    }
  }

  private async persistState(): Promise<void> {
    if (!this.options.state) return;
    const state: PersistedMemoryAgentState = {
      version: 1,
      analyses: [...this.analyses.values()],
      followUps: [...this.followUps.values()],
    };
    await this.options.state.appendMemoryAgentState({
      commitId: `memory-agent-state:${createHash('sha256').update(JSON.stringify(state)).digest('hex')}`,
      state,
    });
  }

  bind(input: MemoryAnalysisBinding): MemoryAnalysisBinding {
    nonEmpty(input.bindingRef, 'memory binding ref');
    nonEmpty(input.projectKey, 'memory binding project key');
    nonEmpty(input.ownerId, 'memory binding owner');
    nonEmpty(input.mainAgentId, 'memory binding main agent id');
    if (input.projectKey !== this.options.projectKey) throw new ContractError('memory binding project does not match memory agent');
    if (!Number.isSafeInteger(input.executionEpoch) || input.executionEpoch < 1) throw new ContractError('memory binding execution epoch must be positive');
    const existing = this.bindings.get(input.bindingRef);
    if (existing) {
      if (
        existing.projectKey !== input.projectKey
        || existing.executionEpoch !== input.executionEpoch
        || scopeKey(existing.scope) !== scopeKey(input.scope)
        || !sameTask(existing.taskId, input.taskId)
        || existing.interactionScopeId !== input.interactionScopeId
        || existing.mainAgentId !== input.mainAgentId
        || existing.operations !== input.operations
      ) {
        throw new ContractError('memory binding conflicts with an existing binding');
      }
      return existing;
    }
    const existingMainAgent = [...this.bindings.values()].find(
      (candidate) => candidate.mainAgentId === input.mainAgentId,
    );
    if (existingMainAgent) {
      throw new ContractError(`memory binding already exists for main agent: ${input.mainAgentId}`);
    }
    const binding = { ...input };
    this.bindings.set(binding.bindingRef, binding);
    return binding;
  }

  async analyze(input: MemoryAnalysisRequest): Promise<MemoryAgentOutcome<MemoryAnalysisResult>> {
    await this.restore();
    const bound = this.resolve(input);
    if (bound.status !== 'ready') return bound;
    if (
      (input.interactionScopeId === undefined
        && bound.value.binding.interactionScopeId === undefined
        && input.executionEpoch !== bound.value.binding.executionEpoch)
      || input.projectKey !== bound.value.binding.projectKey
      || scopeKey(input.scope) !== scopeKey(bound.value.binding.scope)
      || !sameTask(input.taskId, bound.value.binding.taskId)
      || input.interactionScopeId !== bound.value.binding.interactionScopeId
    ) {
      return {
        status: 'attention',
        issue: issue('memory-agent-binding-mismatch', 'attention', 'memory analysis request does not match the bound scope or epoch', 'memory-binding-refresh'),
      };
    }
    if (!input.actor.permissions.includes('memory.propose')) {
      return {
        status: 'attention',
        issue: issue('memory-agent-update-denied', 'attention', 'memory analysis actor lacks memory.propose permission', 'memory-permission'),
      };
    }
    if (input.actor.projectKey !== this.options.projectKey) {
      return {
        status: 'attention',
        issue: issue('memory-agent-binding-mismatch', 'attention', 'memory analysis actor belongs to another project', 'memory-binding-refresh'),
      };
    }
    if (input.sourceRefs.length !== input.sourceDigests.length || input.sourceRefs.length === 0) {
      return {
        status: 'attention',
        issue: issue('memory-agent-source-invalid', 'attention', 'memory analysis sources and digests must be non-empty and aligned', 'memory-source-integrity'),
      };
    }
    for (const [index, sourceRef] of input.sourceRefs.entries()) {
      let inspected;
      try {
        inspected = await bound.value.binding.operations.inspect({ sourceRef });
      } catch (error) {
        return {
          status: 'attention',
          issue: issue('memory-agent-source-invalid', 'attention', error instanceof Error ? error.message : `memory source is unavailable: ${sourceRef}`, 'memory-source-integrity'),
        };
      }
      if (inspected.sourceRef !== sourceRef || inspected.sourceDigest !== input.sourceDigests[index]) {
        return {
          status: 'attention',
          issue: issue('memory-agent-source-invalid', 'attention', `memory source digest drifted: ${sourceRef}`, 'memory-source-integrity'),
        };
      }
    }

    let sessionEvidence: MemorySessionEvidence | undefined;
    if (input.sessionRef !== undefined) {
      try {
        sessionEvidence = await this.options.sessions.readSession({
          projectKey: input.projectKey,
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          ...(input.interactionScopeId === undefined ? {} : { interactionScopeId: input.interactionScopeId }),
          sessionRef: input.sessionRef,
        });
      } catch (error) {
        return sourceErrorOutcome(error);
      }
    }

    let prompt;
    try {
      prompt = await this.options.auditPrompts.readPrompt({
        projectKey: input.projectKey,
        promptRef: this.options.auditPromptRef,
      });
    } catch (error) {
      return {
        status: 'attention',
        issue: issue('memory-agent-prompt-unavailable', 'attention', error instanceof Error ? error.message : 'memory audit prompt is unavailable', 'memory-audit-prompt'),
      };
    }

    const promptSnapshot: AuditPromptSnapshot = {
      promptRef: prompt.promptRef,
      canonicalRef: prompt.canonicalRef,
      revision: prompt.revision,
      digest: prompt.digest,
      loadedAt: prompt.loadedAt,
    };

    let novelty;
    try {
      novelty = await bound.value.binding.operations.detectNovelty({
        scope: input.scope,
        sourceRef: input.sourceRefs[0],
        sourceDigest: input.sourceDigests[0],
        candidateRef: input.sourceRefs[0],
        comparisonRefs: input.sourceRefs.slice(1),
        limit: input.sourceRefs.length,
      });
    } catch (error) {
      return {
        status: 'waiting',
        issue: issue('memory-agent-analysis-unavailable', 'waiting', error instanceof Error ? error.message : 'memory analysis backend is unavailable', 'memory-operations-ready'),
      };
    }

    let outcome: MemoryCurationResult;
    if (novelty.classification === 'unknown') {
      outcome = {
        operationId: input.operationId,
        auditPrompt: promptSnapshot,
        sourceRefs: [...input.sourceRefs],
        outcome: 'attention',
        matchedMemoryIds: [],
        conflictRefs: [],
        explanation: novelty.reason,
        nextAction: 'attention',
      };
    } else if (novelty.classification === 'known') {
      outcome = {
        operationId: input.operationId,
        auditPrompt: promptSnapshot,
        sourceRefs: [...input.sourceRefs],
        outcome: 'duplicate',
        matchedMemoryIds: [...novelty.matchedRefs],
        conflictRefs: [],
        explanation: novelty.reason,
        nextAction: 'none',
      };
    } else {
      const submission = await bound.value.binding.operations.submitCandidate({
        submissionId: `memory-analysis:${input.operationId.value}`,
        requestId: `memory-analysis:${input.operationId.value}`,
        operationId: input.operationId,
        bindingRef: input.bindingRef,
        actor: input.actor,
        projectKey: input.projectKey,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        requestedKind: input.requestedKind,
        candidateCategory: input.candidateCategory,
        contentRef: input.sourceRefs[0],
        contentDigest: input.sourceDigests[0],
        evidenceRefs: [...input.sourceRefs],
        observation: input.observation,
        desiredScope: input.candidateCategory === 'global' ? 'global' : 'project',
        reason: `${input.trigger}:${sessionEvidence?.sourceRef ?? prompt.canonicalRef}`,
        inputDigest: prompt.digest,
      });
      outcome = {
        operationId: input.operationId,
        auditPrompt: promptSnapshot,
        sourceRefs: [...input.sourceRefs],
        outcome: 'candidate',
        ...(submission.candidateId === undefined ? {} : { candidateId: submission.candidateId }),
        matchedMemoryIds: [],
        conflictRefs: [],
        explanation: `memory analysis produced a ${input.candidateCategory} candidate for review`,
        nextAction: 'review',
      };
      validateMemoryCurationResult(outcome);
      this.analyses.set(input.operationId.value, {
        request: { ...input, sourceRefs: [...input.sourceRefs], sourceDigests: [...input.sourceDigests] },
        acceptedAt: this.now(),
      });
      await this.persistState();
      const updateTarget = input.candidateCategory === 'local-skill-update'
        ? 'project-local-skill'
        : input.candidateCategory === 'project-experience'
          ? 'project-agents'
          : undefined;
      let projectSources: readonly MemoryProjectSourceSnapshot[] = [];
      let proposal: ProjectSourceUpdateProposal | undefined;
      if (updateTarget !== undefined) {
        try {
          projectSources = await this.options.projectSources.list({ projectKey: input.projectKey });
        } catch (error) {
          return sourceErrorOutcome(error);
        }
        proposal = this.projectUpdateProposal(input, projectSources, updateTarget);
      }
      return {
        status: 'ready',
        value: {
          curation: outcome,
          submission,
          projectSources,
          ...(proposal === undefined ? {} : { proposal }),
          liveContextMutated: false,
          promptSnapshot,
        },
      };
    }
    validateMemoryCurationResult(outcome);
    this.analyses.set(input.operationId.value, {
      request: { ...input, sourceRefs: [...input.sourceRefs], sourceDigests: [...input.sourceDigests] },
      acceptedAt: this.now(),
    });
    await this.persistState();
    return {
      status: 'ready',
      value: {
        curation: outcome,
        projectSources: [],
        liveContextMutated: false,
        promptSnapshot,
      },
    };
  }

  async followUp(input: MemoryFollowUpRequest): Promise<MemoryAgentOutcome<MemoryFollowUpResult>> {
    await this.restore();
    try {
      validateMemoryFollowUpRequest(input);
    } catch (error) {
      return {
        status: 'attention',
        issue: issue('memory-agent-follow-up-conflict', 'attention', error instanceof Error ? error.message : 'memory follow-up is invalid', 'memory-follow-up'),
      };
    }
    const bound = this.bindings.get(input.bindingRef);
    if (!bound) {
      return {
        status: 'attention',
        issue: issue('memory-agent-binding-missing', 'attention', `memory binding is not registered: ${input.bindingRef}`, 'memory-binding'),
      };
    }
    if (
      input.projectKey !== bound.projectKey
      || !sameTask(input.taskId, bound.taskId)
      || input.interactionScopeId !== bound.interactionScopeId
      || input.actor.projectKey !== bound.projectKey
    ) {
      return {
        status: 'attention',
        issue: issue('memory-agent-follow-up-conflict', 'attention', 'memory follow-up does not match the bound project or task', 'memory-follow-up'),
      };
    }
    if (input.inputDigest !== input.evidenceDigests[0] || input.evidenceRefs.length === 0) {
      return {
        status: 'attention',
        issue: issue('memory-agent-follow-up-conflict', 'attention', 'memory follow-up evidence is missing or its digest does not match', 'memory-follow-up-evidence'),
      };
    }
    const analysis = this.analyses.get(input.inReplyTo);
    if (
      !analysis
      || analysis.request.bindingRef !== input.bindingRef
      || analysis.request.projectKey !== input.projectKey
      || scopeKey(analysis.request.scope) !== scopeKey(bound.scope)
      || !sameTask(analysis.request.taskId, input.taskId)
      || analysis.request.interactionScopeId !== input.interactionScopeId
      || (
        analysis.request.interactionScopeId === undefined
        && bound.interactionScopeId === undefined
        && analysis.request.executionEpoch !== bound.executionEpoch
      )
    ) {
      return {
        status: 'attention',
        issue: issue('memory-agent-follow-up-stale', 'attention', 'memory follow-up does not reference an accepted analysis operation', 'memory-follow-up'),
      };
    }
    const prior = this.followUps.get(input.correlationId);
    if (prior) {
      if (sameFollowUpRequest(prior.request, input)) {
        if (prior.result) return { status: 'ready', value: prior.result };
        const recovered = await this.analyze(followUpAnalysisRequest(input, analysis.request));
        if (recovered.status !== 'ready') return recovered;
        const result: MemoryFollowUpResult = {
          requestId: input.requestId,
          correlationId: input.correlationId,
          inReplyTo: input.inReplyTo,
          operationId: input.operationId,
          ...recovered.value,
        };
        this.followUps.set(input.correlationId, {
          request: prior.request,
          acceptedAt: prior.acceptedAt,
          result,
        });
        await this.persistState();
        return { status: 'ready', value: result };
      }
      return {
        status: 'attention',
        issue: issue('memory-agent-follow-up-conflict', 'attention', 'memory follow-up correlation conflicts with an existing request', 'memory-follow-up'),
      };
    }
    if (input.operationId.value === input.inReplyTo) {
      return {
        status: 'attention',
        issue: issue('memory-agent-follow-up-stale', 'attention', 'memory follow-up cannot reply to itself', 'memory-follow-up'),
      };
    }
    const request = {
      ...input,
      evidenceRefs: [...input.evidenceRefs],
      evidenceDigests: [...input.evidenceDigests],
      sourceRefs: [...input.sourceRefs],
    };
    const analyzed = await this.analyze(followUpAnalysisRequest(request, analysis.request));
    if (analyzed.status !== 'ready') return analyzed;
    const result: MemoryFollowUpResult = {
      requestId: input.requestId,
      correlationId: input.correlationId,
      inReplyTo: input.inReplyTo,
      operationId: input.operationId,
      ...analyzed.value,
    };
    this.followUps.set(input.correlationId, {
      request,
      acceptedAt: this.now(),
      result,
    });
    await this.persistState();
    return { status: 'ready', value: result };
  }

  private projectUpdateProposal(
    input: MemoryAnalysisRequest,
    projectSources: readonly MemoryProjectSourceSnapshot[],
    target: ProjectSourceUpdateProposal['target'],
  ): ProjectSourceUpdateProposal | undefined {
    const source = projectSources.find((candidate) => candidate.target === target);
    if (!source) return undefined;
    return {
      target,
      sourceRef: source.sourceRef,
      expectedRevision: source.revision,
      expectedDigest: source.digest,
      patchRef: `memory-analysis-patch:${input.operationId.value}`,
      evidenceRefs: [...input.sourceRefs],
      ownerRef: target === 'project-agents' ? 'project-rule-owner' : 'local-skill-owner',
    };
  }

  async applyProjectUpdate(input: {
    readonly proposal: ProjectSourceUpdateProposal;
    readonly projectKey: string;
  }): Promise<MemoryAgentOutcome<MemorySourceUpdateReceipt>> {
    if (input.projectKey !== this.options.projectKey) {
      return {
        status: 'attention',
        issue: issue('memory-agent-update-denied', 'attention', 'memory project update belongs to another project', 'memory-update-owner'),
      };
    }
    try {
      validateProjectSourceUpdateProposal(input.proposal);
    } catch (error) {
      return {
        status: 'attention',
        issue: issue('memory-agent-update-validation-failed', 'attention', error instanceof Error ? error.message : 'memory project update proposal is invalid', 'memory-update-validation'),
      };
    }
    let current: MemoryProjectSourceSnapshot;
    try {
      current = await this.options.projectSources.readProject({
        projectKey: input.projectKey,
        target: input.proposal.target,
      });
    } catch (error) {
      return sourceErrorOutcome(error);
    }
    if (
      input.proposal.sourceRef !== current.sourceRef
      || input.proposal.expectedRevision !== current.revision
      || input.proposal.expectedDigest !== current.digest
    ) {
      return {
        status: 'attention',
        issue: issue('memory-agent-update-conflict', 'attention', 'memory project source changed after the proposal was created', 'memory-update-compare-and-commit'),
      };
    }
    if (!this.options.autoUpdate) {
      return {
        status: 'ready',
        value: {
          target: input.proposal.target,
          sourceRef: current.sourceRef,
          previousRevision: current.revision,
          previousDigest: current.digest,
          nextRevision: current.revision,
          nextDigest: current.digest,
          updated: false,
          evidenceRefs: [...input.proposal.evidenceRefs],
        },
      };
    }
    try {
      const updated = await this.options.projectUpdateOwner.apply({
        proposal: input.proposal,
        current,
        auto: true,
      });
      if (
        updated.sourceRef !== current.sourceRef
        || updated.previousRevision !== current.revision
        || updated.previousDigest !== current.digest
      ) {
        return {
          status: 'attention',
          issue: issue('memory-agent-update-conflict', 'attention', 'memory project update owner returned a mismatched compare-and-commit receipt', 'memory-update-compare-and-commit'),
        };
      }
      return { status: 'ready', value: updated };
    } catch (error) {
      return {
        status: 'attention',
        issue: issue('memory-agent-update-validation-failed', 'attention', error instanceof Error ? error.message : 'memory project update failed validation', 'memory-update-owner'),
      };
    }
  }

  private resolve(input: MemoryAnalysisRequest): MemoryAgentOutcome<BoundAnalysis> {
    const binding = this.bindings.get(input.bindingRef);
    if (!binding) {
      return {
        status: 'attention',
        issue: issue('memory-agent-binding-missing', 'attention', `memory binding is not registered: ${input.bindingRef}`, 'memory-binding'),
      };
    }
    return { status: 'ready', value: { binding } };
  }
}
