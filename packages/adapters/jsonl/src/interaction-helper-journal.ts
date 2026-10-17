import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '../../../contracts/src/explicit-brain.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import {
  validateInteractionHelperAssignment,
  validateInteractionHelperHandoffFact,
  validateInteractionHelperIdentity,
  validateInteractionHelperResult,
  validateInteractionSemanticCheckpoint,
  validateInteractionTurnIdentity,
  type InteractionHelperAssignment,
  type InteractionHelperDispatchAcceptedFact,
  type InteractionHelperIdentity,
  type InteractionHelperOwnerAcceptedFact,
  type InteractionHelperResult,
  type InteractionHelperReturnedFact,
  type InteractionSemanticCheckpoint,
  type InteractionTurnIdentity,
} from '../../../contracts/src/interaction-helper.js';
import type { OrganId, ScopeRef } from '../../../contracts/src/index.js';
import type {
  InteractionHelperTurnReadbackEntry,
  InteractionHelperTurnReadPort,
  InteractionSemanticCheckpointCommit,
} from '../../../runtime/src/explicit-brain/interaction-turn-session.js';
import type {
  InteractionHelperCallCheckpoint,
  InteractionHelperCallCheckpointCommit,
  InteractionHelperCallCheckpointPhase,
  InteractionHelperOwnerAcceptedCommit,
  InteractionHelperReturnedCommit,
} from '../../../runtime/src/explicit-brain/taskless-helper-executor.js';
import {
  JournalIntegrityError,
  type JournalRecord,
  type JsonlOrganJournal,
} from './index.js';

// The Runtime owns the semantic checkpoint receipt shape; the adapter keeps its
// public name so downstream importers do not change.
export type {
  InteractionHelperTurnReadbackEntry,
  InteractionHelperTurnReadPort,
  InteractionSemanticCheckpointCommit,
} from '../../../runtime/src/explicit-brain/interaction-turn-session.js';

const HANDOFF_RECORD_TYPE = 'interaction-helper.handoff.v1';
const CALL_CHECKPOINT_RECORD_TYPE = 'interaction-helper.call-checkpoint.v1';
const SEMANTIC_CHECKPOINT_RECORD_TYPE = 'interaction-helper.semantic-checkpoint.v1';

type DurableHandoffFact =
  | InteractionHelperDispatchAcceptedFact
  | InteractionHelperReturnedFact
  | InteractionHelperOwnerAcceptedFact;

type DurableHandoffKind = DurableHandoffFact['kind'];

export interface InteractionHelperCommittedFact<TFact> {
  readonly fact: TFact;
  readonly commit: JournalCommitRef;
}

export interface InteractionHelperJournalReadback {
  readonly dispatchAccepted:
    InteractionHelperCommittedFact<InteractionHelperDispatchAcceptedFact> | null;
  readonly returned:
    InteractionHelperCommittedFact<InteractionHelperReturnedFact> | null;
  readonly ownerAccepted:
    InteractionHelperCommittedFact<InteractionHelperOwnerAcceptedFact> | null;
  readonly returnedCheckpoint: InteractionHelperCallCheckpointCommit | null;
  readonly adoptedCheckpoint: InteractionHelperCallCheckpointCommit | null;
}

interface LegacyOwnerAcceptedFact {
  readonly kind: 'legacy-owner-accepted-missing-refined';
  readonly fact: Omit<InteractionHelperOwnerAcceptedFact, 'refinedResult'>;
  readonly commit: JournalCommitRef;
}

interface DecodedInteractionHelperJournal {
  readonly dispatchAccepted: ReadonlyMap<
    string,
    InteractionHelperCommittedFact<InteractionHelperDispatchAcceptedFact>
  >;
  readonly returned: ReadonlyMap<
    string,
    InteractionHelperCommittedFact<InteractionHelperReturnedFact>
  >;
  readonly ownerAccepted: ReadonlyMap<
    string,
    InteractionHelperCommittedFact<InteractionHelperOwnerAcceptedFact>
  >;
  readonly callCheckpoints: ReadonlyMap<string, InteractionHelperCallCheckpointCommit>;
  readonly returnedCheckpointDescriptions: ReadonlyMap<string, string>;
  readonly ownerAcceptedCheckpointDescriptions: ReadonlyMap<string, string>;
  readonly semanticCheckpoints: ReadonlyMap<string, InteractionSemanticCheckpointCommit>;
  readonly legacyOwnerAcceptedMissingRefined: ReadonlyMap<string, LegacyOwnerAcceptedFact>;
}

function sameOrganId(left: OrganId, right: OrganId): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function organScope(organId: OrganId): ScopeRef {
  return { organId };
}

function helperIdentityKey(identity: InteractionHelperIdentity): string {
  return canonicalJsonStringify([
    identity.organId.scope,
    identity.organId.value,
    identity.interactionScopeId,
    identity.interactionId,
    identity.inputRevision,
    identity.parentTurnId,
    identity.assignmentId,
    identity.helperCallId,
    identity.attempt,
  ]);
}

function helperIdentityOf(result: InteractionHelperIdentity): InteractionHelperIdentity {
  return {
    organId: result.organId,
    interactionScopeId: result.interactionScopeId,
    interactionId: result.interactionId,
    inputRevision: result.inputRevision,
    parentTurnId: result.parentTurnId,
    assignmentId: result.assignmentId,
    helperCallId: result.helperCallId,
    attempt: result.attempt,
  };
}

function callCheckpointKey(
  identity: InteractionHelperIdentity,
  phase: InteractionHelperCallCheckpointPhase,
): string {
  return canonicalJsonStringify([phase, helperIdentityKey(identity)]);
}

function turnIdentityKey(identity: InteractionTurnIdentity): string {
  return canonicalJsonStringify([
    identity.organId.scope,
    identity.organId.value,
    identity.interactionScopeId,
    identity.interactionId,
    identity.inputRevision,
    identity.turnId,
  ]);
}

function commitId(kind: DurableHandoffKind, identityKey: string): string {
  return `interaction-helper:${kind}:${createHash('sha256').update(identityKey).digest('hex')}`;
}

function callCheckpointCommitId(
  phase: InteractionHelperCallCheckpointPhase,
  identityKey: string,
): string {
  return `interaction-helper:call-checkpoint:${phase}:${createHash('sha256')
    .update(identityKey)
    .digest('hex')}`;
}

function semanticCheckpointCommitId(identityKey: string): string {
  return `interaction-helper:semantic-checkpoint:${createHash('sha256')
    .update(identityKey)
    .digest('hex')}`;
}

function commitRef(record: JournalRecord): JournalCommitRef {
  if (record.commitId === undefined) {
    throw new JournalIntegrityError('interaction helper journal record is not committed');
  }
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

function assertOrganOnlyRecord(record: JournalRecord, organId: OrganId): void {
  if (!sameOrganId(record.scope.organId, organId)
    || record.scope.taskId !== undefined
    || record.scope.cycleId !== undefined
    || record.scope.operationId !== undefined) {
    throw new JournalIntegrityError('interaction helper fact must use its organ-only Journal scope');
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new JournalIntegrityError(`${label} must be a non-empty string`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(value))) {
    throw new JournalIntegrityError(`${label} must be a valid timestamp`);
  }
}

function validateCallCheckpoint(checkpoint: InteractionHelperCallCheckpoint): void {
  validateInteractionHelperIdentity(checkpoint.identity);
  if (checkpoint.phase !== 'returned' && checkpoint.phase !== 'adopted') {
    throw new JournalIntegrityError('interaction helper call checkpoint phase is invalid');
  }
  assertTimestamp(checkpoint.recordedAt, 'interaction helper call checkpoint recordedAt');
  assertNonEmptyString(checkpoint.description, 'interaction helper call checkpoint description');
  if (checkpoint.recovery === null || typeof checkpoint.recovery !== 'object') {
    throw new JournalIntegrityError('interaction helper call checkpoint recovery is invalid');
  }
  assertNonEmptyString(
    checkpoint.recovery.dispatchAcceptedCommitId,
    'interaction helper call checkpoint dispatch commit id',
  );
  assertNonEmptyString(
    checkpoint.recovery.returnedCommitId,
    'interaction helper call checkpoint returned commit id',
  );
  if (checkpoint.phase === 'returned') {
    if (checkpoint.recovery.ownerAcceptedCommitId !== undefined) {
      throw new JournalIntegrityError(
        'returned interaction helper call checkpoint cannot claim owner acceptance',
      );
    }
    return;
  }
  assertNonEmptyString(
    checkpoint.recovery.ownerAcceptedCommitId,
    'adopted interaction helper call checkpoint owner accepted commit id',
  );
}

function durableHandoffFact(record: JournalRecord): DurableHandoffFact | LegacyOwnerAcceptedFact | null {
  const payload = record.payload;
  if (payload?.kind !== HANDOFF_RECORD_TYPE) return null;
  if (!('fact' in payload)) {
    throw new JournalIntegrityError('interaction helper handoff payload is missing its fact');
  }
  const candidate = payload.fact;
  if (candidate === null || typeof candidate !== 'object' || !('kind' in candidate)) {
    throw new JournalIntegrityError('interaction helper handoff fact is invalid');
  }
  const kind = candidate.kind;
  if (kind === 'running') {
    throw new JournalIntegrityError('running interaction helper facts are not part of this durable foundation');
  }
  if (kind !== 'dispatch-accepted' && kind !== 'returned' && kind !== 'owner-accepted') {
    throw new JournalIntegrityError('interaction helper handoff fact kind is invalid');
  }
  if (kind === 'owner-accepted' && !('refinedResult' in candidate)) {
    const legacyCandidate = candidate as Omit<InteractionHelperOwnerAcceptedFact, 'refinedResult'>;
    validateInteractionHelperResult(legacyCandidate.result);
    assertOrganOnlyRecord(record, legacyCandidate.result.organId);
    return {
      kind: 'legacy-owner-accepted-missing-refined',
      fact: legacyCandidate,
      commit: commitRef(record),
    };
  }
  const fact = candidate as DurableHandoffFact;
  validateInteractionHelperHandoffFact(fact);
  assertOrganOnlyRecord(
    record,
    fact.kind === 'dispatch-accepted' ? fact.assignment.organId : fact.result.organId,
  );
  return fact;
}

function handoffCheckpointDescription(record: JournalRecord): string | null {
  // The fact envelope keeps the original host description as repair input for
  // the writer. It is not a checkpoint: the reader only uses it to reject a
  // persisted checkpoint whose description disagrees with the fact.
  const payload = record.payload;
  if (payload?.kind !== HANDOFF_RECORD_TYPE) return null;
  const description = payload.checkpointDescription;
  if (description === undefined) return null;
  assertNonEmptyString(description, 'interaction helper handoff checkpoint description');
  return description;
}

function callCheckpointFromRecord(record: JournalRecord): InteractionHelperCallCheckpoint | null {
  const payload = record.payload;
  if (payload?.kind !== CALL_CHECKPOINT_RECORD_TYPE) return null;
  if (!('checkpoint' in payload)) {
    throw new JournalIntegrityError('interaction helper call checkpoint payload is missing its checkpoint');
  }
  const checkpoint = payload.checkpoint as InteractionHelperCallCheckpoint;
  validateCallCheckpoint(checkpoint);
  assertOrganOnlyRecord(record, checkpoint.identity.organId);
  return checkpoint;
}

function semanticCheckpointFromRecord(record: JournalRecord): InteractionSemanticCheckpoint | null {
  const payload = record.payload;
  if (payload?.kind !== SEMANTIC_CHECKPOINT_RECORD_TYPE) return null;
  if (!('checkpoint' in payload)) {
    throw new JournalIntegrityError('interaction semantic checkpoint payload is missing its checkpoint');
  }
  const checkpoint = payload.checkpoint as InteractionSemanticCheckpoint;
  validateInteractionSemanticCheckpoint(checkpoint);
  assertOrganOnlyRecord(record, checkpoint.organId);
  return checkpoint;
}

function insertUnique<T>(
  map: Map<string, T>,
  identityKey: string,
  value: T,
  label: string,
): void {
  if (map.has(identityKey)) {
    throw new JournalIntegrityError(`duplicate ${label} identity in interaction helper journal`);
  }
  map.set(identityKey, value);
}

function assignmentForReturned(
  decoded: DecodedInteractionHelperJournal,
  result: InteractionHelperResult,
): InteractionHelperAssignment {
  const dispatch = decoded.dispatchAccepted.get(helperIdentityKey(result));
  if (dispatch === undefined) {
    throw new JournalIntegrityError('returned helper fact has no matching dispatch fact');
  }
  validateInteractionHelperResult(result, dispatch.fact.assignment);
  return dispatch.fact.assignment;
}

function assertOwnerAcceptanceMatchesReturned(
  decoded: DecodedInteractionHelperJournal,
  fact: InteractionHelperOwnerAcceptedFact,
): void {
  const returned = decoded.returned.get(helperIdentityKey(fact.result));
  if (returned === undefined) {
    throw new JournalIntegrityError('owner-accepted helper fact has no matching returned fact');
  }
  if (canonicalJsonStringify(returned.fact.result) !== canonicalJsonStringify(fact.result)) {
    throw new JournalIntegrityError('owner-accepted helper result does not match the returned result');
  }
}

function assertCallCheckpointMatchesFacts(
  decoded: DecodedInteractionHelperJournal,
  receipt: InteractionHelperCallCheckpointCommit,
): void {
  const { checkpoint } = receipt;
  const key = helperIdentityKey(checkpoint.identity);
  const dispatch = decoded.dispatchAccepted.get(key);
  const returned = decoded.returned.get(key);
  if (dispatch === undefined || returned === undefined) {
    throw new JournalIntegrityError('interaction helper call checkpoint has no matching returned fact');
  }
  if (checkpoint.recovery.dispatchAcceptedCommitId !== dispatch.commit.commitId) {
    throw new JournalIntegrityError('interaction helper call checkpoint dispatch commit does not match');
  }
  if (checkpoint.recovery.returnedCommitId !== returned.commit.commitId) {
    throw new JournalIntegrityError('interaction helper call checkpoint returned commit does not match');
  }
  if (checkpoint.phase === 'returned') {
    if (checkpoint.recordedAt !== returned.fact.returnedAt) {
      throw new JournalIntegrityError('returned interaction helper call checkpoint time does not match');
    }
    const description = decoded.returnedCheckpointDescriptions.get(key);
    if (description !== undefined && description !== checkpoint.description) {
      throw new JournalIntegrityError('returned interaction helper call checkpoint description does not match');
    }
    return;
  }

  const ownerAccepted = decoded.ownerAccepted.get(key);
  if (ownerAccepted === undefined) {
    throw new JournalIntegrityError('adopted interaction helper call checkpoint has no owner acceptance');
  }
  if (checkpoint.recovery.ownerAcceptedCommitId !== ownerAccepted.commit.commitId) {
    throw new JournalIntegrityError('adopted interaction helper call checkpoint acceptance commit does not match');
  }
  if (checkpoint.recordedAt !== ownerAccepted.fact.acceptedAt) {
    throw new JournalIntegrityError('adopted interaction helper call checkpoint time does not match');
  }
  const description = decoded.ownerAcceptedCheckpointDescriptions.get(key);
  if (description !== undefined && description !== checkpoint.description) {
    throw new JournalIntegrityError('adopted interaction helper call checkpoint description does not match');
  }
}

function resolveCallCheckpoint(
  decoded: DecodedInteractionHelperJournal,
  identity: InteractionHelperIdentity,
  phase: InteractionHelperCallCheckpointPhase,
): InteractionHelperCallCheckpointCommit | null {
  // Only a physically committed CALL_CHECKPOINT_RECORD_TYPE record is a
  // checkpoint. A durable handoff fact without that record stays a partial
  // write: the reader reports null and the writer owns the repair.
  return decoded.callCheckpoints.get(callCheckpointKey(identity, phase)) ?? null;
}

function decodeJournal(records: readonly JournalRecord[]): DecodedInteractionHelperJournal {
  const dispatchAccepted = new Map<
    string,
    InteractionHelperCommittedFact<InteractionHelperDispatchAcceptedFact>
  >();
  const returned = new Map<
    string,
    InteractionHelperCommittedFact<InteractionHelperReturnedFact>
  >();
  const ownerAccepted = new Map<
    string,
    InteractionHelperCommittedFact<InteractionHelperOwnerAcceptedFact>
  >();
  const callCheckpoints = new Map<string, InteractionHelperCallCheckpointCommit>();
  const returnedCheckpointDescriptions = new Map<string, string>();
  const ownerAcceptedCheckpointDescriptions = new Map<string, string>();
  const semanticCheckpoints = new Map<string, InteractionSemanticCheckpointCommit>();
  const legacyOwnerAcceptedMissingRefined = new Map<string, LegacyOwnerAcceptedFact>();

  for (const record of records) {
    const handoff = durableHandoffFact(record);
    if (handoff !== null && handoff.kind === 'legacy-owner-accepted-missing-refined') {
      insertUnique(
        legacyOwnerAcceptedMissingRefined,
        helperIdentityKey(handoff.fact.result),
        handoff,
        'owner-accepted',
      );
      continue;
    }
    if (handoff?.kind === 'dispatch-accepted') {
      insertUnique(
        dispatchAccepted,
        helperIdentityKey(handoff.assignment),
        { fact: handoff, commit: commitRef(record) },
        'dispatch-accepted',
      );
      continue;
    }
    if (handoff?.kind === 'returned') {
      const identityKey = helperIdentityKey(handoff.result);
      insertUnique(
        returned,
        identityKey,
        { fact: handoff, commit: commitRef(record) },
        'returned',
      );
      const description = handoffCheckpointDescription(record);
      if (description !== null) {
        insertUnique(
          returnedCheckpointDescriptions,
          identityKey,
          description,
          'returned-checkpoint-description',
        );
      }
      continue;
    }
    if (handoff?.kind === 'owner-accepted') {
      const identityKey = helperIdentityKey(handoff.result);
      insertUnique(
        ownerAccepted,
        identityKey,
        { fact: handoff, commit: commitRef(record) },
        'owner-accepted',
      );
      const description = handoffCheckpointDescription(record);
      if (description !== null) {
        insertUnique(
          ownerAcceptedCheckpointDescriptions,
          identityKey,
          description,
          'owner-accepted-checkpoint-description',
        );
      }
      continue;
    }

    const checkpoint = semanticCheckpointFromRecord(record);
    if (checkpoint !== null) {
      insertUnique(
        semanticCheckpoints,
        turnIdentityKey(checkpoint),
        { checkpoint, commit: commitRef(record) },
        'semantic-checkpoint',
      );
      continue;
    }

    const callCheckpoint = callCheckpointFromRecord(record);
    if (callCheckpoint !== null) {
      insertUnique(
        callCheckpoints,
        callCheckpointKey(callCheckpoint.identity, callCheckpoint.phase),
        { checkpoint: callCheckpoint, commit: commitRef(record) },
        'call-checkpoint',
      );
    }
  }

  const decoded = {
    dispatchAccepted,
    returned,
    ownerAccepted,
    callCheckpoints,
    returnedCheckpointDescriptions,
    ownerAcceptedCheckpointDescriptions,
    semanticCheckpoints,
    legacyOwnerAcceptedMissingRefined,
  };
  for (const returnedFact of returned.values()) {
    assignmentForReturned(decoded, returnedFact.fact.result);
  }
  for (const acceptedFact of ownerAccepted.values()) {
    assertOwnerAcceptanceMatchesReturned(decoded, acceptedFact.fact);
  }
  for (const checkpoint of callCheckpoints.values()) {
    assertCallCheckpointMatchesFacts(decoded, checkpoint);
  }
  return decoded;
}

function committedDispatch(
  record: JournalRecord,
): InteractionHelperCommittedFact<InteractionHelperDispatchAcceptedFact> {
  const fact = durableHandoffFact(record);
  if (fact === null || fact.kind !== 'dispatch-accepted') {
    throw new JournalIntegrityError('dispatch append did not produce a dispatch-accepted fact');
  }
  return { fact, commit: commitRef(record) };
}

function committedReturned(
  record: JournalRecord,
): InteractionHelperCommittedFact<InteractionHelperReturnedFact> {
  const fact = durableHandoffFact(record);
  if (fact === null || fact.kind !== 'returned') {
    throw new JournalIntegrityError('return append did not produce a returned fact');
  }
  return { fact, commit: commitRef(record) };
}

function committedOwnerAccepted(
  record: JournalRecord,
): InteractionHelperCommittedFact<InteractionHelperOwnerAcceptedFact> {
  const fact = durableHandoffFact(record);
  if (fact === null || fact.kind !== 'owner-accepted') {
    throw new JournalIntegrityError('accept append did not produce an owner-accepted fact');
  }
  return { fact, commit: commitRef(record) };
}

function committedSemanticCheckpoint(record: JournalRecord): InteractionSemanticCheckpointCommit {
  const checkpoint = semanticCheckpointFromRecord(record);
  if (checkpoint === null) {
    throw new JournalIntegrityError('semantic checkpoint append did not produce a checkpoint');
  }
  return { checkpoint, commit: commitRef(record) };
}

function committedCallCheckpoint(record: JournalRecord): InteractionHelperCallCheckpointCommit {
  const checkpoint = callCheckpointFromRecord(record);
  if (checkpoint === null) {
    throw new JournalIntegrityError('call checkpoint append did not produce a checkpoint');
  }
  return { checkpoint, commit: commitRef(record) };
}

/**
 * Typed append/exact-read codec over the existing authoritative Organ Journal.
 * The injected Journal remains the only store and transaction owner.
 */
export class JsonlInteractionHelperJournal implements InteractionHelperTurnReadPort {
  constructor(private readonly journal: JsonlOrganJournal) {}

  async appendDispatchAccepted(
    fact: InteractionHelperDispatchAcceptedFact,
  ): Promise<InteractionHelperCommittedFact<InteractionHelperDispatchAcceptedFact>> {
    validateInteractionHelperHandoffFact(fact);
    const record = await this.journal.append({
      commitId: commitId('dispatch-accepted', helperIdentityKey(fact.assignment)),
      kind: 'event',
      scope: organScope(fact.assignment.organId),
      payload: { kind: HANDOFF_RECORD_TYPE, fact },
    });
    return committedDispatch(record);
  }

  async appendReturned(
    fact: InteractionHelperReturnedFact,
    input: { readonly description: string },
  ): Promise<InteractionHelperReturnedCommit> {
    validateInteractionHelperHandoffFact(fact);
    assertNonEmptyString(input.description, 'returned interaction helper call checkpoint description');
    const identity = helperIdentityOf(fact.result);
    const identityKey = helperIdentityKey(identity);
    return this.journal.transaction(
      ({ records }) => {
        const decoded = decodeJournal(records);
        assignmentForReturned(decoded, fact.result);
        const dispatch = decoded.dispatchAccepted.get(identityKey);
        if (dispatch === undefined) {
          throw new JournalIntegrityError('returned helper fact has no matching dispatch commit');
        }
        return {
          scope: organScope(fact.result.organId),
          dispatchAcceptedCommitId: dispatch.commit.commitId,
        };
      },
      async ({ scope, dispatchAcceptedCommitId }, append) => {
        const factRecord = await append({
          commitId: commitId('returned', identityKey),
          kind: 'event',
          scope,
          payload: {
            kind: HANDOFF_RECORD_TYPE,
            fact,
            checkpointDescription: input.description,
          },
        });
        const returned = committedReturned(factRecord);
        const checkpoint: InteractionHelperCallCheckpoint = {
          identity,
          phase: 'returned',
          recordedAt: fact.returnedAt,
          description: input.description,
          recovery: {
            dispatchAcceptedCommitId,
            returnedCommitId: returned.commit.commitId,
          },
        };
        const checkpointRecord = await append({
          commitId: callCheckpointCommitId('returned', identityKey),
          kind: 'event',
          scope,
          payload: { kind: CALL_CHECKPOINT_RECORD_TYPE, checkpoint },
        });
        return {
          ...returned,
          checkpointCommit: committedCallCheckpoint(checkpointRecord),
        };
      },
    );
  }

  async appendOwnerAccepted(
    fact: InteractionHelperOwnerAcceptedFact,
    input: { readonly description: string },
  ): Promise<InteractionHelperOwnerAcceptedCommit> {
    validateInteractionHelperHandoffFact(fact);
    assertNonEmptyString(input.description, 'adopted interaction helper call checkpoint description');
    const identity = helperIdentityOf(fact.result);
    const identityKey = helperIdentityKey(identity);
    return this.journal.transaction(
      ({ records }) => {
        const decoded = decodeJournal(records);
        assertOwnerAcceptanceMatchesReturned(decoded, fact);
        const dispatch = decoded.dispatchAccepted.get(identityKey);
        const returned = decoded.returned.get(identityKey);
        if (dispatch === undefined || returned === undefined) {
          throw new JournalIntegrityError('owner-accepted helper fact has no durable dispatch and return');
        }
        return {
          scope: organScope(fact.result.organId),
          dispatchAcceptedCommitId: dispatch.commit.commitId,
          returnedCommitId: returned.commit.commitId,
        };
      },
      async ({ scope, dispatchAcceptedCommitId, returnedCommitId }, append) => {
        const factRecord = await append({
          commitId: commitId('owner-accepted', identityKey),
          kind: 'event',
          scope,
          payload: {
            kind: HANDOFF_RECORD_TYPE,
            fact,
            checkpointDescription: input.description,
          },
        });
        const accepted = committedOwnerAccepted(factRecord);
        const checkpoint: InteractionHelperCallCheckpoint = {
          identity,
          phase: 'adopted',
          recordedAt: fact.acceptedAt,
          description: input.description,
          recovery: {
            dispatchAcceptedCommitId,
            returnedCommitId,
            ownerAcceptedCommitId: accepted.commit.commitId,
          },
        };
        const checkpointRecord = await append({
          commitId: callCheckpointCommitId('adopted', identityKey),
          kind: 'event',
          scope,
          payload: { kind: CALL_CHECKPOINT_RECORD_TYPE, checkpoint },
        });
        return {
          ...accepted,
          checkpointCommit: committedCallCheckpoint(checkpointRecord),
        };
      },
    );
  }

  async appendSemanticCheckpoint(
    checkpoint: InteractionSemanticCheckpoint,
  ): Promise<InteractionSemanticCheckpointCommit> {
    validateInteractionSemanticCheckpoint(checkpoint);
    const record = await this.journal.append({
      commitId: semanticCheckpointCommitId(turnIdentityKey(checkpoint)),
      kind: 'event',
      scope: organScope(checkpoint.organId),
      payload: { kind: SEMANTIC_CHECKPOINT_RECORD_TYPE, checkpoint },
    });
    return committedSemanticCheckpoint(record);
  }

  async readExact(identity: InteractionHelperIdentity): Promise<InteractionHelperJournalReadback> {
    validateInteractionHelperIdentity(identity);
    const decoded = decodeJournal(await this.journal.replay());
    const key = helperIdentityKey(identity);
    if (decoded.legacyOwnerAcceptedMissingRefined.has(key)) {
      throw new JournalIntegrityError('owner-accepted helper fact is missing refinedResult');
    }
    return {
      dispatchAccepted: decoded.dispatchAccepted.get(key) ?? null,
      returned: decoded.returned.get(key) ?? null,
      ownerAccepted: decoded.ownerAccepted.get(key) ?? null,
      returnedCheckpoint: resolveCallCheckpoint(decoded, identity, 'returned'),
      adoptedCheckpoint: resolveCallCheckpoint(decoded, identity, 'adopted'),
    };
  }

  async readCallCheckpointExact(
    identity: InteractionHelperIdentity,
    phase: InteractionHelperCallCheckpointPhase,
  ): Promise<InteractionHelperCallCheckpointCommit | null> {
    validateInteractionHelperIdentity(identity);
    if (phase !== 'returned' && phase !== 'adopted') {
      throw new JournalIntegrityError('interaction helper call checkpoint phase is invalid');
    }
    return resolveCallCheckpoint(decodeJournal(await this.journal.replay()), identity, phase);
  }

  async readTurnHelpers(
    turn: InteractionTurnIdentity,
  ): Promise<readonly InteractionHelperTurnReadbackEntry[]> {
    validateInteractionTurnIdentity(turn);
    const decoded = decodeJournal(await this.journal.replay());
    for (const legacy of decoded.legacyOwnerAcceptedMissingRefined.values()) {
      const helper = legacy.fact.result;
      if (
        sameOrganId(helper.organId, turn.organId)
        && helper.interactionScopeId === turn.interactionScopeId
        && helper.interactionId === turn.interactionId
        && helper.inputRevision === turn.inputRevision
        && helper.parentTurnId === turn.turnId
      ) {
        throw new JournalIntegrityError('owner-accepted helper fact is missing refinedResult');
      }
    }
    const entries: InteractionHelperTurnReadbackEntry[] = [];
    // decodeJournal already requires every returned to carry a matching dispatch fact and every
    // owner acceptance a matching returned fact, so the dispatch-accepted collection is the
    // authoritative identity and ordering set for a turn.
    for (const [key, dispatch] of decoded.dispatchAccepted) {
      const assignment = dispatch.fact.assignment;
      if (
        sameOrganId(assignment.organId, turn.organId)
        && assignment.interactionScopeId === turn.interactionScopeId
        && assignment.interactionId === turn.interactionId
        && assignment.inputRevision === turn.inputRevision
        && assignment.parentTurnId === turn.turnId
      ) {
        const identity: InteractionHelperIdentity = {
          organId: assignment.organId,
          interactionScopeId: assignment.interactionScopeId,
          interactionId: assignment.interactionId,
          inputRevision: assignment.inputRevision,
          parentTurnId: assignment.parentTurnId,
          assignmentId: assignment.assignmentId,
          helperCallId: assignment.helperCallId,
          attempt: assignment.attempt,
        };
        entries.push({
          identity,
          readback: {
            dispatchAccepted: dispatch,
            returned: decoded.returned.get(key) ?? null,
            ownerAccepted: decoded.ownerAccepted.get(key) ?? null,
            returnedCheckpoint: resolveCallCheckpoint(decoded, identity, 'returned'),
            adoptedCheckpoint: resolveCallCheckpoint(decoded, identity, 'adopted'),
          },
        });
      }
    }

    entries.sort((left, right) => {
      const leftSeq = left.readback.dispatchAccepted?.commit.journalSeq
        ?? left.readback.returned?.commit.journalSeq
        ?? left.readback.ownerAccepted?.commit.journalSeq
        ?? Number.MAX_SAFE_INTEGER;
      const rightSeq = right.readback.dispatchAccepted?.commit.journalSeq
        ?? right.readback.returned?.commit.journalSeq
        ?? right.readback.ownerAccepted?.commit.journalSeq
        ?? Number.MAX_SAFE_INTEGER;
      if (leftSeq !== rightSeq) {
        return leftSeq - rightSeq;
      }
      return helperIdentityKey(left.identity).localeCompare(helperIdentityKey(right.identity));
    });

    return entries;
  }

  async readSemanticCheckpointExact(
    identity: InteractionTurnIdentity,
  ): Promise<InteractionSemanticCheckpointCommit | null> {
    validateInteractionTurnIdentity(identity);
    const decoded = decodeJournal(await this.journal.replay());
    return decoded.semanticCheckpoints.get(turnIdentityKey(identity)) ?? null;
  }

  async readScopeSemanticCheckpoints(scope: {
    readonly organId: OrganId;
    readonly interactionScopeId: string;
  }): Promise<readonly InteractionSemanticCheckpointCommit[]> {
    if (scope.organId === null || typeof scope.organId !== 'object'
      || scope.organId.scope !== 'organ' || !scope.organId.value.trim()) {
      throw new JournalIntegrityError('interaction semantic checkpoint scope requires a valid organ id');
    }
    if (typeof scope.interactionScopeId !== 'string' || scope.interactionScopeId.trim() === '') {
      throw new JournalIntegrityError('interaction semantic checkpoint scope requires an interactionScopeId');
    }
    const decoded = decodeJournal(await this.journal.replay());
    return [...decoded.semanticCheckpoints.values()]
      .filter((entry) => sameOrganId(entry.checkpoint.organId, scope.organId)
        && entry.checkpoint.interactionScopeId === scope.interactionScopeId)
      .sort((left, right) => left.commit.journalSeq - right.commit.journalSeq);
  }
}
