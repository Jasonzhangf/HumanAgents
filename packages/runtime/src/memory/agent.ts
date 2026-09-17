import {
  ContractError,
  validateMemoryCurationResult,
  validateMemoryFollowUpRequest,
  validateProjectSourceUpdateProposal,
  type AuditPromptSnapshot,
  type MemoryActorContext,
  type MemoryAuditPromptSourcePort,
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
    | 'memory-agent-update-validation-failed';
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
  readonly sessionRef?: string;
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
  readonly observation: string;
  readonly requestedKind: 'episodic' | 'semantic' | 'procedural';
  readonly executionEpoch: number;
  readonly trigger: 'blocked' | 'rewind' | 'completion' | 'explicit-submission';
}

export interface MemoryAnalysisBinding {
  readonly bindingRef: string;
  readonly projectKey: string;
  readonly scope: MemoryScope;
  readonly taskId?: TaskId;
  readonly executionEpoch: number;
  readonly ownerId: string;
  readonly operations: MemoryOperationsPort;
}

export interface MemoryFollowUpReceipt {
  readonly requestId: string;
  readonly correlationId: string;
  readonly inReplyTo: string;
  readonly accepted: true;
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
  readonly now?: () => string;
}

interface BoundAnalysis {
  readonly binding: MemoryAnalysisBinding;
  readonly sessionEvidence?: MemorySessionEvidence;
}

interface FollowUpRecord {
  readonly request: MemoryFollowUpRequest;
  readonly acceptedAt: string;
}

interface AcceptedAnalysis {
  readonly request: MemoryAnalysisRequest;
  readonly acceptedAt: string;
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

function sourceErrorOutcome(error: unknown): MemoryAgentOutcome<never> {
  const code = (error as { readonly code?: string }).code;
  if (code === 'memory-source-scope-denied') {
    return { status: 'attention', issue: issue('memory-agent-source-scope-denied', 'attention', error instanceof Error ? error.message : 'memory source scope denied', 'memory-source-scope') };
  }
  if (code === 'memory-source-invalid') {
    return { status: 'attention', issue: issue('memory-agent-source-invalid', 'attention', error instanceof Error ? error.message : 'memory source is invalid', 'memory-source-integrity') };
  }
  return { status: 'waiting', issue: issue('memory-agent-source-unavailable', 'waiting', error instanceof Error ? error.message : 'memory source is unavailable', 'memory-source-ready') };
}

export class MemoryAgent {
  private readonly bindings = new Map<string, MemoryAnalysisBinding>();
  private readonly analyses = new Map<string, AcceptedAnalysis>();
  private readonly followUps = new Map<string, FollowUpRecord>();
  private readonly now: () => string;

  constructor(private readonly options: MemoryAgentOptions) {
    nonEmpty(options.projectKey, 'memory agent project key');
    nonEmpty(options.auditPromptRef, 'memory agent audit prompt ref');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  bind(input: MemoryAnalysisBinding): MemoryAnalysisBinding {
    nonEmpty(input.bindingRef, 'memory binding ref');
    nonEmpty(input.projectKey, 'memory binding project key');
    nonEmpty(input.ownerId, 'memory binding owner');
    if (input.projectKey !== this.options.projectKey) throw new ContractError('memory binding project does not match memory agent');
    if (!Number.isSafeInteger(input.executionEpoch) || input.executionEpoch < 1) throw new ContractError('memory binding execution epoch must be positive');
    const existing = this.bindings.get(input.bindingRef);
    if (existing) {
      if (
        existing.projectKey !== input.projectKey
        || existing.executionEpoch !== input.executionEpoch
        || scopeKey(existing.scope) !== scopeKey(input.scope)
        || !sameTask(existing.taskId, input.taskId)
        || existing.operations !== input.operations
      ) {
        throw new ContractError('memory binding conflicts with an existing binding');
      }
      return existing;
    }
    const binding = { ...input };
    this.bindings.set(binding.bindingRef, binding);
    return binding;
  }

  async analyze(input: MemoryAnalysisRequest): Promise<MemoryAgentOutcome<MemoryAnalysisResult>> {
    const bound = this.resolve(input);
    if (bound.status !== 'ready') return bound;
    if (
      input.executionEpoch !== bound.value.binding.executionEpoch
      || input.projectKey !== bound.value.binding.projectKey
      || scopeKey(input.scope) !== scopeKey(bound.value.binding.scope)
      || !sameTask(input.taskId, bound.value.binding.taskId)
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
          taskId: input.taskId?.value ?? '',
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
        contentRef: input.sourceRefs[0],
        contentDigest: input.sourceDigests[0],
        evidenceRefs: [...input.sourceRefs],
        observation: input.observation,
        desiredScope: 'project',
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
        explanation: 'memory analysis produced a project candidate for review',
        nextAction: 'review',
      };
      validateMemoryCurationResult(outcome);
      this.analyses.set(input.operationId.value, {
        request: { ...input, sourceRefs: [...input.sourceRefs], sourceDigests: [...input.sourceDigests] },
        acceptedAt: this.now(),
      });
      return {
        status: 'ready',
        value: {
          curation: outcome,
          submission,
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
    return {
      status: 'ready',
      value: {
        curation: outcome,
        liveContextMutated: false,
        promptSnapshot,
      },
    };
  }

  async followUp(input: MemoryFollowUpRequest): Promise<MemoryAgentOutcome<MemoryFollowUpReceipt>> {
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
      || analysis.request.executionEpoch !== bound.executionEpoch
    ) {
      return {
        status: 'attention',
        issue: issue('memory-agent-follow-up-stale', 'attention', 'memory follow-up does not reference an accepted analysis operation', 'memory-follow-up'),
      };
    }
    const prior = this.followUps.get(input.correlationId);
    if (prior) {
      if (sameFollowUpRequest(prior.request, input)) {
        return {
          status: 'ready',
          value: {
            requestId: prior.request.requestId,
            correlationId: prior.request.correlationId,
            inReplyTo: prior.request.inReplyTo,
            accepted: true,
            operationId: prior.request.operationId,
          },
        };
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
    const record: FollowUpRecord = {
      request: {
        ...input,
        evidenceRefs: [...input.evidenceRefs],
        evidenceDigests: [...input.evidenceDigests],
        sourceRefs: [...input.sourceRefs],
      },
      acceptedAt: this.now(),
    };
    this.followUps.set(input.correlationId, record);
    return {
      status: 'ready',
      value: {
        requestId: input.requestId,
        correlationId: input.correlationId,
        inReplyTo: input.inReplyTo,
        accepted: true,
        operationId: input.operationId,
      },
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
