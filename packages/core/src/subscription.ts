import {
  canonicalJsonStringify,
  subscriptionControlRequestFingerprint,
  validateExecutionPolicyDefinition,
  validateOccurrence,
  validateOccurrenceClaim,
  validateServeTaskTerminalReceipt,
  validateSubscription,
  validateSubscriptionControlRequest,
  type ExecutionPolicyDefinition,
  type Occurrence,
  type OccurrenceClaim,
  type OperationId,
  type Reminder,
  type ServeTaskTerminalReceipt,
  type Subscription,
  type SubscriptionControlReceipt,
  type SubscriptionControlRequest,
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

export function assertPendingReminderRecoverable(
  subscription: Subscription,
  policy: ExecutionPolicyDefinition,
  occurrence: Occurrence,
  reminders: readonly Reminder[],
  nowAt: string,
): void {
  validateSubscription(subscription);
  validateExecutionPolicyDefinition(policy);
  validateOccurrence(occurrence);
  const now = Date.parse(nowAt);
  if (!Number.isFinite(now)) fail('invalid-occurrence', 'nowAt must be a valid timestamp');
  if (subscription.state !== 'active') fail('invalid-state', `subscription is ${subscription.state}`);
  if (occurrence.subscriptionId !== subscription.subscriptionId) fail('invalid-occurrence', 'occurrence belongs to another subscription');
  if (occurrence.scheduleRevision !== subscription.scheduleRevision) fail('superseded', 'occurrence schedule revision is superseded');
  if (occurrence.state !== 'reminder-pending') fail('invalid-occurrence', `occurrence state ${occurrence.state} is not reminder-pending`);
  const reminder = reminders.find((candidate) => candidate.subscriptionId === occurrence.subscriptionId
    && candidate.scheduleRevision === occurrence.scheduleRevision
    && candidate.occurrenceOrdinal === occurrence.occurrenceOrdinal
    && candidate.dueAt === occurrence.dueAt);
  if (!reminder) fail('invalid-occurrence', 'pending reminder does not match the committed occurrence');
  if (reminder.state !== 'pending') fail('invalid-occurrence', `reminder state ${reminder.state} is not pending`);
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
  try {
    validateServeTaskTerminalReceipt(terminal);
  } catch (error) {
    throw new SubscriptionControlError(
      'invalid-occurrence',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (terminal.taskId.scope !== taskId.scope || terminal.taskId.value !== taskId.value) fail('invalid-occurrence', 'terminal task identity mismatch');
  if (terminal.operationId.scope !== operationId.scope || terminal.operationId.value !== operationId.value) fail('invalid-occurrence', 'terminal operation identity mismatch');
  if (terminal.executionEpoch !== executionEpoch) fail('invalid-occurrence', 'terminal execution epoch mismatch');
  if (terminal.inputArtifactDigest !== inputArtifactDigest) fail('invalid-occurrence', 'terminal input artifact digest mismatch');
  if (terminal.verification.taskId.scope !== taskId.scope || terminal.verification.taskId.value !== taskId.value) fail('invalid-occurrence', 'verification task identity mismatch');
  if (terminal.verification.operationId.scope !== operationId.scope || terminal.verification.operationId.value !== operationId.value) fail('invalid-occurrence', 'verification operation identity mismatch');
  if (terminal.verification.executionEpoch !== executionEpoch) fail('invalid-occurrence', 'verification execution epoch mismatch');
  if (terminal.verification.inputArtifactDigest !== inputArtifactDigest) fail('invalid-occurrence', 'verification input artifact digest mismatch');
  if (terminal.verification.status !== 'success') fail('invalid-occurrence', `task verification is ${terminal.verification.status}`);
  if (!terminal.terminalCheckpointRef.trim() || !terminal.settlementReceiptRef.trim()) fail('invalid-occurrence', 'terminal settlement receipt is incomplete');
}

export function subscriptionRequestFingerprint(request: SubscriptionControlRequest): string {
  return subscriptionControlRequestFingerprint(request);
}

export { policyHash as executionPolicyHash, receiptIdentity };
