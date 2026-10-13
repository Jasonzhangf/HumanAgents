import type {
  AdmittedTurnIdentity,
  CheckpointReceiptRelationshipV1,
} from '../../../contracts/src/index.js';
import {
  assertTurnCheckpointRelationshipV1,
  validateAcceptedSemanticViewInputV1,
  validateSemanticHistoryExactLookupV1,
  validateSemanticPhaseReceiptV1,
  type AcceptedSemanticViewInputV1,
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

export async function readCommittedSemanticCheckpointV1(input: {
  readonly port: SemanticHistoryPersistencePort;
  readonly lookup: SemanticHistoryExactLookupV1;
}): Promise<CommittedSemanticCheckpointV1 | null> {
  validateSemanticHistoryExactLookupV1(input.lookup);
  return await input.port.readCommittedSemanticCheckpoint(input.lookup);
}
