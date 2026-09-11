import { ContractError, assertContextBudget, type AgentMemoryContext, type AgentMemoryContextInjectionPort, type AgentMemoryContextRequest, type ContextLayer, type MemoryOperationsPort, type MemoryScope, type NoveltyRequest, type NoveltyResult, type RecurrenceRequest, type RecurrenceResult } from '../../../contracts/src/index.js';

type RecordEntry = { readonly scope: MemoryScope; readonly sourceRef: string; readonly sourceDigest: string; readonly text: string; readonly layer?: ContextLayer; readonly summary?: string; };

function scopeKey(scope: MemoryScope): string { return `${scope.kind}:${scope.organId.value}:${scope.taskId?.value ?? ''}`; }
function visible(record: RecordEntry, scope: MemoryScope): boolean { return scopeKey(record.scope) === scopeKey(scope) || (scope.kind === 'approved-global' && record.scope.kind === 'approved-global' && record.scope.organId.value === scope.organId.value); }
function tokens(text: string): number { return text.trim() ? text.trim().split(/\s+/u).length : 0; }
function stable(value: string): string { let hash = 0; for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 31); return `memory:${(hash >>> 0).toString(16).padStart(8, '0')}`; }

export class DeterministicMemoryBackend implements MemoryOperationsPort, AgentMemoryContextInjectionPort {
  readonly indexVersion = 'fake-memory-v1';
  private readonly records = new Map<string, RecordEntry>();
  private readonly attachedEpochs = new Map<string, number>();
  private readonly attachedContextIds = new Map<string, string>();

  async ingest(input: { readonly scope: MemoryScope; readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }): Promise<{ readonly sourceRef: string }> {
    if (!input.sourceRef || !input.sourceDigest || !input.text.trim()) throw new ContractError('memory source must have ref, digest, and text');
    this.records.set(input.sourceRef, { ...input });
    return { sourceRef: input.sourceRef };
  }

  addContextEntry(input: { readonly scope: MemoryScope; readonly sourceRef: string; readonly sourceDigest: string; readonly text: string; readonly layer: ContextLayer; readonly summary?: string }): void { this.records.set(input.sourceRef, { ...input }); }

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
