import type {
  AdmittedTurnIdentity,
  CheckpointReceiptRelationshipV1,
} from '../../../contracts/src/index.js';
import type { NativeSegmentSaveSourceV2 } from '../../../contracts/src/active-turn-segments.js';
import {
  assertSegmentCheckpointRelationshipV2,
  assertSegmentOriginalTurnIdentityV2,
  assertTurnCheckpointRelationshipV1,
  SemanticHistoryError,
  validateAcceptedSemanticViewInputV2,
  validateAcceptedSemanticViewInputV1,
  validateSemanticHistoryExactLookupV1,
  validateSemanticPhaseReceiptV1,
  type AcceptedSemanticViewInput,
  type AcceptedSemanticViewInputV1,
  type AcceptedSemanticViewInputV2,
  type CommittedSemanticCheckpoint,
  type CommittedSemanticCheckpointV1,
  type SemanticContextViewIdentityV1,
  type SemanticHistoryExactLookupV1,
  type SemanticPhaseReceiptV1,
} from '../context/semantic-history.js';
import type {
  SemanticHistoryPersistencePort,
} from './ports.js';

/**
 * Runtime-owned gate for the two semantic-history phases. This module validates
 * the accepted-view input and the phase relationship, then delegates physical
 * persistence and actual-receipt reconstruction to the App port. It does not
 * orchestrate the five-phase boundary save and it never fabricates a receipt.
 */

export async function commitSemanticContextViewV1(input: {
  readonly port: SemanticHistoryPersistencePort;
  readonly accepted: AcceptedSemanticViewInputV1;
}): Promise<SemanticPhaseReceiptV1> {
  await validateAcceptedSemanticViewInputV1(input.accepted);
  return await input.port.commitContextView({
    ownerId: input.accepted.acceptance.ownerId,
    accepted: input.accepted,
  });
}

export async function commitSemanticContextViewV2(input: {
  readonly port: SemanticHistoryPersistencePort;
  readonly accepted: AcceptedSemanticViewInputV2;
}): Promise<SemanticPhaseReceiptV1> {
  await validateAcceptedSemanticViewInputV2(input.accepted);
  if (!input.port.commitContextViewV2) {
    throw new SemanticHistoryError(
      'semantic-history.port.v2-unavailable',
      'semantic history persistence port does not implement v2 context-view commit',
    );
  }
  return await input.port.commitContextViewV2({
    ownerId: input.accepted.acceptance.ownerId,
    accepted: input.accepted,
  });
}

export async function commitSemanticContextView(input: {
  readonly port: SemanticHistoryPersistencePort;
  readonly accepted: AcceptedSemanticViewInput;
}): Promise<SemanticPhaseReceiptV1> {
  if (input.accepted.version === 1) {
    return await commitSemanticContextViewV1({ port: input.port, accepted: input.accepted });
  }
  if (input.accepted.version === 2) {
    return await commitSemanticContextViewV2({ port: input.port, accepted: input.accepted });
  }
  throw new SemanticHistoryError('semantic-history.input.version', 'accepted semantic view input version must be 1 or 2');
}

export async function commitSemanticHistoryPublicationV1(input: {
  readonly port: SemanticHistoryPersistencePort;
  readonly ownerId: string;
  readonly turn: AdmittedTurnIdentity;
  readonly checkpoint: CheckpointReceiptRelationshipV1;
  readonly contextView: {
    readonly identity: SemanticContextViewIdentityV1;
    readonly receipt: SemanticPhaseReceiptV1;
  };
}): Promise<SemanticPhaseReceiptV1> {
  await assertTurnCheckpointRelationshipV1(input.turn, input.checkpoint);
  await validateSemanticPhaseReceiptV1(input.contextView.receipt, {
    phase: 'context-view',
    identity: input.contextView.identity,
    scope: input.checkpoint.checkpoint.scope,
  });
  return await input.port.commitHistoryPublication({
    ownerId: input.ownerId,
    turn: input.turn,
    checkpoint: input.checkpoint,
    contextView: input.contextView,
  });
}

export async function commitSemanticHistoryPublicationV2(input: {
  readonly port: SemanticHistoryPersistencePort;
  readonly ownerId: string;
  readonly turn: AdmittedTurnIdentity;
  readonly segment: NativeSegmentSaveSourceV2;
  readonly checkpoint: CheckpointReceiptRelationshipV1;
  readonly contextView: {
    readonly identity: SemanticContextViewIdentityV1;
    readonly receipt: SemanticPhaseReceiptV1;
  };
}): Promise<SemanticPhaseReceiptV1> {
  assertSegmentOriginalTurnIdentityV2(input.segment, input.turn);
  await assertSegmentCheckpointRelationshipV2(input.segment, input.checkpoint);
  await validateSemanticPhaseReceiptV1(input.contextView.receipt, {
    phase: 'context-view',
    identity: input.contextView.identity,
    scope: input.checkpoint.checkpoint.scope,
  });
  if (!input.port.commitHistoryPublicationV2) {
    throw new SemanticHistoryError(
      'semantic-history.port.v2-unavailable',
      'semantic history persistence port does not implement v2 history-publication commit',
    );
  }
  return await input.port.commitHistoryPublicationV2({
    ownerId: input.ownerId,
    turn: input.turn,
    segment: input.segment,
    checkpoint: input.checkpoint,
    contextView: input.contextView,
  });
}

export type SemanticHistoryPublicationCommitInput =
  | {
      readonly version: 1;
      readonly port: SemanticHistoryPersistencePort;
      readonly ownerId: string;
      readonly turn: AdmittedTurnIdentity;
      readonly checkpoint: CheckpointReceiptRelationshipV1;
      readonly contextView: {
        readonly identity: SemanticContextViewIdentityV1;
        readonly receipt: SemanticPhaseReceiptV1;
      };
    }
  | {
      readonly version: 2;
      readonly port: SemanticHistoryPersistencePort;
      readonly ownerId: string;
      readonly turn: AdmittedTurnIdentity;
      readonly segment: NativeSegmentSaveSourceV2;
      readonly checkpoint: CheckpointReceiptRelationshipV1;
      readonly contextView: {
        readonly identity: SemanticContextViewIdentityV1;
        readonly receipt: SemanticPhaseReceiptV1;
      };
    };

export async function commitSemanticHistoryPublication(
  input: SemanticHistoryPublicationCommitInput,
): Promise<SemanticPhaseReceiptV1> {
  if (input.version === 1) {
    return await commitSemanticHistoryPublicationV1({
      port: input.port,
      ownerId: input.ownerId,
      turn: input.turn,
      checkpoint: input.checkpoint,
      contextView: input.contextView,
    });
  }
  if (input.version === 2) {
    return await commitSemanticHistoryPublicationV2({
      port: input.port,
      ownerId: input.ownerId,
      turn: input.turn,
      segment: input.segment,
      checkpoint: input.checkpoint,
      contextView: input.contextView,
    });
  }
  throw new SemanticHistoryError('semantic-history.input.version', 'history publication commit version must be 1 or 2');
}

export async function readCommittedSemanticCheckpointV1(input: {
  readonly port: SemanticHistoryPersistencePort;
  readonly lookup: SemanticHistoryExactLookupV1;
}): Promise<CommittedSemanticCheckpointV1 | null> {
  validateSemanticHistoryExactLookupV1(input.lookup);
  const checkpoint = await input.port.readCommittedSemanticCheckpoint(input.lookup);
  if (checkpoint && checkpoint.version !== 1) {
    throw new SemanticHistoryError(
      'semantic-history.lookup.version',
      'v1 exact lookup returned a version 2 committed semantic checkpoint',
    );
  }
  return checkpoint;
}

export async function readCommittedSemanticCheckpoint(input: {
  readonly port: SemanticHistoryPersistencePort;
  readonly lookup: SemanticHistoryExactLookupV1;
}): Promise<CommittedSemanticCheckpoint | null> {
  validateSemanticHistoryExactLookupV1(input.lookup);
  return await input.port.readCommittedSemanticCheckpoint(input.lookup);
}
