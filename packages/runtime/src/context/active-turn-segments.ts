import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import type { TaskRuntimeIncarnation } from '../../../contracts/src/framework.js';
import {
  assertSameScope,
  type ActiveTurnBinding,
  type RawAsset,
  type ScopeRef,
  type WorkAssignment,
} from '../../../contracts/src/index.js';
import { validateActiveTurnCaptureBody, type ActiveTurnCaptureBody } from '../../../contracts/src/index.js';
import { canonicalJsonStringify } from '../../../contracts/src/explicit-brain.js';
import type { CheckpointControlInputIdentity } from '../../../contracts/src/checkpoint-controls.js';
import {
  activeTurnSegmentCommitId,
  originalBusinessTurnRef,
  originalBusinessTurnRefFromBinding,
  validateActiveTurnSegmentChainRead,
  validateActiveTurnSegmentOpenIntent,
  validateResumedTurnSegmentOpened,
  type ActiveTurnInitialSegmentSource,
  type ActiveTurnSegmentBinding,
  type ActiveTurnSegmentChainInitial,
  type ActiveTurnSegmentChainRead,
  type ActiveTurnSegmentOpenIntent,
  type ActiveTurnSegmentPredecessorRef,
  type ActiveTurnSegmentRecoveryReceiptRead,
  type OriginalBusinessTurnRef,
  type ResumedTurnSegmentOpened,
} from '../../../contracts/src/active-turn-segments.js';
import { RuntimeActiveTurnError } from './active-turn-context.js';

/**
 * Runtime public consumer for same-business-turn execution segments. It reads
 * the immutable first capture through an injected exact-read port, keeps the
 * original business identity and epoch, and appends a resumed segment only
 * after the current authority admits it. It owns no second Journal or state
 * store: the physical append and exact decode stay with the J1 owner.
 */

export interface ActiveTurnSegmentReadPort {
  /**
   * Exact read of one business turn's initial segment source: the immutable v1
   * capture (`kind: 'captured'`) or the durable initial-open anchor of a turn
   * that opened in v1 but never captured (`kind: 'initial-open'`). Null when the
   * business turn has no committed initial segment at all.
   */
  readInitialSegmentSource(businessTurnId: string): Promise<ActiveTurnInitialSegmentSource | null>;
  /** Exact read of every appended segment for one business turn, in append order. */
  readSegments(businessTurnId: string): Promise<readonly ResumedTurnSegmentOpened[]>;
  /** Exact read of one segment's recovery-assets receipt. */
  readSegmentRecoveryReceipt(segmentId: string): Promise<ActiveTurnSegmentRecoveryReceiptRead>;
}

export interface ActiveTurnSegmentAppendPort {
  appendSegmentOpened(input: {
    readonly commitId: string;
    readonly record: ResumedTurnSegmentOpened;
  }): Promise<JournalCommitRef>;
}

/**
 * Exact reservation receipt. `authorityCommitRef` is the durable grant commit;
 * `businessRegistrationCommitRef` is the distinct business reservation commit;
 * `requestRef`/`inputIdentity` are the registered intent identity. Only the
 * current-authority admission that actually registered the work returns the
 * success branch; a bare read never does.
 */
export type ActiveTurnSegmentAdmission =
  | {
      readonly authorized: true;
      readonly authorityCommitRef: JournalCommitRef;
      readonly businessRegistrationCommitRef: JournalCommitRef;
      readonly requestRef: string;
      readonly inputIdentity: CheckpointControlInputIdentity;
    }
  | { readonly authorized: false; readonly reason: string };

export interface ResumeActiveTurnSegmentInput {
  readonly businessTurnId: string;
  readonly segmentId: string;
  readonly assignment: WorkAssignment;
  readonly scope: ScopeRef;
  /** The real new handle/incarnation returned by the runtime owner. */
  readonly incarnation: TaskRuntimeIncarnation;
  readonly ports: {
    readonly read: ActiveTurnSegmentReadPort;
    readonly append: ActiveTurnSegmentAppendPort;
  };
  /**
   * Current-authority admission. It receives the already-validated segment-open
   * intent, registers that exact work and returns the real reservation receipt.
   * It is the only write boundary and runs after every read-only check.
   */
  readonly admit: (intent: ActiveTurnSegmentOpenIntent) => Promise<ActiveTurnSegmentAdmission>;
}

export type ResumeActiveTurnSegmentResult =
  | {
      readonly status: 'resumed';
      readonly chain: ActiveTurnSegmentChainRead;
      readonly segment: ResumedTurnSegmentOpened;
      readonly appendReceipt: JournalCommitRef;
    }
  | {
      readonly status: 'receipt-held';
      readonly segmentId: string;
      readonly receipt: ActiveTurnSegmentRecoveryReceiptRead;
    }
  | { readonly status: 'grant-denied'; readonly reason: string };

function fail(code: string, message: string): never {
  throw new RuntimeActiveTurnError(code, message);
}

function assertSameAssignmentIdentity(requested: WorkAssignment, original: WorkAssignment): void {
  if (requested.assignmentId !== original.assignmentId
    || requested.taskId.value !== original.taskId.value
    || requested.pipelineNodeId !== original.pipelineNodeId
    || requested.attempt !== original.attempt
    || requested.executionEpoch !== original.executionEpoch
    || requested.inputRevision !== original.inputRevision) {
    fail('active-turn.segment.assignment-mismatch', 'a resumed segment keeps the original work assignment identity');
  }
}

function sameAssignmentIdentity(left: WorkAssignment, right: WorkAssignment): boolean {
  return left.assignmentId === right.assignmentId
    && left.taskId.value === right.taskId.value
    && left.pipelineNodeId === right.pipelineNodeId
    && left.attempt === right.attempt
    && left.executionEpoch === right.executionEpoch
    && left.inputRevision === right.inputRevision;
}

/**
 * The resumed segment keeps the original task and assignment identity; only its
 * real handle and epoch advance. A mismatch ends before registration. The scope
 * relation is covered by the original-scope check in the caller.
 */
function assertSegmentIdentityRelations(input: {
  readonly incarnation: TaskRuntimeIncarnation;
  readonly assignment: WorkAssignment;
}): void {
  if (input.incarnation.taskId.value !== input.assignment.taskId.value) {
    fail('active-turn.segment.incarnation-task-mismatch', 'the resumed incarnation task must match the work assignment');
  }
  if (input.incarnation.assignmentId !== input.assignment.assignmentId) {
    fail('active-turn.segment.incarnation-assignment-mismatch', 'the resumed incarnation must keep the original work assignment identity');
  }
}

/**
 * Content match for an exact retry. The committed record is authoritative for
 * its predecessor and reservation receipts, so only the caller-controlled and
 * chain-independent identity is compared: business turn, segment and binding.
 */
function sameSegmentIntentIdentity(
  stored: ResumedTurnSegmentOpened,
  candidate: {
    readonly businessTurnRef: OriginalBusinessTurnRef;
    readonly segmentId: string;
    readonly binding: ActiveTurnSegmentBinding;
  },
): boolean {
  return stored.segmentId === candidate.segmentId
    && canonicalJsonStringify(stored.businessTurnRef) === canonicalJsonStringify(candidate.businessTurnRef)
    && sameAssignmentIdentity(stored.binding.assignment, candidate.binding.assignment)
    && canonicalJsonStringify(stored.binding.execution) === canonicalJsonStringify(candidate.binding.execution)
    && canonicalJsonStringify(stored.binding.incarnation) === canonicalJsonStringify(candidate.binding.incarnation)
    && canonicalJsonStringify(stored.binding.scope) === canonicalJsonStringify(candidate.binding.scope);
}

/**
 * Resume one business turn on a new execution epoch. The immutable first
 * capture and the exact predecessor receipt are read before any write. Unknown
 * or incomplete exact facts hold the recovery obligation and append nothing.
 * The current grant is checked across the durable registration only; no network
 * or tool work runs inside this call.
 */
export async function resumeActiveTurnSegment(
  input: ResumeActiveTurnSegmentInput,
): Promise<ResumeActiveTurnSegmentResult> {
  const initialSource = await input.ports.read.readInitialSegmentSource(input.businessTurnId);
  if (!initialSource) {
    fail('active-turn.segment.initial-missing', `no initial segment source for business turn ${input.businessTurnId}`);
  }
  let businessTurnRef: OriginalBusinessTurnRef;
  let initialBinding: ActiveTurnBinding;
  let chainInitial: ActiveTurnSegmentChainInitial;
  let initialInput: RawAsset;
  if (initialSource.kind === 'captured') {
    validateActiveTurnCaptureBody(initialSource.body);
    businessTurnRef = originalBusinessTurnRef(initialSource.bindingCommitRef, initialSource.body);
    initialBinding = initialSource.body.binding;
    chainInitial = { kind: 'captured', body: initialSource.body };
    initialInput = initialSource.body.initialInput;
  } else {
    businessTurnRef = originalBusinessTurnRefFromBinding(initialSource.anchor.bindingCommitRef, initialSource.binding);
    initialBinding = initialSource.binding;
    chainInitial = initialSource;
    initialInput = initialSource.initialInput;
  }
  assertSameAssignmentIdentity(input.assignment, initialBinding.assignment);
  if (businessTurnRef.businessTurnId !== input.businessTurnId) {
    fail('active-turn.segment.business-turn-mismatch', 'the initial segment source does not belong to the requested business turn');
  }
  // The resumed segment keeps the original business scope.
  assertSameScope(input.scope, initialBinding.scope);
  assertSegmentIdentityRelations({ incarnation: input.incarnation, assignment: input.assignment });

  const execution = {
    runtimeId: input.incarnation.runtimeId,
    executionEpoch: input.incarnation.executionEpoch,
  };
  const candidateBinding: ActiveTurnSegmentBinding = {
    businessTurnRef,
    assignment: input.assignment,
    execution,
    incarnation: input.incarnation,
    scope: input.scope,
  };

  // Read and validate the committed chain before creating anything.
  const appended = await input.ports.read.readSegments(input.businessTurnId);
  const chain: ActiveTurnSegmentChainRead = { businessTurnRef, initial: chainInitial, segments: appended };
  validateActiveTurnSegmentChainRead(chain);

  // Exact retry: the target may already be committed. Reuse its content and the
  // original receipt; a different intent is an explicit conflict. The committed
  // record is authoritative for its own predecessor and receipts.
  const stored = chain.segments.find((candidate) => candidate.segmentId === input.segmentId);
  if (stored) {
    if (!sameSegmentIntentIdentity(stored, {
      businessTurnRef,
      segmentId: input.segmentId,
      binding: candidateBinding,
    })) {
      fail('active-turn.segment.retry-conflict', `segment ${input.segmentId} is already committed with different content`);
    }
    const replayReceipt = await input.ports.append.appendSegmentOpened({
      commitId: activeTurnSegmentCommitId(input.segmentId, 'segment-opened'),
      record: stored,
    });
    return { status: 'resumed', chain, segment: stored, appendReceipt: replayReceipt };
  }

  // The new segment resumes the committed chain tail, or the initial segment
  // derived from the original v1 binding when no resumed segment exists yet.
  const tail = chain.segments.length === 0 ? undefined : chain.segments[chain.segments.length - 1];
  const predecessorSegmentId = tail ? tail.segmentId : businessTurnRef.businessTurnId;
  const predecessorEpoch = tail ? tail.binding.execution.executionEpoch : businessTurnRef.execution.executionEpoch;
  if (predecessorSegmentId === input.segmentId) {
    fail('active-turn.segment.self-predecessor', 'a resumed segment cannot be its own predecessor');
  }

  // Exact read of the predecessor's recovery receipt. An `exact` receipt links
  // the closed predecessor; a strict `interrupted` read links the real opened
  // anchor of a segment that appended records but never committed a receipt.
  // A failed or unknown receipt keeps the recovery obligation and appends nothing.
  const receipt = await input.ports.read.readSegmentRecoveryReceipt(predecessorSegmentId);
  if (receipt.status === 'failed' || receipt.status === 'unknown') {
    return { status: 'receipt-held', segmentId: predecessorSegmentId, receipt };
  }
  if (execution.executionEpoch <= predecessorEpoch) {
    fail('active-turn.segment.epoch-not-advanced', 'a resumed segment must advance to a new execution epoch');
  }

  const predecessor: ActiveTurnSegmentPredecessorRef = receipt.status === 'exact'
    ? { segmentId: predecessorSegmentId, recoveryAssetsReceiptRef: receipt.recoveryAssetsReceiptRef }
    : receipt.status === 'interrupted'
      ? { segmentId: predecessorSegmentId, interrupted: receipt.anchor }
      : { segmentId: predecessorSegmentId, initialOpen: receipt.anchor };
  const intent: ActiveTurnSegmentOpenIntent = {
    businessTurnRef,
    segmentId: input.segmentId,
    predecessor,
    binding: candidateBinding,
    initialInput,
  };
  validateActiveTurnSegmentOpenIntent(intent);

  // The only write boundary: the current-authority admission registers this
  // exact work and returns the real reservation receipt.
  const admission = await input.admit(intent);
  if (!admission.authorized) {
    return { status: 'grant-denied', reason: admission.reason };
  }

  const segment: ResumedTurnSegmentOpened = {
    kind: 'segment-opened',
    segmentId: input.segmentId,
    businessTurnRef,
    predecessor,
    binding: candidateBinding,
    authorityCommitRef: admission.authorityCommitRef,
    businessRegistrationCommitRef: admission.businessRegistrationCommitRef,
    requestRef: admission.requestRef,
    inputIdentity: admission.inputIdentity,
  };
  validateResumedTurnSegmentOpened(segment);

  const appendReceipt = await input.ports.append.appendSegmentOpened({
    commitId: activeTurnSegmentCommitId(input.segmentId, 'segment-opened'),
    record: segment,
  });

  // Exact cold re-read: the durable record must equal what we appended.
  const reopened = await input.ports.read.readSegments(input.businessTurnId);
  const committed: ActiveTurnSegmentChainRead = { businessTurnRef, initial: chainInitial, segments: reopened };
  validateActiveTurnSegmentChainRead(committed);
  const persisted = committed.segments.find((candidate) => candidate.segmentId === input.segmentId);
  if (!persisted) fail('active-turn.segment.append-missing', 'the appended segment is absent from the durable chain');
  if (canonicalJsonStringify(persisted) !== canonicalJsonStringify(segment)) {
    fail('active-turn.segment.append-content-mismatch', 'the durable segment does not match the appended content');
  }
  return { status: 'resumed', chain: committed, segment: persisted, appendReceipt };
}
