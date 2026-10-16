import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '../../../contracts/src/explicit-brain.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import {
  assertProviderExecutionIdentity,
  validateAcceptedRawFact,
  validateInteractionSemanticCheckpoint,
  validateInteractionTurnIdentity,
  validateOccurrenceExecutionOwner,
  validateProviderBinding,
  validateProviderCloseResult,
  type AcceptedRawFact,
  type InteractionParentProviderExecutionIdentityRef,
  type InteractionTurnIdentity,
  type OrganId,
  type RuntimeRequestLifecyclePhase,
  type RuntimeRequestRecord,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import type {
  InteractionParentCommittedFact,
  InteractionParentOpenedTurnScopeReadPort,
  InteractionParentResourceCloseFact,
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
  let resourceClose: InteractionParentCommittedFact<InteractionParentResourceCloseFact> | null = null;

  for (const record of records) {
    const payload = readParentRawPayload(record);
    if (payload === null) continue;
    if (!sameTurnIdentity(payload.turn, turn)) continue;
    const execution = payload.discriminant === 'turn-input' ? payload.fact.execution : payload.execution;
    assertRecordScope(record, turn, execution);
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
      if (canonicalJsonStringify(turnInput.fact.execution) !== canonicalJsonStringify(payload.fact.execution)) {
        throw new JournalIntegrityError(
          'interaction parent resource close execution does not match the committed turn input execution',
        );
      }
      resourceClose = { fact: payload.fact, commit };
      continue;
    }
    // Every other discriminant appends request or raw history, so it can never
    // physically follow a committed resource close.
    if (resourceClose !== null) {
      throw new JournalIntegrityError('interaction parent raw append follows the committed resource close');
    }
    if (payload.discriminant === 'request') {
      const phaseKey = `${payload.record.request.requestId}\u0000${payload.record.phase}`;
      if (seenRequestPhases.has(phaseKey)) {
        throw new JournalIntegrityError('interaction parent turn repeats a request phase record');
      }
      seenRequestPhases.add(phaseKey);
      requests.push({ fact: payload.record, commit });
      continue;
    }
    acceptedFacts.push({ fact: payload.entry, commit });
  }

  return { turnInput, requests, acceptedFacts, resourceClose };
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
      commitId: parentRawCommitId(append.turn, 'resource-close'),
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
      ({ records }) => plan(decodeTurn(records, turn)),
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
}
