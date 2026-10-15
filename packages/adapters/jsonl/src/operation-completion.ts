import {
  completionCommitIdentity,
  fileWriteEffectId,
  sameEffectExecutionBinding,
  validateDurableCompletionReceipt,
  validateFileWriteCompletionFact,
  validateFileWriteEffectIntent,
  type CompletionReadback,
  type CompletionReadInput,
  type DurableCompletionReceipt,
  type EffectExecutionBinding,
  type EffectIdentity,
  type FileWriteCompletionFact,
  type FileWriteEffectIntent,
  type ProviderExecutionIdentityRef,
} from '../../../contracts/src/index.js';
import type {
  OperationCompletionLookupDescriptor,
  OperationCompletionJournalPort,
} from '../../../runtime/src/gateway/operation-completion.js';
import { JsonlOrganJournal, JournalIntegrityError, type JournalRecord } from './index.js';

type OperationCompletionPayload =
  | { readonly kind: 'operation-effect-intent'; readonly intent: FileWriteEffectIntent }
  | { readonly kind: 'operation-completion'; readonly completion: FileWriteCompletionFact };

function intentCommitId(binding: EffectExecutionBinding, effectId: EffectIdentity): string {
  return `operation-effect-intent:v1:${binding.toolOperationId.value}:${effectId.slice('file-write-effect:v1:'.length)}`;
}

function sameExecutionIdentity(
  left: ProviderExecutionIdentityRef,
  right: ProviderExecutionIdentityRef,
): boolean {
  return left.runtimeId === right.runtimeId
    && left.taskId.value === right.taskId.value
    && left.operationId.value === right.operationId.value
    && left.organId?.value === right.organId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.executionEpoch === right.executionEpoch;
}

function parsePayload(record: JournalRecord): OperationCompletionPayload {
  const payload = record.payload;
  if (payload === undefined || typeof payload.kind !== 'string') {
    throw new JournalIntegrityError('operation completion journal record has no typed payload');
  }
  if (payload.kind === 'operation-effect-intent') {
    if (!('intent' in payload)) throw new JournalIntegrityError('operation effect intent payload is missing');
    validateFileWriteEffectIntent(payload.intent as FileWriteEffectIntent);
    return payload as OperationCompletionPayload;
  }
  if (payload.kind === 'operation-completion') {
    if (!('completion' in payload)) throw new JournalIntegrityError('operation completion payload is missing');
    validateFileWriteCompletionFact(payload.completion as FileWriteCompletionFact);
    return payload as OperationCompletionPayload;
  }
  throw new JournalIntegrityError('operation completion journal payload kind is invalid');
}

async function receiptFromRecord(record: JournalRecord, fact: FileWriteCompletionFact): Promise<DurableCompletionReceipt> {
  if (record.commitId === undefined || record.commitFactDigest === undefined) {
    throw new JournalIntegrityError('operation completion journal record is not committed');
  }
  const receipt: DurableCompletionReceipt = {
    commitIdentity: record.commitId as DurableCompletionReceipt['commitIdentity'],
    commitFactDigest: record.commitFactDigest as DurableCompletionReceipt['commitFactDigest'],
    journalSeq: record.seq,
    recordDigest: record.recordDigest as DurableCompletionReceipt['recordDigest'],
    fact,
  };
  await validateDurableCompletionReceipt(receipt);
  return receipt;
}

/**
 * Typed completion codec over the existing authoritative Organ Journal. The
 * Journal payload is only the encoding carrier; callers read typed receipts or
 * typed reconcile obligations, never the raw payload.
 */
export interface JsonlOperationCompletionJournalOptions {
  /** Physical path when the codec owns its own Journal handle. */
  readonly filePath?: string;
  /** Actual shared Organ Journal object; preferred when the caller already holds it. */
  readonly journal?: JsonlOrganJournal;
}

function isOwnedPayloadKind(record: JournalRecord): boolean {
  const kind = record.payload?.kind;
  return kind === 'operation-effect-intent' || kind === 'operation-completion';
}

/**
 * Pure discovery over supplied, already-verified records. It selects only its
 * own payload kinds before parsing, so an unrelated mixed-Journal record cannot
 * fail discovery. A record that claims one of these kinds but is malformed is
 * still an integrity error.
 */
export async function decodeOperationCompletionLookups(
  records: readonly JournalRecord[],
  execution: ProviderExecutionIdentityRef,
): Promise<readonly OperationCompletionLookupDescriptor[]> {
  const descriptors: OperationCompletionLookupDescriptor[] = [];
  for (const record of records) {
    if (!isOwnedPayloadKind(record)) continue;
    const payload = parsePayload(record);
    if (payload.kind !== 'operation-effect-intent') continue;
    const { binding, effect } = payload.intent;
    if (!sameExecutionIdentity(binding.execution, execution)) continue;
    if (effect.effectId !== await fileWriteEffectId(binding)) {
      throw new JournalIntegrityError('committed effect intent identity does not match its binding');
    }
    descriptors.push({
      commitIdentity: await completionCommitIdentity(binding, effect.effectId),
      binding,
      effectId: effect.effectId,
    });
  }
  return descriptors;
}

/**
 * Pure exact read over supplied records. It preserves the same identity checks
 * as the journal-backed read, but never locks or awaits a producer: the caller
 * supplies the verified cut.
 */
export async function decodeOperationCompletionReadback(
  records: readonly JournalRecord[],
  input: CompletionReadInput,
): Promise<CompletionReadback> {
  if (input.effectId !== await fileWriteEffectId(input.binding)) {
    throw new JournalIntegrityError('completion read effect identity does not match the requested binding');
  }
  const expectedCompletionCommit = await completionCommitIdentity(input.binding, input.effectId);
  if (input.commitIdentity !== expectedCompletionCommit) {
    throw new JournalIntegrityError('completion commit identity does not match the requested binding');
  }
  const completionRecord = records.find((candidate) => candidate.commitId === input.commitIdentity);
  if (completionRecord !== undefined) {
    const payload = parsePayload(completionRecord);
    if (payload.kind !== 'operation-completion') {
      throw new JournalIntegrityError('completion commitId does not identify a completion fact');
    }
    if (!sameEffectExecutionBinding(payload.completion.binding, input.binding)
      || payload.completion.effect.effectId !== input.effectId) {
      throw new JournalIntegrityError('completion read binding does not match the committed completion');
    }
    return { state: 'confirmed', receipt: await receiptFromRecord(completionRecord, payload.completion) };
  }

  const intentRecord = records.find((candidate) => candidate.commitId === intentCommitId(input.binding, input.effectId));
  if (intentRecord === undefined) return { state: 'not-found' };
  const payload = parsePayload(intentRecord);
  if (payload.kind !== 'operation-effect-intent') {
    throw new JournalIntegrityError('effect intent commitId does not identify an intent');
  }
  if (!sameEffectExecutionBinding(payload.intent.binding, input.binding)
    || payload.intent.effect.effectId !== input.effectId) {
    throw new JournalIntegrityError('effect intent read binding does not match the committed intent');
  }
  return {
    state: 'unknown',
    intent: payload.intent,
    nextAction: 'reconcile',
    replayAllowed: false,
  };
}

export class JsonlOperationCompletionJournal implements OperationCompletionJournalPort {
  private readonly journal: JsonlOrganJournal;

  constructor(input: string | JsonlOperationCompletionJournalOptions) {
    if (typeof input === 'string') {
      if (!input.trim()) throw new JournalIntegrityError('operation completion journal path is required');
      this.journal = new JsonlOrganJournal(input);
      return;
    }
    if (input.journal !== undefined) {
      this.journal = input.journal;
      return;
    }
    if (input.filePath === undefined || !input.filePath.trim()) {
      throw new JournalIntegrityError('operation completion journal requires a path or shared journal');
    }
    this.journal = new JsonlOrganJournal(input.filePath);
  }

  async commitIntent(intent: FileWriteEffectIntent): Promise<void> {
    validateFileWriteEffectIntent(intent);
    if (intent.effect.effectId !== await fileWriteEffectId(intent.binding)) {
      throw new JournalIntegrityError('operation effect intent identity does not match its binding');
    }
    const record = await this.journal.append({
      commitId: intentCommitId(intent.binding, intent.effect.effectId),
      kind: 'event',
      scope: intent.binding.scope,
      payload: { kind: 'operation-effect-intent', intent } satisfies OperationCompletionPayload,
    });
    if (record.payload === undefined) {
      throw new JournalIntegrityError('operation effect intent append returned no payload');
    }
  }

  async commitCompletion(fact: FileWriteCompletionFact): Promise<DurableCompletionReceipt> {
    validateFileWriteCompletionFact(fact);
    if (fact.effect.effectId !== await fileWriteEffectId(fact.binding)) {
      throw new JournalIntegrityError('operation completion effect identity does not match its binding');
    }
    const intentCommit = intentCommitId(fact.binding, fact.effect.effectId);
    const completionCommit = await completionCommitIdentity(fact.binding, fact.effect.effectId);
    const record = await this.journal.transaction(
      (context) => context.records.find((candidate) => candidate.commitId === intentCommit) ?? null,
      async (intentRecord, append) => {
        if (intentRecord === null) {
          throw new JournalIntegrityError('operation completion requires a committed effect intent');
        }
        const intentPayload = parsePayload(intentRecord);
        if (intentPayload.kind !== 'operation-effect-intent'
          || !sameEffectExecutionBinding(intentPayload.intent.binding, fact.binding)
          || intentPayload.intent.effect.effectId !== fact.effect.effectId) {
          throw new JournalIntegrityError('operation completion does not match its committed effect intent');
        }
        return await append({
          commitId: completionCommit,
          kind: 'event',
          scope: fact.binding.scope,
          payload: { kind: 'operation-completion', completion: fact } satisfies OperationCompletionPayload,
        });
      },
    );
    return await receiptFromRecord(record, fact);
  }

  async readExact(input: CompletionReadInput): Promise<CompletionReadback> {
    return await decodeOperationCompletionReadback(await this.journal.replay(), input);
  }

  async discoverExactExecution(input: {
    readonly execution: ProviderExecutionIdentityRef;
  }): Promise<readonly OperationCompletionLookupDescriptor[]> {
    return await decodeOperationCompletionLookups(await this.journal.replay(), input.execution);
  }
}
