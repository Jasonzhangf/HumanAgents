import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '../../../contracts/src/explicit-brain.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import {
  assertProviderExecutionIdentity,
  validateAcceptedRawFact,
  validateInteractionSemanticCheckpoint,
  validateInteractionProviderSettlementReceipt,
  validateInteractionTurnIdentity,
  validateOccurrenceExecutionOwner,
  validateProviderBinding,
  validateProviderCloseResult,
  type AcceptedRawFact,
  type InteractionParentProviderExecutionIdentityRef,
  type InteractionProviderSettlementReceipt,
  type InteractionTurnIdentity,
  type OrganId,
  type RuntimeRequestLifecyclePhase,
  type RuntimeRequestRecord,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import type {
  InteractionParentCommittedFact,
  InteractionParentOpenedTurnScopeReadPort,
  InteractionParentOwnerReconciliationFact,
  InteractionParentResourceCloseFact,
  InteractionParentTurnAbandonmentFact,
  InteractionParentTurnAppend,
  InteractionParentTurnInputFact,
  InteractionParentTurnRawJournalPort,
  InteractionParentTurnSnapshot,
} from '../../../runtime/src/explicit-brain/interaction-parent-turn-raw.js';
import {
  JournalIntegrityError,
  type JournalAppendInput,
  type JournalRecord,
  type JsonlOrganJournal,
} from './index.js';

/**
 * Jsonl codec and transaction port for one neutral interaction parent turn.
 *
 * The injected `JsonlOrganJournal` stays the single lock, store and transaction
 * owner; this adapter only encodes the parent raw facts as committed Journal
 * records, decodes a consistent snapshot, and stages a single append inside the
 * owner's transaction. It holds no registry, cache or mirrored state: the
 * durable Journal is the only authority.
 */

const INTERACTION_PARENT_RAW_RECORD_TYPE = 'interaction-parent.turn-raw.v1';

const REQUEST_PHASES: readonly RuntimeRequestLifecyclePhase[] = [
  'dispatching',
  'dispatched',
  'waiting',
  'settled',
  'failed',
  'cancelled',
];

type ParentRawPayload =
  | {
      readonly kind: typeof INTERACTION_PARENT_RAW_RECORD_TYPE;
      readonly discriminant: 'turn-input';
      readonly turn: InteractionTurnIdentity;
      readonly fact: InteractionParentTurnInputFact;
    }
  | {
      readonly kind: typeof INTERACTION_PARENT_RAW_RECORD_TYPE;
      readonly discriminant: 'request';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly record: RuntimeRequestRecord;
    }
  | {
      readonly kind: typeof INTERACTION_PARENT_RAW_RECORD_TYPE;
      readonly discriminant: 'accepted-fact';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly entry: AcceptedRawFact<InteractionParentProviderExecutionIdentityRef>;
    }
  | {
      readonly kind: typeof INTERACTION_PARENT_RAW_RECORD_TYPE;
      readonly discriminant: 'resource-close';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly fact: InteractionParentResourceCloseFact;
    }
  | {
      readonly kind: typeof INTERACTION_PARENT_RAW_RECORD_TYPE;
      readonly discriminant: 'owner-reconciliation';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly fact: InteractionParentOwnerReconciliationFact;
    }
  | {
      readonly kind: typeof INTERACTION_PARENT_RAW_RECORD_TYPE;
      readonly discriminant: 'provider-settlement';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly fact: InteractionProviderSettlementReceipt;
    }
  | {
      readonly kind: typeof INTERACTION_PARENT_RAW_RECORD_TYPE;
      readonly discriminant: 'turn-abandonment';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly fact: InteractionParentTurnAbandonmentFact;
    };

function sameScopedId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function sameTurnIdentity(left: InteractionTurnIdentity, right: InteractionTurnIdentity): boolean {
  return sameScopedId(left.organId, right.organId)
    && left.interactionScopeId === right.interactionScopeId
    && left.interactionId === right.interactionId
    && left.inputRevision === right.inputRevision
    && left.turnId === right.turnId;
}

function sameRequestIdentity(
  left: { readonly turnId: string; readonly requestId: string; readonly parentRequestId?: string },
  right: { readonly turnId: string; readonly requestId: string; readonly parentRequestId?: string },
): boolean {
  return left.turnId === right.turnId
    && left.requestId === right.requestId
    && left.parentRequestId === right.parentRequestId;
}

function sameParentExecutionBusinessIdentity(
  left: InteractionParentProviderExecutionIdentityRef,
  right: InteractionParentProviderExecutionIdentityRef,
): boolean {
  return left.runtimeId === right.runtimeId
    && sameScopedId(left.organId, right.organId)
    && sameScopedId(left.operationId, right.operationId)
    && sameTurnIdentity(left.interactionTurn, right.interactionTurn);
}

function parentScope(
  turn: InteractionTurnIdentity,
  execution: InteractionParentProviderExecutionIdentityRef,
): ScopeRef {
  return { organId: turn.organId, operationId: execution.operationId };
}

function turnKey(turn: InteractionTurnIdentity): string {
  return canonicalJsonStringify([
    turn.organId.scope,
    turn.organId.value,
    turn.interactionScopeId,
    turn.interactionId,
    turn.inputRevision,
    turn.turnId,
  ]);
}

/**
 * The deterministic commit identity is scoped to the turn and to one record
 * discriminant, so a replay returns the original record and a conflicting
 * payload surfaces as a Journal commit conflict. The discriminant is hashed so
 * an arbitrary provider request id always yields a valid commit id.
 */
function parentRawCommitId(turn: InteractionTurnIdentity, discriminant: string): string {
  const turnHash = createHash('sha256').update(turnKey(turn)).digest('hex');
  const recordHash = createHash('sha256').update(discriminant).digest('hex');
  return `interaction-parent-raw:${turnHash}:${recordHash}`;
}

function commitRef(record: JournalRecord): JournalCommitRef {
  if (record.commitId === undefined) {
    throw new JournalIntegrityError('interaction parent raw record is not committed');
  }
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

function assertTurn(turn: unknown): asserts turn is InteractionTurnIdentity {
  if (turn === null || typeof turn !== 'object') {
    throw new JournalIntegrityError('interaction parent raw record is missing its turn');
  }
  validateInteractionTurnIdentity(turn as InteractionTurnIdentity);
}

function assertInteractionParentExecution(
  execution: InteractionParentProviderExecutionIdentityRef,
  turn: InteractionTurnIdentity,
): void {
  assertProviderExecutionIdentity(execution);
  if (execution.interactionTurn === undefined) {
    throw new JournalIntegrityError('interaction parent raw execution is not a neutral interaction parent identity');
  }
  if (!sameTurnIdentity(execution.interactionTurn, turn)) {
    throw new JournalIntegrityError('interaction parent raw execution turn does not match its record turn');
  }
}

function assertParentScope(scope: ScopeRef, turn: InteractionTurnIdentity, execution: InteractionParentProviderExecutionIdentityRef): void {
  if (scope === null || typeof scope !== 'object') {
    throw new JournalIntegrityError('interaction parent raw record is missing its scope');
  }
  if (!sameScopedId(scope.organId, turn.organId)) {
    throw new JournalIntegrityError('interaction parent raw record organ scope does not match its turn');
  }
  if (scope.taskId !== undefined || scope.cycleId !== undefined) {
    throw new JournalIntegrityError('interaction parent raw record cannot carry a task or cycle scope');
  }
  if (!sameScopedId(scope.operationId, execution.operationId)) {
    throw new JournalIntegrityError('interaction parent raw record operation scope does not match its execution');
  }
}

function assertTurnInputFact(fact: InteractionParentTurnInputFact): void {
  if (fact === null || typeof fact !== 'object') {
    throw new JournalIntegrityError('interaction parent turn input fact is invalid');
  }
  assertTurn(fact.turn);
  assertInteractionParentExecution(fact.execution, fact.turn);
  assertParentScope(fact.scope, fact.turn, fact.execution);
  if (fact.executionOwner !== undefined) validateOccurrenceExecutionOwner(fact.executionOwner);
  if (fact.providerBinding !== undefined) validateProviderBinding(fact.providerBinding);
  if (!Array.isArray(fact.priorCheckpoints)) {
    throw new JournalIntegrityError('interaction parent turn input prior checkpoints must be an array');
  }
  for (const checkpoint of fact.priorCheckpoints) {
    validateInteractionSemanticCheckpoint(checkpoint);
    if (sameTurnIdentity(checkpoint, fact.turn)) {
      throw new JournalIntegrityError('interaction parent turn input carries the current turn as prior history');
    }
  }
}

/**
 * Validate one durable resource-close fact. It must carry a real closed
 * receipt for its own binding; a legacy turn without the original binding is
 * rejected elsewhere, where the turn input is available.
 */
function assertResourceCloseFact(
  fact: InteractionParentResourceCloseFact,
  turn: InteractionTurnIdentity,
): void {
  if (fact === null || typeof fact !== 'object') {
    throw new JournalIntegrityError('interaction parent resource close fact is invalid');
  }
  assertTurn(fact.turn);
  if (!sameTurnIdentity(fact.turn, turn)) {
    throw new JournalIntegrityError('interaction parent resource close turn does not match its record turn');
  }
  assertInteractionParentExecution(fact.execution, fact.turn);
  validateProviderBinding(fact.providerBinding);
  validateProviderCloseResult(fact.result);
  if (fact.result.state !== 'closed') {
    throw new JournalIntegrityError('interaction parent resource close fact requires a closed receipt');
  }
  if (fact.result.bindingId !== fact.providerBinding.bindingId
    || fact.result.providerId !== fact.providerBinding.providerId
    || fact.result.protocol !== fact.providerBinding.protocol) {
    throw new JournalIntegrityError('interaction parent resource close receipt does not match its binding');
  }
  if (typeof fact.closedAt !== 'string' || fact.closedAt.trim() === '') {
    throw new JournalIntegrityError('interaction parent resource close requires a closedAt timestamp');
  }
}

/**
 * Validate one durable owner-reconciliation fact. It is a local owner
 * transition only: the remote provider state must stay `unknown`, and no
 * resource-close claim may be smuggled through it.
 */
function assertOwnerReconciliationFact(
  fact: InteractionParentOwnerReconciliationFact,
  turn: InteractionTurnIdentity,
): void {
  if (fact === null || typeof fact !== 'object') {
    throw new JournalIntegrityError('interaction parent owner reconciliation fact is invalid');
  }
  assertTurn(fact.turn);
  if (!sameTurnIdentity(fact.turn, turn)) {
    throw new JournalIntegrityError('interaction parent owner reconciliation turn does not match its record turn');
  }
  assertInteractionParentExecution(fact.execution, fact.turn);
  validateProviderBinding(fact.providerBinding);
  validateOccurrenceExecutionOwner(fact.previousOwner);
  validateOccurrenceExecutionOwner(fact.replacementOwner);
  if (fact.mode !== 'terminal-output' && fact.mode !== 'continue') {
    throw new JournalIntegrityError('interaction parent owner reconciliation mode is invalid');
  }
  if (!Number.isSafeInteger(fact.effectiveExecutionEpoch) || fact.effectiveExecutionEpoch < 1) {
    throw new JournalIntegrityError('interaction parent owner reconciliation effective epoch is invalid');
  }
  if (!Array.isArray(fact.unsettledRequestIds)
    || fact.unsettledRequestIds.some((requestId) => typeof requestId !== 'string' || requestId.trim() === '')) {
    throw new JournalIntegrityError('interaction parent owner reconciliation unsettled request ids are invalid');
  }
  if (new Set(fact.unsettledRequestIds).size !== fact.unsettledRequestIds.length) {
    throw new JournalIntegrityError('interaction parent owner reconciliation unsettled request ids repeat');
  }
  if (fact.remoteProviderState !== 'unknown') {
    throw new JournalIntegrityError('interaction parent owner reconciliation cannot claim the remote provider state');
  }
  if (typeof fact.reconciledAt !== 'string' || fact.reconciledAt.trim() === '') {
    throw new JournalIntegrityError('interaction parent owner reconciliation requires a reconciledAt timestamp');
  }
}

function assertProviderSettlementFact(
  fact: InteractionProviderSettlementReceipt,
  turn: InteractionTurnIdentity,
  execution: InteractionParentProviderExecutionIdentityRef,
): void {
  if (fact === null || typeof fact !== 'object') {
    throw new JournalIntegrityError('interaction parent provider settlement receipt is invalid');
  }
  validateInteractionProviderSettlementReceipt(fact);
  if (!sameTurnIdentity(fact.settlement.interactionTurn, turn)) {
    throw new JournalIntegrityError(
      'interaction parent provider settlement turn does not match its record turn',
    );
  }
  if (execution.runtimeId !== fact.settlement.runtimeId
    || !sameScopedId(execution.organId, fact.settlement.organId)
    || !sameScopedId(execution.operationId, fact.settlement.operationId)
    || execution.executionEpoch !== fact.settlement.executionEpoch
    || !sameTurnIdentity(execution.interactionTurn, fact.settlement.interactionTurn)) {
    throw new JournalIntegrityError(
      'interaction parent provider settlement execution does not match its record execution',
    );
  }
}

/**
 * Validate one durable interrupted-turn discharge. It may only describe the
 * crash-left interrupted shape: it never carries a success, a close or a
 * settled output, and it can only follow the committed input and binding.
 */
function assertAbandonmentFact(
  fact: InteractionParentTurnAbandonmentFact,
  turn: InteractionTurnIdentity,
): void {
  if (fact === null || typeof fact !== 'object') {
    throw new JournalIntegrityError('interaction parent turn abandonment fact is invalid');
  }
  assertTurn(fact.turn);
  if (!sameTurnIdentity(fact.turn, turn)) {
    throw new JournalIntegrityError('interaction parent turn abandonment turn does not match its record turn');
  }
  assertInteractionParentExecution(fact.execution, fact.turn);
  validateProviderBinding(fact.providerBinding);
  if (fact.reason !== 'provider-interrupted-without-terminal-output') {
    throw new JournalIntegrityError('interaction parent turn abandonment reason is invalid');
  }
  if (typeof fact.abandonedAt !== 'string' || fact.abandonedAt.trim() === '') {
    throw new JournalIntegrityError('interaction parent turn abandonment requires an abandonedAt timestamp');
  }
}

function assertRequestRecord(
  record: RuntimeRequestRecord,
  turn: InteractionTurnIdentity,
  execution: InteractionParentProviderExecutionIdentityRef,
): void {
  if (record === null || typeof record !== 'object' || record.request === null || typeof record.request !== 'object') {
    throw new JournalIntegrityError('interaction parent request record is invalid');
  }
  if (typeof record.request.turnId !== 'string' || record.request.turnId.trim() === ''
    || typeof record.request.requestId !== 'string' || record.request.requestId.trim() === '') {
    throw new JournalIntegrityError('interaction parent request identity is incomplete');
  }
  if (record.request.parentRequestId !== undefined
    && (typeof record.request.parentRequestId !== 'string' || record.request.parentRequestId.trim() === '')) {
    throw new JournalIntegrityError('interaction parent request parentRequestId is invalid');
  }
  if (record.parentRequestId !== undefined && record.parentRequestId !== record.request.parentRequestId) {
    throw new JournalIntegrityError('interaction parent request parentRequestId does not match its identity');
  }
  if (!REQUEST_PHASES.includes(record.phase)) {
    throw new JournalIntegrityError('interaction parent request phase is invalid');
  }
  assertParentScope(record.scope, turn, execution);
}

function readParentRawPayload(record: JournalRecord): ParentRawPayload | null {
  const payload = record.payload;
  if (payload === undefined || payload.kind !== INTERACTION_PARENT_RAW_RECORD_TYPE) return null;
  const discriminant = payload.discriminant;
  if (discriminant === 'turn-input') {
    const fact = payload.fact as InteractionParentTurnInputFact;
    assertTurnInputFact(fact);
    return { kind: INTERACTION_PARENT_RAW_RECORD_TYPE, discriminant, turn: fact.turn, fact };
  }
  if (discriminant === 'request') {
    const turn = payload.turn as InteractionTurnIdentity;
    const execution = payload.execution as InteractionParentProviderExecutionIdentityRef;
    const requestRecord = payload.record as RuntimeRequestRecord;
    assertTurn(turn);
    assertInteractionParentExecution(execution, turn);
    assertRequestRecord(requestRecord, turn, execution);
    return { kind: INTERACTION_PARENT_RAW_RECORD_TYPE, discriminant, turn, execution, record: requestRecord };
  }
  if (discriminant === 'accepted-fact') {
    const turn = payload.turn as InteractionTurnIdentity;
    const execution = payload.execution as InteractionParentProviderExecutionIdentityRef;
    const entry = payload.entry as AcceptedRawFact<InteractionParentProviderExecutionIdentityRef>;
    assertTurn(turn);
    assertInteractionParentExecution(execution, turn);
    validateAcceptedRawFact(entry);
    if (entry.envelope.execution.runtimeId !== execution.runtimeId
      || entry.envelope.execution.executionEpoch !== execution.executionEpoch) {
      throw new JournalIntegrityError('interaction parent raw fact execution does not match its record execution');
    }
    assertParentScope(entry.envelope.scope, turn, execution);
    return { kind: INTERACTION_PARENT_RAW_RECORD_TYPE, discriminant, turn, execution, entry };
  }
  if (discriminant === 'resource-close') {
    const turn = payload.turn as InteractionTurnIdentity;
    const execution = payload.execution as InteractionParentProviderExecutionIdentityRef;
    const fact = payload.fact as InteractionParentResourceCloseFact;
    assertTurn(turn);
    assertInteractionParentExecution(execution, turn);
    assertResourceCloseFact(fact, turn);
    if (canonicalJsonStringify(fact.execution) !== canonicalJsonStringify(execution)) {
      throw new JournalIntegrityError('interaction parent resource close execution does not match its record execution');
    }
    return { kind: INTERACTION_PARENT_RAW_RECORD_TYPE, discriminant, turn, execution, fact };
  }
  if (discriminant === 'owner-reconciliation') {
    const turn = payload.turn as InteractionTurnIdentity;
    const execution = payload.execution as InteractionParentProviderExecutionIdentityRef;
    const fact = payload.fact as InteractionParentOwnerReconciliationFact;
    assertTurn(turn);
    assertInteractionParentExecution(execution, turn);
    assertOwnerReconciliationFact(fact, turn);
    if (canonicalJsonStringify(fact.execution) !== canonicalJsonStringify(execution)) {
      throw new JournalIntegrityError(
        'interaction parent owner reconciliation execution does not match its record execution',
      );
    }
    return { kind: INTERACTION_PARENT_RAW_RECORD_TYPE, discriminant, turn, execution, fact };
  }
  if (discriminant === 'provider-settlement') {
    const turn = payload.turn as InteractionTurnIdentity;
    const execution = payload.execution as InteractionParentProviderExecutionIdentityRef;
    const fact = payload.fact as InteractionProviderSettlementReceipt;
    assertTurn(turn);
    assertInteractionParentExecution(execution, turn);
    assertProviderSettlementFact(fact, turn, execution);
    return { kind: INTERACTION_PARENT_RAW_RECORD_TYPE, discriminant, turn, execution, fact };
  }
  if (discriminant === 'turn-abandonment') {
    const turn = payload.turn as InteractionTurnIdentity;
    const execution = payload.execution as InteractionParentProviderExecutionIdentityRef;
    const fact = payload.fact as InteractionParentTurnAbandonmentFact;
    assertTurn(turn);
    assertInteractionParentExecution(execution, turn);
    assertAbandonmentFact(fact, turn);
    if (canonicalJsonStringify(fact.execution) !== canonicalJsonStringify(execution)) {
      throw new JournalIntegrityError(
        'interaction parent turn abandonment execution does not match its record execution',
      );
    }
    return { kind: INTERACTION_PARENT_RAW_RECORD_TYPE, discriminant, turn, execution, fact };
  }
  throw new JournalIntegrityError('interaction parent raw record discriminant is invalid');
}

function assertRecordScope(
  record: JournalRecord,
  turn: InteractionTurnIdentity,
  execution: InteractionParentProviderExecutionIdentityRef,
): void {
  if (record.kind !== 'event') {
    throw new JournalIntegrityError('interaction parent raw record must be an event');
  }
  if (record.commitId === undefined) {
    throw new JournalIntegrityError('interaction parent raw record must be committed');
  }
  assertParentScope(record.scope, turn, execution);
}

function decodeTurn(records: readonly JournalRecord[], turn: InteractionTurnIdentity): InteractionParentTurnSnapshot {
  let turnInput: InteractionParentCommittedFact<InteractionParentTurnInputFact> | null = null;
  const requests: InteractionParentCommittedFact<RuntimeRequestRecord>[] = [];
  const acceptedFacts: InteractionParentCommittedFact<
    AcceptedRawFact<InteractionParentProviderExecutionIdentityRef>
  >[] = [];
  const seenRequestPhases = new Set<string>();
  const requestEpochs = new Map<string, number>();
  const ownerReconciliations: InteractionParentCommittedFact<InteractionParentOwnerReconciliationFact>[] = [];
  const providerSettlements: InteractionParentCommittedFact<
    InteractionProviderSettlementReceipt
  >[] = [];
  let resourceClose: InteractionParentCommittedFact<InteractionParentResourceCloseFact> | null = null;
  let abandonment: InteractionParentCommittedFact<InteractionParentTurnAbandonmentFact> | null = null;

  for (const record of records) {
    const payload = readParentRawPayload(record);
    if (payload === null) continue;
    if (!sameTurnIdentity(payload.turn, turn)) continue;
    const execution = payload.discriminant === 'turn-input' ? payload.fact.execution : payload.execution;
    assertRecordScope(record, turn, execution);
    // A discharged turn is terminal: no request, raw fact or control record
    // may append after the single abandonment fact.
    if (abandonment !== null) {
      throw new JournalIntegrityError('interaction parent raw append follows the committed turn abandonment');
    }
    const commit = commitRef(record);
    if (payload.discriminant === 'turn-input') {
      if (turnInput !== null) {
        throw new JournalIntegrityError('interaction parent turn has more than one committed turn input');
      }
      turnInput = { fact: payload.fact, commit };
      continue;
    }
    if (payload.discriminant === 'resource-close') {
      if (resourceClose !== null) {
        throw new JournalIntegrityError('interaction parent turn has more than one committed resource close');
      }
      if (turnInput === null) {
        throw new JournalIntegrityError(
          'interaction parent resource close requires the committed turn input before it',
        );
      }
      const committedBinding = turnInput.fact.providerBinding;
      if (committedBinding === undefined) {
        throw new JournalIntegrityError(
          'interaction parent resource close requires the original committed provider binding',
        );
      }
      if (canonicalJsonStringify(committedBinding) !== canonicalJsonStringify(payload.fact.providerBinding)) {
        throw new JournalIntegrityError(
          'interaction parent resource close binding does not match the committed turn input binding',
        );
      }
      const activeEpoch = ownerReconciliations.at(-1)?.fact.effectiveExecutionEpoch
        ?? turnInput.fact.execution.executionEpoch;
      if (!sameParentExecutionBusinessIdentity(turnInput.fact.execution, payload.fact.execution)
        || payload.fact.execution.executionEpoch !== activeEpoch) {
        throw new JournalIntegrityError(
          'interaction parent resource close execution does not match the committed turn input execution',
        );
      }
      resourceClose = { fact: payload.fact, commit };
      continue;
    }
    // Beyond the existing continue reconciliation branch, a Provider settlement
    // control record may follow a committed close. Request and raw history stay
    // frozen after physical release.
    if (payload.discriminant === 'provider-settlement') {
      if (turnInput === null) {
        throw new JournalIntegrityError(
          'interaction parent provider settlement requires the committed turn input before it',
        );
      }
      const activeEpoch = ownerReconciliations.at(-1)?.fact.effectiveExecutionEpoch
        ?? turnInput.fact.execution.executionEpoch;
      if (!sameParentExecutionBusinessIdentity(turnInput.fact.execution, payload.execution)
        || payload.execution.executionEpoch !== activeEpoch) {
        throw new JournalIntegrityError(
          'interaction parent provider settlement requires the active physical execution epoch',
        );
      }
      const registered = requests
        .filter((record) => sameRequestIdentity(record.fact.request, payload.fact.request))
        .at(-1);
      if (registered === undefined) {
        throw new JournalIntegrityError(
          'interaction parent provider settlement requires the registered terminal request',
        );
      }
      if (requestEpochs.get(payload.fact.request.requestId) !== activeEpoch
        || registered.fact.phase !== 'settled') {
        throw new JournalIntegrityError(
          'interaction parent provider settlement request is not settled in the active epoch',
        );
      }
      if (providerSettlements.some((entry) =>
        entry.fact.settlement.executionEpoch === activeEpoch
        && sameRequestIdentity(entry.fact.request, payload.fact.request))) {
        throw new JournalIntegrityError(
          'interaction parent turn repeats a provider settlement for one request',
        );
      }
      providerSettlements.push({ fact: payload.fact, commit });
      continue;
    }
    // A discharge freezes the turn and is otherwise the only record that may
    // follow a committed close or reconciliation-free running epoch.
    if (payload.discriminant === 'turn-abandonment') {
      if (turnInput === null) {
        throw new JournalIntegrityError(
          'interaction parent turn abandonment requires the committed turn input before it',
        );
      }
      if (resourceClose !== null || ownerReconciliations.length > 0) {
        throw new JournalIntegrityError(
          'interaction parent turn abandonment requires an interrupted turn without a committed close or reconciliation',
        );
      }
      if (providerSettlements.length > 0 || turnInput.fact.executionOwner === undefined) {
        throw new JournalIntegrityError(
          'interaction parent turn abandonment requires the attested interrupted turn input',
        );
      }
      const committedBinding = turnInput.fact.providerBinding;
      if (committedBinding === undefined) {
        throw new JournalIntegrityError(
          'interaction parent turn abandonment requires the original committed provider binding',
        );
      }
      if (canonicalJsonStringify(committedBinding) !== canonicalJsonStringify(payload.fact.providerBinding)
        || !sameParentExecutionBusinessIdentity(turnInput.fact.execution, payload.fact.execution)
        || payload.fact.execution.executionEpoch !== turnInput.fact.execution.executionEpoch) {
        throw new JournalIntegrityError(
          'interaction parent turn abandonment execution does not match the committed turn input execution',
        );
      }
      if (abandonment !== null) {
        throw new JournalIntegrityError('interaction parent turn repeats a committed abandonment');
      }
      abandonment = { fact: payload.fact, commit };
      continue;
    }
    // An owner reconciliation is otherwise the only record that may follow a
    // committed close. A post-close reconciliation must be a `continue` that
    // opens the next physical epoch.
    if (payload.discriminant === 'owner-reconciliation') {
      if (turnInput === null || turnInput.fact.executionOwner === undefined
        || turnInput.fact.providerBinding === undefined) {
        throw new JournalIntegrityError('interaction parent reconciliation requires the attested turn input');
      }
      const closed = resourceClose !== null;
      if (closed && payload.fact.mode !== 'continue') {
        throw new JournalIntegrityError('interaction parent raw append follows the committed resource close');
      }
      const latest = ownerReconciliations.at(-1)?.fact;
      const previousOwner = latest?.replacementOwner ?? turnInput.fact.executionOwner;
      const activeEpoch = latest?.effectiveExecutionEpoch ?? turnInput.fact.execution.executionEpoch;
      if (canonicalJsonStringify(previousOwner) !== canonicalJsonStringify(payload.fact.previousOwner)
        || (!closed && canonicalJsonStringify(previousOwner) === canonicalJsonStringify(payload.fact.replacementOwner))
        || canonicalJsonStringify(turnInput.fact.providerBinding) !== canonicalJsonStringify(payload.fact.providerBinding)
        || !sameParentExecutionBusinessIdentity(turnInput.fact.execution, payload.execution)
        || payload.execution.executionEpoch !== payload.fact.effectiveExecutionEpoch
        || payload.fact.effectiveExecutionEpoch !== activeEpoch + (payload.fact.mode === 'continue' ? 1 : 0)) {
        throw new JournalIntegrityError('interaction parent reconciliation does not match the active owner and epoch');
      }
      ownerReconciliations.push({ fact: payload.fact, commit });
      // Opening the next epoch clears the prior close, so the new epoch's
      // request, raw facts and its own single close may append again.
      if (closed) resourceClose = null;
      continue;
    }
    // Every other discriminant appends request or raw history, so it can never
    // physically follow a committed resource close.
    if (resourceClose !== null) {
      throw new JournalIntegrityError('interaction parent raw append follows the committed resource close');
    }
    if (payload.discriminant === 'request') {
      if (turnInput === null) {
        throw new JournalIntegrityError(
          'interaction parent request requires the committed turn input before it',
        );
      }
      const phaseKey = `${payload.record.request.requestId}\u0000${payload.record.phase}`;
      if (seenRequestPhases.has(phaseKey)) {
        throw new JournalIntegrityError('interaction parent turn repeats a request phase record');
      }
      seenRequestPhases.add(phaseKey);
      requestEpochs.set(
        payload.record.request.requestId,
        ownerReconciliations.at(-1)?.fact.effectiveExecutionEpoch
          ?? turnInput.fact.execution.executionEpoch,
      );
      requests.push({ fact: payload.record, commit });
      continue;
    }
    acceptedFacts.push({ fact: payload.entry, commit });
  }

  return {
    turnInput, requests, acceptedFacts, ownerReconciliations, providerSettlements,
    resourceClose, abandonment,
  };
}

function toAppendInput(append: InteractionParentTurnAppend): JournalAppendInput {
  if (append.kind === 'turn-input') {
    const fact = append.fact;
    return {
      commitId: parentRawCommitId(fact.turn, 'turn-input'),
      kind: 'event',
      scope: parentScope(fact.turn, fact.execution),
      payload: { kind: INTERACTION_PARENT_RAW_RECORD_TYPE, discriminant: 'turn-input', turn: fact.turn, fact },
    };
  }
  if (append.kind === 'request') {
    return {
      commitId: parentRawCommitId(
        append.turn,
        `request:${append.record.request.requestId}:${append.record.phase}`,
      ),
      kind: 'event',
      scope: parentScope(append.turn, append.execution),
      payload: {
        kind: INTERACTION_PARENT_RAW_RECORD_TYPE,
        discriminant: 'request',
        turn: append.turn,
        execution: append.execution,
        record: append.record,
      },
    };
  }
  if (append.kind === 'resource-close') {
    return {
      // The original epoch keeps the exact `resource-close` commit id so every
      // persisted epoch-1 receipt stays byte-for-byte compatible. A later epoch
      // scopes its own close identity to the real execution epoch.
      commitId: parentRawCommitId(append.turn,
        append.execution.executionEpoch === 1 ? 'resource-close' : `resource-close:${append.execution.executionEpoch}`),
      kind: 'event',
      scope: parentScope(append.turn, append.execution),
      payload: {
        kind: INTERACTION_PARENT_RAW_RECORD_TYPE,
        discriminant: 'resource-close',
        turn: append.turn,
        execution: append.execution,
        fact: append.fact,
      },
    };
  }
  if (append.kind === 'owner-reconciliation') {
    const generationPair =
      `owner-reconciliation:${append.fact.previousOwner.daemonGeneration}->${append.fact.replacementOwner.daemonGeneration}`;
    // A same-generation re-entry (a closed failed epoch resumed by its own
    // owner) needs the effective epoch in the id so the commit stays idempotent
    // and distinct from the original distinct-owner takeover.
    const discriminant = append.fact.previousOwner.daemonGeneration === append.fact.replacementOwner.daemonGeneration
      ? `${generationPair}:${append.fact.effectiveExecutionEpoch}`
      : generationPair;
    return {
      commitId: parentRawCommitId(append.turn, discriminant),
      kind: 'event',
      scope: parentScope(append.turn, append.execution),
      payload: {
        kind: INTERACTION_PARENT_RAW_RECORD_TYPE,
        discriminant: 'owner-reconciliation',
        turn: append.turn,
        execution: append.execution,
        fact: append.fact,
      },
    };
  }
  if (append.kind === 'provider-settlement') {
    return {
      commitId: parentRawCommitId(
        append.turn,
        `provider-settlement:${append.execution.executionEpoch}:${canonicalJsonStringify(append.fact.request)}`,
      ),
      kind: 'event',
      scope: parentScope(append.turn, append.execution),
      payload: {
        kind: INTERACTION_PARENT_RAW_RECORD_TYPE,
        discriminant: 'provider-settlement',
        turn: append.turn,
        execution: append.execution,
        fact: append.fact,
      },
    };
  }
  if (append.kind === 'turn-abandonment') {
    return {
      commitId: parentRawCommitId(append.turn, 'turn-abandonment'),
      kind: 'event',
      scope: parentScope(append.turn, append.execution),
      payload: {
        kind: INTERACTION_PARENT_RAW_RECORD_TYPE,
        discriminant: 'turn-abandonment',
        turn: append.turn,
        execution: append.execution,
        fact: append.fact,
      },
    };
  }
  const entry = append.entry;
  return {
    commitId: parentRawCommitId(
      append.turn,
      `accepted-fact:${entry.envelope.request.requestId}:${entry.envelope.producerSeq}`,
    ),
    kind: 'event',
    scope: parentScope(append.turn, append.execution),
    payload: {
      kind: INTERACTION_PARENT_RAW_RECORD_TYPE,
      discriminant: 'accepted-fact',
      turn: append.turn,
      execution: append.execution,
      entry,
    },
  };
}

export class JsonlInteractionParentTurnJournal
  implements InteractionParentTurnRawJournalPort, InteractionParentOpenedTurnScopeReadPort {
  constructor(private readonly journal: JsonlOrganJournal) {}

  async transactTurn<TResult>(
    turn: InteractionTurnIdentity,
    plan: (snapshot: InteractionParentTurnSnapshot) => {
      readonly append?: InteractionParentTurnAppend;
      readonly result: TResult;
    },
  ): Promise<{ readonly committed?: JournalCommitRef; readonly result: TResult }> {
    validateInteractionTurnIdentity(turn);
    return this.journal.transaction(
      ({ records }) => {
        const snapshot = decodeTurn(records, turn);
        const planned = plan(snapshot);
        // A discharged turn is frozen. Reject the append inside the same
        // transaction that planned it, so the durable turn never becomes
        // undecodable from a late write.
        if (planned.append !== undefined && snapshot.abandonment !== null) {
          throw new JournalIntegrityError('interaction parent raw append follows the committed turn abandonment');
        }
        return planned;
      },
      async (planned, append) => {
        if (planned.append === undefined) return { result: planned.result };
        const record = await append(toAppendInput(planned.append));
        return { committed: commitRef(record), result: planned.result };
      },
    );
  }

  async readTurnSnapshot(turn: InteractionTurnIdentity): Promise<InteractionParentTurnSnapshot> {
    validateInteractionTurnIdentity(turn);
    return decodeTurn(await this.journal.replay(), turn);
  }

  async readScopeOpenedTurns(scope: {
    readonly organId: OrganId;
    readonly interactionScopeId: string;
  }): Promise<readonly InteractionParentCommittedFact<InteractionParentTurnInputFact>[]> {
    if (scope.organId === null || typeof scope.organId !== 'object'
      || scope.organId.scope !== 'organ' || !scope.organId.value.trim()) {
      throw new JournalIntegrityError('interaction parent scope read requires a valid organ id');
    }
    if (typeof scope.interactionScopeId !== 'string' || scope.interactionScopeId.trim() === '') {
      throw new JournalIntegrityError('interaction parent scope read requires an interactionScopeId');
    }
    const opened: InteractionParentCommittedFact<InteractionParentTurnInputFact>[] = [];
    for (const record of await this.journal.replay()) {
      const payload = readParentRawPayload(record);
      if (payload === null || payload.discriminant !== 'turn-input') continue;
      if (!sameScopedId(payload.fact.turn.organId, scope.organId)) continue;
      if (payload.fact.turn.interactionScopeId !== scope.interactionScopeId) continue;
      assertRecordScope(record, payload.fact.turn, payload.fact.execution);
      opened.push({ fact: payload.fact, commit: commitRef(record) });
    }
    return opened;
  }

  async readScopeAbandonedTurns(scope: {
    readonly organId: OrganId;
    readonly interactionScopeId: string;
  }): Promise<readonly InteractionParentCommittedFact<InteractionParentTurnAbandonmentFact>[]> {
    if (scope.organId === null || typeof scope.organId !== 'object'
      || scope.organId.scope !== 'organ' || !scope.organId.value.trim()) {
      throw new JournalIntegrityError('interaction parent scope read requires a valid organ id');
    }
    if (typeof scope.interactionScopeId !== 'string' || scope.interactionScopeId.trim() === '') {
      throw new JournalIntegrityError('interaction parent scope read requires an interactionScopeId');
    }
    const abandoned: InteractionParentCommittedFact<InteractionParentTurnAbandonmentFact>[] = [];
    for (const record of await this.journal.replay()) {
      const payload = readParentRawPayload(record);
      if (payload === null || payload.discriminant !== 'turn-abandonment') continue;
      if (!sameScopedId(payload.fact.turn.organId, scope.organId)) continue;
      if (payload.fact.turn.interactionScopeId !== scope.interactionScopeId) continue;
      assertRecordScope(record, payload.fact.turn, payload.execution);
      abandoned.push({ fact: payload.fact, commit: commitRef(record) });
    }
    return abandoned;
  }
}
