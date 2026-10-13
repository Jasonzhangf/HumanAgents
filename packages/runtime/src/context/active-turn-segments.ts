import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import type { TaskRuntimeIncarnation } from '../../../contracts/src/framework.js';
import type { ScopeRef, WorkAssignment } from '../../../contracts/src/index.js';
import { validateActiveTurnCaptureBody, type ActiveTurnCaptureBody } from '../../../contracts/src/index.js';
import {
  activeTurnSegmentCommitId,
  originalBusinessTurnRef,
  validateActiveTurnSegmentChainRead,
  validateResumedTurnSegmentOpened,
  type ActiveTurnInitialSegmentCapture,
  type ActiveTurnSegmentBinding,
  type ActiveTurnSegmentChainRead,
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
  /** Exact read of the immutable first (v1) capture for one business turn. */
  readInitialSegmentCapture(businessTurnId: string): Promise<ActiveTurnInitialSegmentCapture | null>;
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

export interface ActiveTurnSegmentAdmissionInput {
  readonly businessTurnRef: OriginalBusinessTurnRef;
  readonly incarnation: TaskRuntimeIncarnation;
  readonly segmentId: string;
}

export type ActiveTurnSegmentAdmission =
  | { readonly authorized: true; readonly authorityCommitRef: JournalCommitRef }
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
  /** Current-authority admission. It is called before any durable registration. */
  readonly admit: (input: ActiveTurnSegmentAdmissionInput) => Promise<ActiveTurnSegmentAdmission>;
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
  const capture = await input.ports.read.readInitialSegmentCapture(input.businessTurnId);
  if (!capture) {
    fail('active-turn.segment.initial-missing', `no immutable first capture for business turn ${input.businessTurnId}`);
  }
  const initial: ActiveTurnInitialSegmentCapture = capture;
  validateActiveTurnCaptureBody(initial.body);
  assertSameAssignmentIdentity(input.assignment, initial.body.binding.assignment);
  const businessTurnRef = originalBusinessTurnRef(initial.bindingCommitRef, initial.body);
  if (businessTurnRef.businessTurnId !== input.businessTurnId) {
    fail('active-turn.segment.business-turn-mismatch', 'immutable first capture does not belong to the requested business turn');
  }

  // The initial segment is derived from the original v1 binding; no new
  // binding-opened record is written.
  const initialSegmentId = businessTurnRef.businessTurnId;
  const receipt = await input.ports.read.readSegmentRecoveryReceipt(initialSegmentId);
  if (receipt.status === 'failed' || receipt.status === 'unknown') {
    return { status: 'receipt-held', segmentId: initialSegmentId, receipt };
  }

  const admission = await input.admit({
    businessTurnRef,
    incarnation: input.incarnation,
    segmentId: input.segmentId,
  });
  if (!admission.authorized) {
    return { status: 'grant-denied', reason: admission.reason };
  }

  const execution = {
    runtimeId: input.incarnation.runtimeId,
    executionEpoch: input.incarnation.executionEpoch,
  };
  if (execution.executionEpoch <= businessTurnRef.execution.executionEpoch) {
    fail('active-turn.segment.epoch-not-advanced', 'a resumed segment must advance to a new execution epoch');
  }

  const binding: ActiveTurnSegmentBinding = {
    businessTurnRef,
    assignment: input.assignment,
    execution,
    incarnation: input.incarnation,
    scope: input.scope,
  };
  const predecessor: ActiveTurnSegmentPredecessorRef = {
    segmentId: initialSegmentId,
    recoveryAssetsReceiptRef: businessTurnRef.bindingCommitRef.commitId,
  };
  const segment: ResumedTurnSegmentOpened = {
    kind: 'segment-opened',
    segmentId: input.segmentId,
    businessTurnRef,
    predecessor,
    binding,
    authorityCommitRef: admission.authorityCommitRef,
  };
  validateResumedTurnSegmentOpened(segment);

  const appendReceipt = await input.ports.append.appendSegmentOpened({
    commitId: activeTurnSegmentCommitId(input.segmentId, 'segment-opened'),
    record: segment,
  });

  const appended = await input.ports.read.readSegments(input.businessTurnId);
  const chain: ActiveTurnSegmentChainRead = { businessTurnRef, initial: initial.body, segments: appended };
  validateActiveTurnSegmentChainRead(chain);
  const stored = chain.segments.find((candidate) => candidate.segmentId === input.segmentId);
  if (!stored) fail('active-turn.segment.append-missing', 'the appended segment is absent from the durable chain');
  return { status: 'resumed', chain, segment: stored, appendReceipt };
}
