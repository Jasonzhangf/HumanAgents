import {
  ContractError,
  assertContextBudget,
  validateMemoryForgettingRequest,
  validateMemoryPromotionReceipt,
  validateMemoryQueryRequest,
  validateMemoryReviewReceipt,
  validateMemorySubmission,
  type AgentMemoryContext,
  type AgentMemoryContextInjectionPort,
  type AgentMemoryContextRequest,
  type ContextLayer,
  type MemoryForgettingPlan,
  type MemoryForgettingRequest,
  type MemoryKind,
  type MemoryOperationsPort,
  type MemoryPromotionReceipt,
  type MemoryQueryEntry,
  type MemoryQueryRequest,
  type MemoryQueryResponse,
  type MemoryRecordState,
  type MemoryReviewReceipt,
  type MemoryScope,
  type MemorySubmission,
  type MemorySubmissionReceipt,
  type TaskId,
  type NoveltyRequest,
  type NoveltyResult,
  type RecurrenceRequest,
  type RecurrenceResult,
} from '../../../contracts/src/index.js';

type RecordEntry = { readonly scope: MemoryScope; readonly sourceRef: string; readonly sourceDigest: string; readonly text: string; readonly layer?: ContextLayer; readonly summary?: string; };

interface CanonicalRecord {
  readonly memoryId: string;
  readonly namespace: 'project' | 'global';
  readonly projectKey?: string;
  readonly kind: MemoryKind;
  readonly state: MemoryRecordState;
  readonly summary: string;
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
  readonly taskId?: TaskId;
  readonly sourceScopeRef: string;
  readonly relevanceReason: string;
}

interface CandidateRecord {
  readonly submission: MemorySubmission;
  readonly candidateId?: string;
  state: MemoryRecordState;
  review?: MemoryReviewReceipt;
  promotion?: MemoryPromotionReceipt;
}

function scopeKey(scope: MemoryScope): string { return `${scope.kind}:${scope.organId.value}:${scope.taskId?.value ?? ''}`; }
function visible(record: RecordEntry, scope: MemoryScope): boolean { return scopeKey(record.scope) === scopeKey(scope) || (scope.kind === 'approved-global' && record.scope.kind === 'approved-global' && record.scope.organId.value === scope.organId.value); }
function tokens(text: string): number { return text.trim() ? text.trim().split(/\s+/u).length : 0; }
function stable(value: string): string { let hash = 0; for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 31); return `memory:${(hash >>> 0).toString(16).padStart(8, '0')}`; }
function nonEmpty(value: string, label: string): string { if (!value.trim()) throw new ContractError(`${label} must be non-empty`); return value; }
function candidateRecordId(candidateId: string): string { return `memory-candidate:${candidateId}`; }
function queryVisible(record: CanonicalRecord, request: MemoryQueryRequest): boolean {
  return record.namespace === request.namespace
    && request.kinds.includes(record.kind)
    && request.states.includes(record.state)
    && (request.namespace === 'global' || record.projectKey === request.projectKey)
    && (request.taskId === undefined || (
      record.taskId !== undefined
      && record.taskId.scope === request.taskId.scope
      && record.taskId.value === request.taskId.value
    ));
}

export class DeterministicMemoryBackend implements MemoryOperationsPort, AgentMemoryContextInjectionPort {
  readonly indexVersion = 'fake-memory-v2';
  private readonly records = new Map<string, RecordEntry>();
  private readonly canonicalRecords = new Map<string, CanonicalRecord>();
  private readonly candidates = new Map<string, CandidateRecord>();
  private readonly candidateIds = new Map<string, string>();
  private readonly forgettingPlans = new Map<string, MemoryForgettingPlan>();
  private readonly attachedEpochs = new Map<string, number>();
  private readonly attachedContextIds = new Map<string, string>();

  async ingest(input: { readonly scope: MemoryScope; readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }): Promise<{ readonly sourceRef: string }> {
    if (!input.sourceRef || !input.sourceDigest || !input.text.trim()) throw new ContractError('memory source must have ref, digest, and text');
    this.records.set(input.sourceRef, { ...input });
    return { sourceRef: input.sourceRef };
  }

  addContextEntry(input: { readonly scope: MemoryScope; readonly sourceRef: string; readonly sourceDigest: string; readonly text: string; readonly layer: ContextLayer; readonly summary?: string }): void { this.records.set(input.sourceRef, { ...input }); }

  addCanonicalRecord(input: CanonicalRecord): void {
    nonEmpty(input.memoryId, 'memory id');
    nonEmpty(input.summary, 'memory summary');
    if (input.namespace === 'project') nonEmpty(input.projectKey ?? '', 'memory project key');
    if (input.sourceRefs.length !== input.sourceDigests.length) throw new ContractError('memory source refs and digests must match');
    this.canonicalRecords.set(input.memoryId, { ...input });
  }

  async search(input: { readonly scope: MemoryScope; readonly query: string; readonly limit: number }): Promise<readonly { readonly sourceRef: string; readonly summary: string }[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new ContractError('memory search limit must be positive');
    const query = input.query.trim().toLowerCase();
    if (!query) throw new ContractError('memory search query must be non-empty');
    const terms = query.split(/\s+/u);
    return [...this.records.values()].filter((record) => visible(record, input.scope)).filter((record) => record.text.toLowerCase() === query || terms.every((term) => record.text.toLowerCase().includes(term))).slice(0, input.limit).map((record) => ({ sourceRef: record.sourceRef, summary: record.summary ?? record.text.slice(0, 120) }));
  }

  async inspect(input: { readonly sourceRef: string }): Promise<{ readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }> { const record = this.records.get(input.sourceRef); if (!record) throw new ContractError(`memory source not found: ${input.sourceRef}`); return { sourceRef: record.sourceRef, sourceDigest: record.sourceDigest, text: record.text }; }
  async compare(input: { readonly leftRef: string; readonly rightRef: string }): Promise<{ readonly relation: 'same' | 'different' | 'unknown' }> { const left = this.records.get(input.leftRef); const right = this.records.get(input.rightRef); return !left || !right ? { relation: 'unknown' } : { relation: left.sourceDigest === right.sourceDigest ? 'same' : 'different' }; }
  async detectNovelty(input: NoveltyRequest): Promise<NoveltyResult> { const candidate = this.records.get(input.candidateRef); if (!candidate) return { classification: 'unknown', matchedRefs: [], reason: 'candidate source unavailable' }; const matches = input.comparisonRefs.filter((ref) => { const record = this.records.get(ref); return record && visible(record, input.scope) && record.sourceDigest === candidate.sourceDigest; }).slice(0, input.limit); return { classification: matches.length ? 'known' : 'novel', matchedRefs: matches, reason: matches.length ? 'matching source digest' : 'no matching source digest' }; }
  async detectRecurrence(input: RecurrenceRequest): Promise<RecurrenceResult> { const matches = input.windowRefs.map((ref) => this.records.get(ref)).filter((record): record is RecordEntry => Boolean(record && visible(record, input.scope) && record.text.includes(input.patternRef))).slice(0, input.limit); return { classification: matches.length > 1 ? 'recurring' : matches.length === 1 ? 'observed' : 'one-off', occurrences: matches.map((record) => ({ ref: record.sourceRef, digest: record.sourceDigest })), reason: matches.length > 1 ? 'pattern observed more than once' : 'deterministic exact pattern count' }; }

  async query(input: MemoryQueryRequest): Promise<MemoryQueryResponse> {
    validateMemoryQueryRequest(input);
    const query = input.query.trim().toLowerCase();
    const terms = query.split(/\s+/u);
    let remaining = input.tokenBudget;
    const omitted: { reason: string; ref?: string }[] = [];
    const entries: MemoryQueryEntry[] = [];
    for (const record of this.canonicalRecords.values()) {
      if (!queryVisible(record, input)) continue;
      if (!(record.summary.toLowerCase() === query || terms.every((term) => record.summary.toLowerCase().includes(term)))) continue;
      const cost = tokens(record.summary);
      if (cost > remaining) {
        omitted.push({ reason: 'token-budget', ref: record.memoryId });
        continue;
      }
      remaining -= cost;
      entries.push({
        memoryId: record.memoryId,
        namespace: record.namespace,
        kind: record.kind,
        state: record.state,
        summary: record.summary,
        sourceRefs: [...record.sourceRefs],
        sourceDigests: [...record.sourceDigests],
        projectKey: record.projectKey,
        sourceScopeRef: record.sourceScopeRef,
        relevanceReason: record.relevanceReason,
      });
      if (entries.length >= input.limit) break;
    }
    return {
      requestId: input.requestId,
      status: 'ready',
      entries,
      indexVersion: this.indexVersion,
      sourceFactRef: `memory-query:${input.requestId}`,
      omitted,
    };
  }

  async submitCandidate(input: MemorySubmission): Promise<MemorySubmissionReceipt> {
    validateMemorySubmission(input);
    const existing = this.candidates.get(input.submissionId);
    if (existing) {
      if (
        existing.submission.inputDigest !== input.inputDigest
        || existing.submission.actor.actorId !== input.actor.actorId
        || existing.submission.actor.projectKey !== input.actor.projectKey
        || existing.submission.projectKey !== input.projectKey
      ) {
        throw new ContractError('memory submission identity conflicts with an existing submission');
      }
      const candidateId = existing.candidateId;
      return {
        submissionId: input.submissionId,
        status: 'duplicate',
        candidateId,
        operationId: existing.submission.operationId,
        sourceRef: existing.submission.contentRef,
        sourceFactRef: candidateRecordId(candidateId ?? existing.submission.submissionId),
        nextAction: 'wait-analysis',
      };
    }
    const candidateId = input.submissionId;
    this.candidates.set(input.submissionId, { submission: input, candidateId, state: 'candidate' });
    this.candidateIds.set(candidateId, input.submissionId);
    return {
      submissionId: input.submissionId,
      status: 'accepted',
      candidateId,
      operationId: input.operationId,
      sourceRef: input.contentRef,
      sourceFactRef: candidateRecordId(input.submissionId),
      nextAction: 'wait-analysis',
    };
  }

  async reviewCandidate(input: MemoryReviewReceipt): Promise<MemoryReviewReceipt> {
    validateMemoryReviewReceipt(input);
    const submissionId = this.candidateIds.get(input.candidateId);
    const candidate = submissionId === undefined ? undefined : this.candidates.get(submissionId);
    if (!candidate) throw new ContractError(`memory candidate not found: ${input.candidateId}`);
    if (input.actor.projectKey !== candidate.submission.projectKey) throw new ContractError('memory review actor project mismatch');
    candidate.review = input;
    candidate.state = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'candidate';
    if (candidate.state === 'approved') {
      const submission = candidate.submission;
      this.canonicalRecords.set(candidateRecordId(input.candidateId), {
        memoryId: candidateRecordId(input.candidateId),
        namespace: 'project',
        projectKey: submission.projectKey,
        kind: submission.requestedKind,
        state: 'approved',
        summary: submission.observation,
        sourceRefs: [submission.contentRef, ...submission.evidenceRefs],
        sourceDigests: [submission.contentDigest],
        taskId: submission.taskId,
        sourceScopeRef: `${submission.projectKey}:${submission.taskId?.value ?? 'interaction'}`,
        relevanceReason: submission.reason,
      });
    }
    return input;
  }

  async promoteCandidate(input: MemoryPromotionReceipt): Promise<MemoryPromotionReceipt> {
    validateMemoryPromotionReceipt(input);
    const submissionId = this.candidateIds.get(input.candidateId);
    const candidate = submissionId === undefined ? undefined : this.candidates.get(submissionId);
    if (!candidate) throw new ContractError(`memory candidate not found: ${input.candidateId}`);
    if (input.actor.projectKey !== candidate.submission.projectKey) throw new ContractError('memory promotion actor project mismatch');
    if (candidate.state !== 'approved') throw new ContractError('memory promotion requires an approved candidate');
    candidate.promotion = input;
    const approved = this.canonicalRecords.get(candidateRecordId(input.candidateId));
    if (!approved) throw new ContractError('approved memory record is unavailable');
    this.canonicalRecords.set(candidateRecordId(input.candidateId), {
      ...approved,
      namespace: 'global',
      projectKey: undefined,
      state: 'active',
      sourceRefs: [...new Set([...approved.sourceRefs, ...input.sourceRefs])],
      relevanceReason: input.reason,
    });
    return input;
  }

  async planForgetting(input: MemoryForgettingRequest): Promise<MemoryForgettingPlan> {
    validateMemoryForgettingRequest(input);
    const pending = new Map<string, CanonicalRecord>();
    for (const action of input.plan.actions) {
      if (action.action === 'cleanup-projection') continue;
      const record = this.canonicalRecords.get(action.memoryId);
      if (!record) throw new ContractError(`memory record not found for forgetting: ${action.memoryId}`);
      if (record.namespace !== input.plan.namespace) throw new ContractError(`memory forgetting namespace mismatch: ${action.memoryId}`);
      if (input.plan.namespace === 'project' && record.projectKey !== input.plan.projectKey) {
        throw new ContractError(`memory forgetting project mismatch: ${action.memoryId}`);
      }
      pending.set(action.memoryId, {
        ...record,
        state: action.action === 'supersede' ? 'superseded' : action.action === 'expire' ? 'expired' : 'archived',
      });
    }
    this.forgettingPlans.set(input.plan.planId, input.plan);
    for (const [memoryId, record] of pending) this.canonicalRecords.set(memoryId, record);
    return input.plan;
  }

  async recall(input: AgentMemoryContextRequest): Promise<AgentMemoryContext> {
    if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 0) throw new ContractError('context token budget must be finite and non-negative');
    const contextId = stable(`${input.agentRuntimeId}:${scopeKey(input.scope)}:${input.taskId.value}:${input.executionEpoch}:${input.query ?? ''}:${input.layers.join(',')}`);
    let remaining = input.tokenBudget;
    const omitted: { reason: string; sourceRef?: string }[] = [];
    const entries = [...this.records.values()].filter((record) => visible(record, input.scope) && record.layer && input.layers.includes(record.layer)).filter((record) => !input.query || record.text.toLowerCase().includes(input.query.toLowerCase())).flatMap((record) => { const tokenCost = tokens(record.summary ?? record.text); if (tokenCost > remaining) { omitted.push({ reason: 'token-budget', sourceRef: record.sourceRef }); return []; } remaining -= tokenCost; return [{ layer: record.layer!, summary: record.summary ?? record.text, sourceRef: record.sourceRef, sourceDigest: record.sourceDigest, scope: scopeKey(record.scope), tokenCost }]; });
    const context: AgentMemoryContext = { contextId, executionEpoch: input.executionEpoch, entries, omitted, indexVersion: this.indexVersion };
    assertContextBudget(context, input.tokenBudget);
    this.attachedEpochs.set(input.agentRuntimeId, input.executionEpoch);
    this.attachedContextIds.set(input.agentRuntimeId, context.contextId);
    return context;
  }

  async attach(input: { readonly agentRuntimeId: string; readonly context: AgentMemoryContext }): Promise<{ readonly contextId: string; readonly attached: boolean }> {
    if (this.attachedEpochs.get(input.agentRuntimeId) !== input.context.executionEpoch) throw new ContractError('context execution epoch is not bound to runtime');
    if (this.attachedContextIds.get(input.agentRuntimeId) !== input.context.contextId) throw new ContractError('context id is not bound to runtime recall');
    return { contextId: input.context.contextId, attached: true };
  }
}
