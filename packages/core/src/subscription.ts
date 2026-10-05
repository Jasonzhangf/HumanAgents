import {
  canonicalJsonStringify,
  subscriptionControlRequestFingerprint,
  validateExecutionPolicyDefinition,
  validateOccurrence,
  validateOccurrenceClaim,
  validateOccurrenceExecutionAdmissionRecord,
  validateOccurrenceExecutionOwner,
  validateOccurrenceTaskBinding,
  validateServeTaskTerminalReceipt,
  validateOccurrenceTerminalReceiptRecord,
  validateRecoveryResponsibilityRecord,
  validateSubscription,
  validateSubscriptionControlRequest,
  occurrenceExecutionDispatchRef,
  type ExecutionPolicyDefinition,
  type EvidenceRef,
  type OccurrenceExecutionAdmissionRecord,
  type OccurrenceExecutionOwner,
  type Occurrence,
  type OccurrenceClaim,
  type OccurrenceTaskBinding,
  type OccurrenceTerminalReceiptRecord,
  type OperationId,
  type RecoveryResponsibilityRecord,
  type ServeTaskTerminalReceipt,
  type Subscription,
  type SubscriptionControlReceipt,
  type SubscriptionControlRequest,
  type TaskVerificationResult,
  type TaskId,
} from '../../contracts/src/index.js';
import { createHash } from 'node:crypto';
import { CoreError } from './errors.js';

export type SubscriptionControlFailureCode =
  | 'not-found'
  | 'stale-revision'
  | 'invalid-state'
  | 'policy-hash-mismatch'
  | 'invalid-transition'
  | 'invalid-occurrence'
  | 'exhausted'
  | 'superseded'
  | 'lease-expired';

export class SubscriptionControlError extends CoreError {
  readonly code: SubscriptionControlFailureCode;

  constructor(code: SubscriptionControlFailureCode, message: string) {
    super(message);
    this.name = 'SubscriptionControlError';
    this.code = code;
  }
}

export interface SubscriptionDecisionState {
  readonly subscription: Subscription;
  readonly policy: ExecutionPolicyDefinition;
  readonly policyHash: string;
  readonly receipts: Readonly<Record<string, SubscriptionControlReceipt>>;
  readonly occurrences: readonly Occurrence[];
}

export interface SubscriptionControlDecision {
  readonly status: 'applied' | 'duplicate' | 'stale' | 'conflict';
  readonly subscription: Subscription;
  readonly policy: ExecutionPolicyDefinition;
  readonly policyHash: string;
  readonly receipt: SubscriptionControlReceipt;
  readonly superseded: readonly Occurrence[];
}

export type OccurrenceAuthorityDecision =
  | {
      readonly kind: 'first-admission';
      readonly record: OccurrenceExecutionAdmissionRecord;
      readonly admittedExecutionOwner: OccurrenceExecutionOwner;
      readonly mutation: 'admitted';
      readonly dispatchAllowed: true;
      readonly recoveryAllowed: false;
    }
  | {
      readonly kind: 'current-owner';
      readonly admission: OccurrenceExecutionAdmissionRecord;
      readonly mutation: 'mutation-allowed';
      readonly dispatchAllowed: false;
      readonly recoveryAllowed: false;
    }
  | {
      readonly kind: 'owner-live-unproven';
      readonly admission?: OccurrenceExecutionAdmissionRecord;
      readonly reason: 'no-authenticated-caller' | 'claim-live' | 'no-claim' | 'replacement-unproven';
      readonly mutation: 'none';
      readonly dispatchAllowed: false;
      readonly recoveryAllowed: false;
    }
  | {
      readonly kind: 'lease-expired';
      readonly admission: OccurrenceExecutionAdmissionRecord;
      readonly expiresAt: string;
      readonly nowAt: string;
      readonly mutation: 'none';
      readonly dispatchAllowed: false;
      readonly recoveryAllowed: false;
    }
  | {
      readonly kind: 'stale-owner';
      readonly admission: OccurrenceExecutionAdmissionRecord;
      readonly mutation: 'none';
      readonly dispatchAllowed: false;
      readonly recoveryAllowed: false;
    }
  | {
      readonly kind: 'recovery-allowed';
      readonly admission: OccurrenceExecutionAdmissionRecord;
      readonly authenticatedOwner: OccurrenceExecutionOwner;
      readonly mutation: 'blocked-recovery-only';
      readonly dispatchAllowed: false;
      readonly recoveryAllowed: true;
    }
  | {
      readonly kind: 'binding-mismatch';
      readonly requestedBinding: OccurrenceTaskBinding;
      readonly authoritativeBinding: OccurrenceTaskBinding;
      readonly mutation: 'none';
      readonly dispatchAllowed: false;
      readonly recoveryAllowed: false;
    }
  | {
      readonly kind: 'invalid-admission';
      readonly reason: 'missing-owner' | 'invalid-owner' | 'invalid-record';
      readonly mutation: 'none';
      readonly dispatchAllowed: false;
      readonly recoveryAllowed: false;
    };

export interface OccurrenceAuthorityInput {
  readonly binding: OccurrenceTaskBinding;
  readonly authoritativeBinding: OccurrenceTaskBinding;
  readonly admission?: OccurrenceExecutionAdmissionRecord;
  readonly claim?: OccurrenceClaim;
  readonly authenticatedCaller?: OccurrenceExecutionOwner;
  readonly committedReplacement: boolean;
  readonly nowAt: string;
}

function fail(code: SubscriptionControlFailureCode, message: string): never {
  throw new SubscriptionControlError(code, message);
}

function policyHash(policy: ExecutionPolicyDefinition): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(policy)).digest('hex')}`;
}

function receiptIdentity(receipt: SubscriptionControlReceipt): string {
  return `${receipt.subscriptionId}:${receipt.idempotencyKey}`;
}

function assertPolicyRevision(policy: ExecutionPolicyDefinition, request: SubscriptionControlRequest): void {
  if (policy.policyRevision !== request.expectedPolicyRevision) {
    fail('stale-revision', `policy revision ${request.expectedPolicyRevision} is stale; current is ${policy.policyRevision}`);
  }
}

function assertScheduleRevision(subscription: Subscription, request: SubscriptionControlRequest): void {
  if (request.expectedScheduleRevision !== undefined && request.expectedScheduleRevision !== subscription.scheduleRevision) {
    fail('stale-revision', `schedule revision ${request.expectedScheduleRevision} is stale; current is ${subscription.scheduleRevision}`);
  }
}

function supersedeUnclaimed(occurrences: readonly Occurrence[], scheduleRevision: number): readonly Occurrence[] {
  return occurrences.flatMap((occurrence) => occurrence.scheduleRevision === scheduleRevision
    && (occurrence.state === 'due' || occurrence.state === 'reminder-pending')
    ? [{ ...occurrence, state: 'invalidated' as const }]
    : []);
}

export function preserveSamePolicyControlProgress(
  subscription: Subscription,
  action: Exclude<SubscriptionControlRequest['action'], 'modify'>,
  invalidated: readonly Occurrence[] = [],
): Subscription {
  if (action !== 'pause' && action !== 'resume') return { ...subscription };
  const next = subscription.state === 'suspended' ? 'active' : 'suspended';
  const currentOccurrenceOrdinal = action === 'pause'
    ? invalidated.reduce((ordinal, occurrence) => Math.max(ordinal, occurrence.occurrenceOrdinal), subscription.currentOccurrenceOrdinal)
    : subscription.currentOccurrenceOrdinal;
  return {
    ...subscription,
    state: next,
    scheduleRevision: subscription.scheduleRevision + 1,
    currentOccurrenceOrdinal,
  };
}

export function preserveSamePolicyClaimProgress(
  subscription: Subscription,
  claim: { readonly policyHash: string; readonly scheduleRevision: number },
  policyHash: string,
  occurrenceOrdinal: number,
  receipts: readonly SubscriptionControlReceipt[],
  maxOccurrences?: number,
): Subscription {
  const replacedAfterClaim = receipts.some((receipt) => receipt.action === 'modify'
    && receipt.status === 'applied'
    && receipt.scheduleRevision > claim.scheduleRevision
    && receipt.scheduleRevision <= subscription.scheduleRevision);
  if (claim.policyHash !== policyHash || replacedAfterClaim) return { ...subscription };
  const next = Math.max(subscription.currentOccurrenceOrdinal, occurrenceOrdinal);
  const state = subscription.state === 'active'
    && maxOccurrences !== undefined
    && next >= maxOccurrences
    ? 'exhausted' as const
    : subscription.state;
  return { ...subscription, currentOccurrenceOrdinal: next, state };
}

function appliedReceipt(
  request: SubscriptionControlRequest,
  subscription: Subscription,
  policyRevision: number,
  superseded: readonly Occurrence[],
): SubscriptionControlReceipt {
  return {
    subscriptionId: request.subscriptionId,
    action: request.action,
    status: 'applied',
    policyRevision,
    scheduleRevision: subscription.scheduleRevision,
    idempotencyKey: request.idempotencyKey,
    requestHash: subscriptionControlRequestFingerprint(request),
    supersededUnclaimedOccurrences: superseded.map((occurrence) => occurrence.occurrenceId ?? `${occurrence.subscriptionId}::${occurrence.scheduleRevision}::${occurrence.occurrenceOrdinal}`),
    controlRef: `subscription-control:${request.subscriptionId}:${request.idempotencyKey}`,
  };
}

function staleReceipt(request: SubscriptionControlRequest, subscription: Subscription, currentPolicyRevision: number): SubscriptionControlReceipt {
  return {
    subscriptionId: request.subscriptionId,
    action: request.action,
    status: 'stale',
    policyRevision: currentPolicyRevision,
    scheduleRevision: subscription.scheduleRevision,
    idempotencyKey: request.idempotencyKey,
    requestHash: subscriptionControlRequestFingerprint(request),
    supersededUnclaimedOccurrences: [],
    controlRef: `subscription-control:${request.subscriptionId}:${request.idempotencyKey}`,
  };
}

export function decideSubscriptionControl(
  subscription: Subscription,
  policy: ExecutionPolicyDefinition,
  policyHashValue: string,
  occurrences: readonly Occurrence[],
  receipts: Readonly<Record<string, SubscriptionControlReceipt>>,
  request: SubscriptionControlRequest,
): SubscriptionControlDecision {
  validateSubscription(subscription);
  validateExecutionPolicyDefinition(policy);
  validateSubscriptionControlRequest(request);

  const replay = receipts[request.idempotencyKey];
  if (replay) {
    if (replay.requestHash !== subscriptionControlRequestFingerprint(request)) {
      return {
        status: 'conflict',
        subscription,
        policy,
        policyHash: policyHashValue,
        superseded: [],
        receipt: {
          ...replay,
          status: 'conflict',
        },
      };
    }
    return {
      status: 'duplicate',
      subscription,
      policy,
      policyHash: policyHashValue,
      superseded: [],
      receipt: { ...replay, status: 'duplicate' },
    };
  }

  try {
    assertPolicyRevision(policy, request);
    assertScheduleRevision(subscription, request);
  } catch (error) {
    if (error instanceof SubscriptionControlError && error.code === 'stale-revision') {
      return {
        status: 'stale',
        subscription,
        policy,
        policyHash: policyHashValue,
        superseded: [],
        receipt: staleReceipt(request, subscription, policy.policyRevision),
      };
    }
    throw error;
  }

  if (request.action === 'modify') {
    const nextPolicyHash = policyHash(request.newPolicy);
    if (nextPolicyHash !== request.newPolicyHash) {
      fail('policy-hash-mismatch', 'modify policy hash does not match the complete new policy');
    }
    request = { ...request, newPolicyHash: nextPolicyHash };
    if (subscription.state === 'cancelled' || subscription.state === 'completed' || subscription.state === 'exhausted') {
      fail('invalid-state', `cannot modify a ${subscription.state} subscription`);
    }
    const nextSubscription: Subscription = {
      ...subscription,
      scheduleRevision: subscription.scheduleRevision + 1,
      currentOccurrenceOrdinal: 0,
    };
    const invalidated = supersedeUnclaimed(occurrences, subscription.scheduleRevision);
    const receipt = appliedReceipt(request, nextSubscription, request.newPolicy.policyRevision, invalidated);
    return {
      status: 'applied',
      subscription: nextSubscription,
      policy: request.newPolicy,
      policyHash: nextPolicyHash,
      receipt,
      superseded: invalidated,
    };
  }

  if (request.action === 'pause') {
    if (subscription.state !== 'active') fail('invalid-state', `only active subscriptions can pause; current is ${subscription.state}`);
    const invalidated = supersedeUnclaimed(occurrences, subscription.scheduleRevision);
    const nextSubscription = preserveSamePolicyControlProgress(subscription, 'pause', invalidated);
    return {
      status: 'applied',
      subscription: nextSubscription,
      policy,
      policyHash: policyHashValue,
      receipt: appliedReceipt(request, nextSubscription, policy.policyRevision, invalidated),
      superseded: invalidated,
    };
  }

  if (request.action === 'resume') {
    if (subscription.state !== 'suspended') fail('invalid-state', `only suspended subscriptions can resume; current is ${subscription.state}`);
    const nextSubscription = preserveSamePolicyControlProgress(subscription, 'resume');
    return {
      status: 'applied',
      subscription: nextSubscription,
      policy,
      policyHash: policyHashValue,
      receipt: appliedReceipt(request, nextSubscription, policy.policyRevision, []),
      superseded: [],
    };
  }

  if (subscription.state === 'cancelled') fail('invalid-state', 'subscription is already cancelled');
  const nextSubscription: Subscription = { ...subscription, state: 'cancelled', scheduleRevision: subscription.scheduleRevision + 1 };
  const invalidated = supersedeUnclaimed(occurrences, subscription.scheduleRevision);
  return {
    status: 'applied',
    subscription: nextSubscription,
    policy,
    policyHash: policyHashValue,
    receipt: appliedReceipt(request, nextSubscription, policy.policyRevision, invalidated),
    superseded: invalidated,
  };
}

export function assertOccurrenceClaimable(
  subscription: Subscription,
  policy: ExecutionPolicyDefinition,
  occurrence: Occurrence,
  nowAt: string,
): void {
  validateSubscription(subscription);
  validateExecutionPolicyDefinition(policy);
  validateOccurrence(occurrence);
  if (subscription.state !== 'active') fail('invalid-state', `subscription is ${subscription.state}`);
  if (occurrence.subscriptionId !== subscription.subscriptionId) fail('invalid-occurrence', 'occurrence belongs to another subscription');
  if (occurrence.scheduleRevision !== subscription.scheduleRevision) fail('superseded', 'occurrence schedule revision is superseded');
  if (occurrence.state !== 'due') {
    fail('invalid-occurrence', `occurrence state ${occurrence.state} is not claimable`);
  }
  if (occurrence.occurrenceOrdinal <= subscription.currentOccurrenceOrdinal) {
    fail('invalid-occurrence', 'occurrence ordinal has already been consumed');
  }
  const maxOccurrences = policy.executionMode === 'once' ? 1 : policy.maxOccurrences;
  if (maxOccurrences !== undefined && occurrence.occurrenceOrdinal > maxOccurrences) {
    fail('exhausted', 'occurrence ordinal exceeds maxOccurrences');
  }
  if (policy.executionMode !== 'once' && policy.endAt !== undefined && Date.parse(occurrence.dueAt) >= Date.parse(policy.endAt)) {
    fail('exhausted', 'occurrence is outside the subscription end');
  }
  if (Date.parse(occurrence.dueAt) > Date.parse(nowAt) + 1_000) {
    fail('invalid-occurrence', 'occurrence is not due yet');
  }
}

export function assertOccurrenceClaimFence(
  subscription: Subscription,
  policy: ExecutionPolicyDefinition,
  claim: OccurrenceClaim,
  nowAt: string,
): void {
  validateSubscription(subscription);
  validateExecutionPolicyDefinition(policy);
  if (subscription.state !== 'active') fail('invalid-state', `subscription is ${subscription.state}`);
  if (claim.subscriptionId !== subscription.subscriptionId) fail('invalid-occurrence', 'claim belongs to another subscription');
  if (claim.scheduleRevision !== subscription.scheduleRevision) fail('superseded', 'claim schedule revision is stale');
  assertOccurrenceClaimLease(claim, nowAt);
}

export function assertOccurrenceClaimLease(claim: OccurrenceClaim, nowAt: string): void {
  validateOccurrenceClaim(claim);
  if (claim.generation < 1) fail('invalid-occurrence', 'claim generation is invalid');
  const expiry = Date.parse(claim.expiresAt);
  const now = Date.parse(nowAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(now)) fail('invalid-occurrence', 'claim lease timestamps are invalid');
  if (expiry <= now) fail('lease-expired', 'claim lease has expired');
}

function sameOccurrenceBinding(left: OccurrenceTaskBinding, right: OccurrenceTaskBinding): boolean {
  return left.occurrenceId === right.occurrenceId
    && left.subscriptionId === right.subscriptionId
    && left.scheduleRevision === right.scheduleRevision
    && left.occurrenceOrdinal === right.occurrenceOrdinal
    && left.taskId.scope === right.taskId.scope
    && left.taskId.value === right.taskId.value
    && left.operationId.scope === right.operationId.scope
    && left.operationId.value === right.operationId.value
    && left.executionEpoch === right.executionEpoch
    && left.inputArtifactDigest === right.inputArtifactDigest;
}

function sameExecutionOwner(left: OccurrenceExecutionOwner, right: OccurrenceExecutionOwner): boolean {
  return left.daemonLeaseId === right.daemonLeaseId
    && left.daemonGeneration === right.daemonGeneration
    && left.processStartToken === right.processStartToken;
}

function validateOccurrenceAuthorityCaller(caller: OccurrenceExecutionOwner): void {
  try {
    validateOccurrenceExecutionOwner(caller);
  } catch (error) {
    throw new SubscriptionControlError(
      'invalid-occurrence',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function decideOccurrenceAuthority(input: OccurrenceAuthorityInput): OccurrenceAuthorityDecision {
  try {
    validateOccurrenceTaskBinding(input.binding);
    validateOccurrenceTaskBinding(input.authoritativeBinding);
  } catch (error) {
    return {
      kind: 'invalid-admission',
      reason: 'invalid-record',
      mutation: 'none',
      dispatchAllowed: false,
      recoveryAllowed: false,
    };
  }
  if (!sameOccurrenceBinding(input.binding, input.authoritativeBinding)) {
    return {
      kind: 'binding-mismatch',
      requestedBinding: input.binding,
      authoritativeBinding: input.authoritativeBinding,
      mutation: 'none',
      dispatchAllowed: false,
      recoveryAllowed: false,
    };
  }
  if (input.admission === undefined) {
    if (input.authenticatedCaller === undefined) {
      return {
        kind: 'owner-live-unproven',
        reason: 'no-authenticated-caller',
        mutation: 'none',
        dispatchAllowed: false,
        recoveryAllowed: false,
      };
    }
    validateOccurrenceAuthorityCaller(input.authenticatedCaller);
    const recoveryResponsibility: RecoveryResponsibilityRecord = {
      providerEffectState: 'possible',
      resourceInventory: [],
      releaseProofs: [],
    };
    const record: OccurrenceExecutionAdmissionRecord = {
      kind: 'occurrence-execution-admission',
      version: 1,
      binding: input.binding,
      dispatchRef: occurrenceExecutionDispatchRef(input.binding),
      admittedAt: input.nowAt,
      admittedExecutionOwner: input.authenticatedCaller,
      recoveryResponsibility,
    };
    return {
      kind: 'first-admission',
      record,
      admittedExecutionOwner: input.authenticatedCaller,
      mutation: 'admitted',
      dispatchAllowed: true,
      recoveryAllowed: false,
    };
  }
  try {
    validateOccurrenceExecutionAdmissionRecord(input.admission);
  } catch (error) {
    const reason = input.admission.admittedExecutionOwner === undefined
      ? 'missing-owner'
      : 'invalid-record';
    return {
      kind: 'invalid-admission',
      reason,
      mutation: 'none',
      dispatchAllowed: false,
      recoveryAllowed: false,
    };
  }
  if (!sameOccurrenceBinding(input.admission.binding, input.binding)) {
    return {
      kind: 'binding-mismatch',
      requestedBinding: input.binding,
      authoritativeBinding: input.admission.binding,
      mutation: 'none',
      dispatchAllowed: false,
      recoveryAllowed: false,
    };
  }
  if (input.authenticatedCaller === undefined) {
    return {
      kind: 'owner-live-unproven',
      admission: input.admission,
      reason: 'no-authenticated-caller',
      mutation: 'none',
      dispatchAllowed: false,
      recoveryAllowed: false,
    };
  }
  validateOccurrenceAuthorityCaller(input.authenticatedCaller);
  const admittedOwner = input.admission.admittedExecutionOwner;
  if (sameExecutionOwner(admittedOwner, input.authenticatedCaller)) {
    return {
      kind: 'current-owner',
      admission: input.admission,
      mutation: 'mutation-allowed',
      dispatchAllowed: false,
      recoveryAllowed: false,
    };
  }
  if (input.claim !== undefined) {
    try {
      assertOccurrenceClaimLease(input.claim, input.nowAt);
    } catch (error) {
      if (error instanceof SubscriptionControlError && error.code === 'lease-expired') {
        return {
          kind: 'lease-expired',
          admission: input.admission,
          expiresAt: input.claim.expiresAt,
          nowAt: input.nowAt,
          mutation: 'none',
          dispatchAllowed: false,
          recoveryAllowed: false,
        };
      }
      throw error;
    }
  }
  if (input.committedReplacement && input.claim !== undefined
    && input.authenticatedCaller.daemonLeaseId !== admittedOwner.daemonLeaseId
    && input.authenticatedCaller.daemonGeneration > admittedOwner.daemonGeneration
    && input.authenticatedCaller.processStartToken !== admittedOwner.processStartToken) {
    return {
      kind: 'recovery-allowed',
      admission: input.admission,
      authenticatedOwner: input.authenticatedCaller,
      mutation: 'blocked-recovery-only',
      dispatchAllowed: false,
      recoveryAllowed: true,
    };
  }
  return {
    kind: 'stale-owner',
    admission: input.admission,
    mutation: 'none',
    dispatchAllowed: false,
    recoveryAllowed: false,
  };
}

export function assertVerifiedTerminalReceipt(input: {
  readonly occurrence: Occurrence;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly inputArtifactDigest: string;
  readonly terminal: ServeTaskTerminalReceipt;
}): void {
  const { occurrence, taskId, operationId, executionEpoch, inputArtifactDigest, terminal } = input;
  validateOccurrence(occurrence);
  const binding: OccurrenceTaskBinding = {
    occurrenceId: `${occurrence.subscriptionId}::${occurrence.scheduleRevision}::${occurrence.occurrenceOrdinal}`,
    subscriptionId: occurrence.subscriptionId,
    scheduleRevision: occurrence.scheduleRevision,
    occurrenceOrdinal: occurrence.occurrenceOrdinal,
    taskId,
    operationId,
    executionEpoch,
    inputArtifactDigest,
  };
  sharedTerminalReceiptIdentity(terminal, binding);
  if (terminal.verification.status !== 'success') fail('invalid-occurrence', `task verification is ${terminal.verification.status}`);
}

export type OccurrenceTerminalOutcome =
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'missing'
  | 'blocked'
  | 'cancelled';

export interface OccurrenceTerminalReceiptDecision {
  readonly outcome: OccurrenceTerminalOutcome;
  readonly terminalReceipt: ServeTaskTerminalReceipt;
  readonly record: OccurrenceTerminalReceiptRecord;
  readonly checkpointOutcome: 'succeeded' | 'failed' | 'blocked' | 'cancelled';
  readonly recoveryRequired: boolean;
  readonly resourceReleaseConfirmed: boolean;
}

function terminalOutcomeForVerification(status: TaskVerificationResult['status']): OccurrenceTerminalOutcome {
  switch (status) {
    case 'success':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'rejected':
      return 'rejected';
    case 'missing':
      return 'missing';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
  }
  throw new SubscriptionControlError('invalid-occurrence', `unknown task verification status: ${String(status)}`);
}

function sharedTerminalReceiptIdentity(
  terminal: ServeTaskTerminalReceipt,
  binding: OccurrenceTaskBinding,
): void {
  validateOccurrenceTaskBinding(binding);
  try {
    validateServeTaskTerminalReceipt(terminal);
  } catch (error) {
    throw new SubscriptionControlError(
      'invalid-occurrence',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (terminal.taskId.scope !== binding.taskId.scope || terminal.taskId.value !== binding.taskId.value) {
    fail('invalid-occurrence', 'terminal task identity does not match occurrence binding');
  }
  if (terminal.operationId.scope !== binding.operationId.scope || terminal.operationId.value !== binding.operationId.value) {
    fail('invalid-occurrence', 'terminal operation identity does not match occurrence binding');
  }
  if (terminal.executionEpoch !== binding.executionEpoch) {
    fail('invalid-occurrence', 'terminal execution epoch does not match occurrence binding');
  }
  if (terminal.inputArtifactDigest !== binding.inputArtifactDigest) {
    fail('invalid-occurrence', 'terminal input artifact digest does not match occurrence binding');
  }
  if (!terminal.terminalCheckpointRef.trim() || !terminal.settlementReceiptRef.trim()) {
    fail('invalid-occurrence', 'terminal settlement receipt is incomplete');
  }
}

export function decideOccurrenceTerminalReceipt(input: {
  readonly binding: OccurrenceTaskBinding;
  readonly terminalReceipt: ServeTaskTerminalReceipt;
  readonly recoveryResponsibility?: RecoveryResponsibilityRecord;
}): OccurrenceTerminalReceiptDecision {
  sharedTerminalReceiptIdentity(input.terminalReceipt, input.binding);
  if (input.recoveryResponsibility !== undefined) {
    try {
      validateRecoveryResponsibilityRecord(input.recoveryResponsibility);
    } catch (error) {
      throw new SubscriptionControlError(
        'invalid-occurrence',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const verificationStatus = input.terminalReceipt.verification.status;
  const outcome = terminalOutcomeForVerification(verificationStatus);
  const checkpointOutcome = verificationStatus === 'success'
    ? 'succeeded'
    : verificationStatus === 'failed' || verificationStatus === 'rejected'
      ? 'failed'
      : verificationStatus === 'missing' || verificationStatus === 'blocked'
        ? 'blocked'
        : 'cancelled';
  const recoveryRequired = verificationStatus !== 'success'
    && input.recoveryResponsibility?.providerEffectState !== 'confirmed-released';
  const record: OccurrenceTerminalReceiptRecord = {
    kind: 'occurrence-terminal-receipt',
    version: 1,
    binding: input.binding,
    terminalCheckpointRef: input.terminalReceipt.terminalCheckpointRef,
    terminalOutcome: checkpointOutcome,
    verification: input.terminalReceipt.verification,
    ...(input.recoveryResponsibility === undefined ? {} : { recoveryResponsibility: input.recoveryResponsibility }),
    settlementReceiptRef: input.terminalReceipt.settlementReceiptRef,
  };
  try {
    validateOccurrenceTerminalReceiptRecord(record);
  } catch (error) {
    throw new SubscriptionControlError(
      'invalid-occurrence',
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    outcome,
    terminalReceipt: input.terminalReceipt,
    record,
    checkpointOutcome,
    recoveryRequired,
    resourceReleaseConfirmed: input.recoveryResponsibility?.providerEffectState === 'confirmed-released',
  };
}

export function subscriptionRequestFingerprint(request: SubscriptionControlRequest): string {
  return subscriptionControlRequestFingerprint(request);
}

export { policyHash as executionPolicyHash, receiptIdentity };
