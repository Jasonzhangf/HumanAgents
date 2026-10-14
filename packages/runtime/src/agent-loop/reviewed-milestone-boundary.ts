import {
  assertSameScope,
  validateAdmittedTurnIdentity,
  validateJournalCommitRef,
  type AdmittedTurnIdentity,
  type Checkpoint,
  type I2JournalPort,
  type JournalCommitRef,
  type MilestoneReviewAlignedRecord,
  type RecoveryAssetsReadback,
} from '../../../contracts/src/index.js';
import {
  assertMilestoneReviewResultRecord,
  assertSameAdmittedTurn,
  assertTurnAlignmentBinding,
} from '../../../core/src/index.js';
import {
  assertPlannerAlignmentRecord,
  assertTurnClosureRecord,
  assertTurnRecoveryRecord,
  distinctReviewCommitRefs,
  readCheckpointClosurePreparation,
  sameEvidenceRef,
  sameReviewCommitRefs,
  turnBoundaryRecordRefs,
} from '../checkpoints/closure.js';
import type { CheckpointClosurePort, CheckpointJournalPort, ContextHistoryPort } from '../checkpoints/ports.js';
import { readCommittedContextHistory } from '../checkpoints/coordinator.js';
import { projectAdmittedTurnIdentityV1 } from '../context/semantic-history.js';
import type { TaskPlanRevisionConsumerPort } from '../orchestration/task-plan-revisions.js';
import { assertReviewResultMatchesAssignment } from '../review/index.js';
import { AgentLoopRuntimeError } from './errors.js';
import { validateNativeSegmentSaveSourceV2, type NativeSegmentSaveSourceV2,
  type PreparedActiveTurnSegmentCaptureV2 } from '../../../contracts/src/active-turn-segments.js';
import type { ActiveTurnSegmentRecoveryAssetsReceipt } from '../context/active-turn-journal.js';

export type ReviewedBoundaryRecoveryAssets =
  | { readonly version: 1; readonly assets: RecoveryAssetsReadback }
  | { readonly version: 2; readonly assets: { readonly receipt: ActiveTurnSegmentRecoveryAssetsReceipt;
      readonly prepared: PreparedActiveTurnSegmentCaptureV2 }; readonly source: NativeSegmentSaveSourceV2 };

export interface ReviewedBoundaryRecoveryAssetsPort {
  readRecoveryAssetsExact(receiptRef: string): Promise<RecoveryAssetsReadback>;
  readBoundaryRecoveryAssetsExact?(receiptRef: string): Promise<ReviewedBoundaryRecoveryAssets>;
}

export interface ReadReviewedMilestoneBoundaryInput {
  readonly identity: AdmittedTurnIdentity;
  readonly reviewCommitRefs: readonly JournalCommitRef[];
  readonly checkpointId: Checkpoint['id'];
  /** Typed turn-closure record ID, distinct from its underlying checkpoint closureRef. */
  readonly turnClosureRef: string;
  readonly alignmentRef: string;
  readonly journal: I2JournalPort;
  readonly checkpoints: CheckpointJournalPort;
  readonly closures: CheckpointClosurePort;
  readonly contexts: ContextHistoryPort;
  readonly plans: TaskPlanRevisionConsumerPort;
  readonly nativeRecoveryAssets: ReviewedBoundaryRecoveryAssetsPort;
}

function requireMatch(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AgentLoopRuntimeError('conflict', message);
}

/** Resolve one physical boundary and every accepted review. No publication or partial result. */
export async function readReviewedMilestoneBoundary(
  input: ReadReviewedMilestoneBoundaryInput,
): Promise<readonly MilestoneReviewAlignedRecord[]> {
  validateAdmittedTurnIdentity(input.identity);
  const refs = distinctReviewCommitRefs(input.reviewCommitRefs);
  requireMatch(refs.length === input.reviewCommitRefs.length, 'requested review receipt list must be distinct');
  const scope = input.identity.scopeRef;
  const closure = await input.closures.read(input.turnClosureRef);
  requireMatch(!!closure && 'closureKind' in closure && closure.closureKind === 'turn-closure', 'typed turn closure is absent');
  assertTurnClosureRecord(closure);
  requireMatch(closure.closureId === input.turnClosureRef, 'typed turn closure ID does not match');
  assertSameAdmittedTurn(input.identity, closure.identity);
  const keys = turnBoundaryRecordRefs(closure.identity, closure.checkpointId);
  requireMatch(input.turnClosureRef === keys.turnClosureRef && input.alignmentRef === keys.alignmentRef
    && closure.checkpointId.scope === input.checkpointId.scope && closure.checkpointId.value === input.checkpointId.value,
  'typed boundary references do not match the canonical admitted checkpoint');
  requireMatch(sameReviewCommitRefs(closure.reviewCommitRefs, refs), 'turn closure binds a different ordered review receipt list');
  if (refs.length === 0) return [];

  const committed = await input.checkpoints.readCommitted(scope, input.checkpointId);
  requireMatch(!!committed, 'reviewed checkpoint is absent');
  const checkpoint = committed.checkpoint;
  validateJournalCommitRef(committed.commitRef);
  assertSameScope(scope, checkpoint.scope);
  requireMatch(checkpoint.id.scope === input.checkpointId.scope && checkpoint.id.value === input.checkpointId.value
    && closure.checkpointId.scope === checkpoint.id.scope && closure.checkpointId.value === checkpoint.id.value
    && checkpoint.cycleId.value === input.identity.cycleRef?.value
    && checkpoint.directiveRevision === input.identity.directiveRevision
    && sameEvidenceRef(checkpoint.recoveryStateRef, closure.recoveryStateRef), 'checkpoint does not match the admitted closure');

  const binding = await input.checkpoints.readCheckpointRecoveryBinding(scope, committed.commitRef);
  requireMatch(!!binding, 'checkpoint recovery binding is absent');
  requireMatch(sameReviewCommitRefs([binding.checkpointCommitRef], [committed.commitRef])
    && binding.coreClosure.checkpointId.value === checkpoint.id.value
    && binding.coreClosure.executionEpoch === checkpoint.executionEpoch
    && binding.coreClosure.committed
    && sameEvidenceRef(binding.coreClosure.recoveryStateRef, checkpoint.recoveryStateRef), 'checkpoint recovery binding conflicts');
  requireMatch(!!binding.turnRecoveryRef, 'checkpoint binding has no turn recovery reference');
  requireMatch((binding.turnClosureRef === undefined || binding.turnClosureRef === input.turnClosureRef)
    && (binding.alignmentRef === undefined || binding.alignmentRef === input.alignmentRef), 'checkpoint typed boundary references conflict');
  const recovery = await input.closures.read(keys.turnRecoveryRecordRef);
  requireMatch(!!recovery && 'closureKind' in recovery && recovery.closureKind === 'turn-recovery', 'typed turn recovery is absent');
  assertTurnRecoveryRecord(recovery);
  assertSameAdmittedTurn(input.identity, recovery.identity);
  requireMatch(recovery.closureId === keys.turnRecoveryRecordRef && recovery.checkpointId.scope === checkpoint.id.scope
    && recovery.checkpointId.value === checkpoint.id.value
    && sameEvidenceRef(recovery.recoveryStateRef, closure.recoveryStateRef), 'typed turn recovery conflicts');
  const readback: ReviewedBoundaryRecoveryAssets = input.nativeRecoveryAssets.readBoundaryRecoveryAssetsExact
    ? await input.nativeRecoveryAssets.readBoundaryRecoveryAssetsExact(binding.turnRecoveryRef)
    : { version: 1, assets: await input.nativeRecoveryAssets.readRecoveryAssetsExact(binding.turnRecoveryRef) };
  let physical = { runtimeId: input.identity.runtimeBindingRef, executionEpoch: input.identity.executionEpoch };
  if (readback.version === 2) {
    validateNativeSegmentSaveSourceV2(readback.source);
    const capture = readback.assets;
    physical = readback.source.opened.binding.execution;
    assertSameAdmittedTurn(input.identity, projectAdmittedTurnIdentityV1(readback.source.originalAdmittedTurn));
    requireMatch(capture.receipt.commitIdentity === binding.turnRecoveryRef
      && capture.receipt.businessTurnId === input.identity.turnId
      && capture.receipt.segmentId === readback.source.opened.segmentId
      && JSON.stringify(capture.prepared.body.binding) === JSON.stringify(readback.source.opened.binding),
    'native segment capture receipt or committed execution conflicts');
    assertSameScope(scope, capture.receipt.capture.ref.scope);
  } else {
  const capture = readback.assets;
  requireMatch(capture.receipt.commitIdentity === binding.turnRecoveryRef
    && capture.receipt.turnId === input.identity.turnId
    && capture.prepared.body.binding.execution.runtimeId === input.identity.runtimeBindingRef
    && capture.prepared.body.binding.execution.executionEpoch === input.identity.executionEpoch,
  'native capture receipt or execution conflicts');
  assertSameAdmittedTurn(input.identity, projectAdmittedTurnIdentityV1(capture.prepared.body.binding.admittedTurn));
  assertSameScope(scope, capture.prepared.body.binding.scope);
  assertSameScope(scope, capture.receipt.capture.ref.scope);
  }
  requireMatch(checkpoint.executionEpoch === physical.executionEpoch, 'checkpoint physical execution conflicts with the exact native capture');
  const checkpointClosure = await input.closures.read(closure.closureRef);
  requireMatch(!!checkpointClosure && 'closureKind' in checkpointClosure && checkpointClosure.closureKind === 'checkpoint'
    && checkpointClosure.closureId === closure.closureRef && checkpointClosure.checkpointId.value === checkpoint.id.value
    && JSON.stringify(checkpointClosure.recoveryBinding) === JSON.stringify(binding), 'underlying checkpoint closure binding conflicts');
  const preparation = await readCheckpointClosurePreparation(input.closures, checkpoint);
  requireMatch(!!preparation && preparation.closureId === binding.preparationRef
    && preparation.checkpointClosureId === closure.closureRef
    && sameReviewCommitRefs([preparation.contextCommitRef], [binding.contextCommitRef]),
  'bound checkpoint closure preparation conflicts');
  const context = await readCommittedContextHistory(input.contexts, scope, binding.contextCommitRef);
  assertSameScope(scope, context.scope);
  requireMatch(context.agentRuntimeId === physical.runtimeId
    && context.loopCheckpoint.executionEpoch === physical.executionEpoch
    && recovery.contextRef === binding.contextCommitRef.commitId, 'bound context runtime, epoch or typed recovery reference conflicts');

  const aligned = await input.closures.read(input.alignmentRef);
  requireMatch(!!aligned && 'closureKind' in aligned && aligned.closureKind === 'planner-alignment', 'planner alignment is absent');
  assertPlannerAlignmentRecord(aligned);
  requireMatch(aligned.closureId === input.alignmentRef, 'planner alignment ID conflicts');
  assertTurnAlignmentBinding(closure, aligned.alignment);
  const taskScope = { organId: scope.organId, taskId: input.identity.taskRef };
  const plan = await input.plans.get(taskScope, aligned.alignment.planRevisionId);
  const planRef = await input.plans.getCommitRef(taskScope, aligned.alignment.planRevisionId);
  requireMatch(!!plan && !!planRef, 'aligned plan publication or physical receipt is absent');
  validateJournalCommitRef(planRef);
  assertSameScope(taskScope, plan.scope);
  requireMatch(plan.revisionId === aligned.alignment.planRevisionId
    && plan.sequence === aligned.alignment.planRevisionSequence
    && plan.contentDigest === aligned.alignment.planContentDigest
    && plan.journalCommitRef === aligned.planJournalCommitRef
    && `jsonl:${planRef.commitId}` === plan.journalCommitRef, 'aligned plan does not match the durable alignment');

  const result: MilestoneReviewAlignedRecord[] = [];
  for (const reviewCommitRef of refs) {
    const review = await input.journal.read(taskScope, reviewCommitRef);
    requireMatch(review.kind === 'milestone-review-result', 'bound receipt is not a completed review');
    assertMilestoneReviewResultRecord(review);
    assertReviewResultMatchesAssignment(review.reviewAssignment, review.delivery.result);
    assertSameScope(taskScope, review.taskScope);
    assertSameScope(scope, review.executionScope);
    requireMatch(review.cycleId.value === checkpoint.cycleId.value
      && review.reviewAssignment.taskId === input.identity.taskRef.value
      && review.reviewAssignment.executionEpoch === input.identity.executionEpoch
      && review.reviewAssignment.inputRevision === input.identity.inputRevision, 'review does not belong to the admitted turn');
    result.push({
      kind: 'milestone-review-aligned',
      schemaVersion: 1,
      reviewCommitRef,
      milestoneId: review.milestoneId,
      cycleId: review.cycleId,
      checkpointCommitRef: committed.commitRef,
      turnClosureRef: closure.closureId,
      contextCommitRef: binding.contextCommitRef,
      alignmentRef: aligned.closureId,
      alignedPlanRevisionCommitRef: planRef,
    });
  }
  return result;
}
