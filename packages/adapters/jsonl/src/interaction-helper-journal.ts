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
import {
  JournalIntegrityError,
  type JournalRecord,
  type JsonlOrganJournal,
} from './index.js';

const HANDOFF_RECORD_TYPE = 'interaction-helper.handoff.v1';
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
}

export interface InteractionSemanticCheckpointCommit {
  readonly checkpoint: InteractionSemanticCheckpoint;
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
  readonly semanticCheckpoints: ReadonlyMap<string, InteractionSemanticCheckpointCommit>;
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

function durableHandoffFact(record: JournalRecord): DurableHandoffFact | null {
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
  const fact = candidate as DurableHandoffFact;
  validateInteractionHelperHandoffFact(fact);
  assertOrganOnlyRecord(
    record,
    fact.kind === 'dispatch-accepted' ? fact.assignment.organId : fact.result.organId,
  );
  return fact;
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
  const semanticCheckpoints = new Map<string, InteractionSemanticCheckpointCommit>();

  for (const record of records) {
    const handoff = durableHandoffFact(record);
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
      insertUnique(
        returned,
        helperIdentityKey(handoff.result),
        { fact: handoff, commit: commitRef(record) },
        'returned',
      );
      continue;
    }
    if (handoff?.kind === 'owner-accepted') {
      insertUnique(
        ownerAccepted,
        helperIdentityKey(handoff.result),
        { fact: handoff, commit: commitRef(record) },
        'owner-accepted',
      );
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
    }
  }

  const decoded = { dispatchAccepted, returned, ownerAccepted, semanticCheckpoints };
  for (const returnedFact of returned.values()) {
    assignmentForReturned(decoded, returnedFact.fact.result);
  }
  for (const acceptedFact of ownerAccepted.values()) {
    assertOwnerAcceptanceMatchesReturned(decoded, acceptedFact.fact);
  }
  return decoded;
}

function committedDispatch(
  record: JournalRecord,
): InteractionHelperCommittedFact<InteractionHelperDispatchAcceptedFact> {
  const fact = durableHandoffFact(record);
  if (fact?.kind !== 'dispatch-accepted') {
    throw new JournalIntegrityError('dispatch append did not produce a dispatch-accepted fact');
  }
  return { fact, commit: commitRef(record) };
}

function committedReturned(
  record: JournalRecord,
): InteractionHelperCommittedFact<InteractionHelperReturnedFact> {
  const fact = durableHandoffFact(record);
  if (fact?.kind !== 'returned') {
    throw new JournalIntegrityError('return append did not produce a returned fact');
  }
  return { fact, commit: commitRef(record) };
}

function committedOwnerAccepted(
  record: JournalRecord,
): InteractionHelperCommittedFact<InteractionHelperOwnerAcceptedFact> {
  const fact = durableHandoffFact(record);
  if (fact?.kind !== 'owner-accepted') {
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

/**
 * Typed append/exact-read codec over the existing authoritative Organ Journal.
 * The injected Journal remains the only store and transaction owner.
 */
export class JsonlInteractionHelperJournal {
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
  ): Promise<InteractionHelperCommittedFact<InteractionHelperReturnedFact>> {
    validateInteractionHelperHandoffFact(fact);
    const record = await this.journal.transaction(
      ({ records }) => {
        const decoded = decodeJournal(records);
        assignmentForReturned(decoded, fact.result);
        return organScope(fact.result.organId);
      },
      async (scope, append) => await append({
        commitId: commitId('returned', helperIdentityKey(fact.result)),
        kind: 'event',
        scope,
        payload: { kind: HANDOFF_RECORD_TYPE, fact },
      }),
    );
    return committedReturned(record);
  }

  async appendOwnerAccepted(
    fact: InteractionHelperOwnerAcceptedFact,
  ): Promise<InteractionHelperCommittedFact<InteractionHelperOwnerAcceptedFact>> {
    validateInteractionHelperHandoffFact(fact);
    const record = await this.journal.transaction(
      ({ records }) => {
        const decoded = decodeJournal(records);
        assertOwnerAcceptanceMatchesReturned(decoded, fact);
        return organScope(fact.result.organId);
      },
      async (scope, append) => await append({
        commitId: commitId('owner-accepted', helperIdentityKey(fact.result)),
        kind: 'event',
        scope,
        payload: { kind: HANDOFF_RECORD_TYPE, fact },
      }),
    );
    return committedOwnerAccepted(record);
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
    return {
      dispatchAccepted: decoded.dispatchAccepted.get(key) ?? null,
      returned: decoded.returned.get(key) ?? null,
      ownerAccepted: decoded.ownerAccepted.get(key) ?? null,
    };
  }

  async readSemanticCheckpointExact(
    identity: InteractionTurnIdentity,
  ): Promise<InteractionSemanticCheckpointCommit | null> {
    validateInteractionTurnIdentity(identity);
    const decoded = decodeJournal(await this.journal.replay());
    return decoded.semanticCheckpoints.get(turnIdentityKey(identity)) ?? null;
  }
}
