import {
  assertOccurrenceClaimFence,
  assertOccurrenceClaimable,
  assertOccurrenceClaimLease,
  assertPendingReminderRecoverable,
  assertVerifiedTerminalReceipt,
  decideSubscriptionControl,
  executionPolicyHash,
  preserveSamePolicyClaimProgress,
  SubscriptionControlError as CoreSubscriptionControlError,
  type SubscriptionControlDecision,
} from '../../../core/src/subscription.js';
import {
  canonicalJsonStringify,
  validateExecutionPolicyDefinition,
  validateOccurrence,
  validateOccurrenceClaim,
  validateReminder,
  validateServeTaskTerminalReceipt,
  validateSubscription,
  validateSubscriptionControlReceipt,
  validateSubscriptionControlRequest,
  type EvidenceRef,
  type ExecutionPolicyDefinition,
  type Occurrence,
  type OccurrenceClaim,
  type OperationId,
  type Reminder,
  type ScopeRef,
  type ServeTaskTerminalReceipt,
  type Subscription,
  type SubscriptionControlReceipt,
  type SubscriptionControlRequest,
  type TaskId,
} from '../../../contracts/src/index.js';
import type { JsonlOrganJournal, JournalAppendInput, JournalRecord } from '../../../adapters/jsonl/src/index.js';

export type { ExecutionPolicyDefinition, Occurrence, OccurrenceClaim, Reminder, ServeTaskTerminalReceipt, Subscription, SubscriptionControlReceipt, SubscriptionControlRequest };

export interface SubscriptionSnapshot {
  readonly subscription: Subscription;
  readonly policy: ExecutionPolicyDefinition;
  readonly policyHash: string;
  readonly receipts: readonly SubscriptionControlReceipt[];
  readonly occurrences: readonly Occurrence[];
  readonly claims: readonly OccurrenceClaimRecord[];
  readonly settlements: readonly OccurrenceSettlementRecord[];
  readonly reminders: readonly Reminder[];
}

export interface OccurrenceClaimRecord extends OccurrenceClaim {
  readonly policyRevision: number;
  readonly policyHash: string;
  readonly policy: ExecutionPolicyDefinition;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly inputArtifactDigest: string;
}

export interface OccurrenceSettlementRecord {
  readonly occurrence: Occurrence;
  readonly terminal: ServeTaskTerminalReceipt;
}

export interface ScheduledOccurrenceClaimInput {
  readonly subscriptionId: string;
  readonly scheduleRevision: number;
  readonly occurrenceOrdinal: number;
  readonly dueAt: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly inputArtifactDigest: string;
  readonly schedulerInstanceId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly executionEpoch: number;
  readonly nowAt: string;
  readonly leaseUntil: string;
}

export interface ScheduledOccurrenceInput {
  readonly occurrence: Occurrence;
  readonly nowAt: string;
  readonly taskId?: TaskId;
  readonly operationId?: OperationId;
  readonly inputArtifactDigest?: string;
  readonly executionEpoch?: number;
  readonly busy?: boolean;
}

export interface NextOccurrenceInput {
  readonly subscription: Subscription;
  readonly policy: ExecutionPolicyDefinition;
  readonly nowAt: string;
  readonly busy?: boolean;
}

export interface ServeTaskConsumerPort {
  executeOccurrence(input: {
    readonly occurrence: Occurrence;
    readonly policy: ExecutionPolicyDefinition;
    readonly claim: OccurrenceClaimRecord;
  }): Promise<ServeTaskTerminalReceipt>;
}

export class SubscriptionSchedulerError extends Error {
  readonly code:
    | 'not-found'
    | 'stale-revision'
    | 'superseded'
    | 'lease-expired'
    | 'lease-generation'
    | 'busy'
    | 'late-skipped'
    | 'exhausted'
    | 'invalid-transition'
    | 'invalid-occurrence'
    | 'serve-task-pending'
    | 'verification-rejected';

  constructor(code: SubscriptionSchedulerError['code'], message: string) {
    super(message);
    this.name = 'SubscriptionSchedulerError';
    this.code = code;
  }
}

export class SubscriptionControlError extends Error {
  readonly code: 'not-found' | 'stale-revision' | 'conflict' | 'invalid-state' | 'policy-hash-mismatch';

  constructor(code: SubscriptionControlError['code'], message: string) {
    super(message);
    this.name = 'SubscriptionControlError';
    this.code = code;
  }
}

interface PersistedState {
  readonly version: 1;
  readonly subscriptions: Record<string, SubscriptionSnapshot>;
}

const EMPTY: PersistedState = { version: 1, subscriptions: {} };

function cloneState<T>(value: T): T {
  return structuredClone(value);
}

function key(subscriptionId: string): string {
  return subscriptionId;
}

function stateFromJournal(records: readonly { readonly payload?: Record<string, unknown> }[]): PersistedState {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = records[index]?.payload;
    if (payload?.type === 'subscription-state' && payload.state) {
      const state = payload.state as PersistedState;
      if (state.version !== 1 || !state.subscriptions || typeof state.subscriptions !== 'object') {
        throw new SubscriptionSchedulerError('invalid-transition', 'subscription journal state is invalid');
      }
      return cloneState(state);
    }
  }
  return cloneState(EMPTY);
}

function normalizeSnapshot(input: SubscriptionSnapshot): SubscriptionSnapshot {
  const normalized = { ...input, settlements: input.settlements ?? [] as readonly OccurrenceSettlementRecord[] };
  validateSubscription(normalized.subscription);
  validateExecutionPolicyDefinition(normalized.policy);
  if (normalized.policyHash !== executionPolicyHash(normalized.policy)) {
    throw new SubscriptionSchedulerError('invalid-transition', 'subscription policy hash does not match the persisted policy');
  }
  for (const receipt of normalized.receipts) validateSubscriptionControlReceipt(receipt);
  for (const occurrence of normalized.occurrences) validateOccurrence(occurrence);
  for (const claim of normalized.claims) validateOccurrenceClaim(claim);
  for (const settlement of normalized.settlements) {
    validateOccurrence(settlement.occurrence);
    validateServeTaskTerminalReceipt(settlement.terminal);
  }
  for (const reminder of normalized.reminders) validateReminder(reminder);
  return cloneState(normalized);
}

function stateVersion(state: PersistedState): string {
  return canonicalJsonStringify(state);
}

function generatedOccurrenceId(subscriptionId: string, scheduleRevision: number, occurrenceOrdinal: number): string {
  return `${subscriptionId}::${scheduleRevision}::${occurrenceOrdinal}`;
}

export { executionPolicyHash };

function assertPositiveOrdinal(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SubscriptionSchedulerError('invalid-occurrence', `${label} must be a positive safe integer`);
  }
}

function assertValidServeTaskTerminalReceipt(terminal: ServeTaskTerminalReceipt): void {
  try {
    validateServeTaskTerminalReceipt(terminal);
  } catch (error) {
    throw new SubscriptionSchedulerError(
      'verification-rejected',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function applyOccurrence(existing: readonly Occurrence[], next: Occurrence): readonly Occurrence[] {
  const id = next.occurrenceId ?? generatedOccurrenceId(next.subscriptionId, next.scheduleRevision, next.occurrenceOrdinal);
  const index = existing.findIndex((occurrence) => occurrence.occurrenceId === id);
  if (index < 0) return [...existing, { ...next, occurrenceId: id }];
  return existing.map((occurrence, current) => current === index ? { ...occurrence, ...next, occurrenceId: id } : occurrence);
}

function applyOccurrences(existing: readonly Occurrence[], next: readonly Occurrence[]): readonly Occurrence[] {
  return next.reduce((occurrences, occurrence) => applyOccurrence(occurrences, occurrence), existing);
}

function findOccurrence(snapshot: SubscriptionSnapshot, occurrenceId: string): Occurrence | undefined {
  return snapshot.occurrences.find((occurrence) => occurrence.occurrenceId === occurrenceId);
}

interface PolicySlot {
  readonly ordinal: number;
  readonly dueAt: string;
}

function* policySlotEntries(policy: ExecutionPolicyDefinition): Generator<PolicySlot> {
  const max = policyMaxOccurrences(policy);
  if (policy.executionMode === 'recurring') {
    let ordinal = 0;
    for (const dueAt of recurringDueTimeEntries(policy)) {
      ordinal += 1;
      if (max !== undefined && ordinal > max) break;
      yield { ordinal, dueAt };
    }
    return;
  }
  if (max !== undefined && max < 1) return;
  const dueAt = policy.executionMode === 'once' ? policy.dueAt : policy.startAt;
  if (policy.executionMode !== 'once' && policy.endAt !== undefined && Date.parse(dueAt) >= Date.parse(policy.endAt)) return;
  yield { ordinal: 1, dueAt };
}

function policySlotOrdinal(policy: ExecutionPolicyDefinition, dueAt: string): number {
  const target = Date.parse(dueAt);
  if (!Number.isFinite(target)) throw new SubscriptionSchedulerError('invalid-occurrence', 'claim dueAt is invalid');
  for (const slot of policySlotEntries(policy)) {
    const candidateAt = Date.parse(slot.dueAt);
    if (candidateAt === target) return slot.ordinal;
    if (candidateAt > target) break;
  }
  throw new SubscriptionSchedulerError('invalid-occurrence', 'claim dueAt is not part of the committed schedule');
}

function nextPolicySlotAfter(policy: ExecutionPolicyDefinition, ordinal: number): PolicySlot | undefined {
  for (const slot of policySlotEntries(policy)) {
    if (slot.ordinal > ordinal) return slot;
  }
  return undefined;
}

function latestDuePolicySlot(
  policy: ExecutionPolicyDefinition,
  nowAt: string,
  afterOrdinal = 0,
): PolicySlot | undefined {
  const now = Date.parse(nowAt);
  if (!Number.isFinite(now)) throw new SubscriptionSchedulerError('invalid-occurrence', 'nowAt must be a valid timestamp');
  let latest: PolicySlot | undefined;
  for (const slot of policySlotEntries(policy)) {
    if (slot.ordinal <= afterOrdinal) continue;
    const candidateAt = Date.parse(slot.dueAt);
    if (candidateAt > now + 1_000) break;
    latest = slot;
  }
  return latest;
}

function wallTimeToInstant(
  timezone: string,
  localAt: string,
  dstMode: 'wall' | 'absolute',
  firstInstantAtOrAfter?: string,
): string {
  if (dstMode === 'absolute') {
    const parsed = Date.parse(`${localAt}Z`);
    if (!Number.isFinite(parsed)) throw new SubscriptionSchedulerError('invalid-occurrence', 'absolute dueAt is invalid');
    return new Date(parsed).toISOString();
  }

  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(localAt);
  if (!match) throw new SubscriptionSchedulerError('invalid-occurrence', 'wall time must be YYYY-MM-DDTHH:mm');
  const [, date, hour, minute] = match;
  const desiredUtc = Date.parse(`${date}T${hour}:${minute}:00.000Z`);
  if (!Number.isFinite(desiredUtc)) throw new SubscriptionSchedulerError('invalid-occurrence', 'wall time is invalid');

  const partsAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return {
      date: `${value('year')}-${value('month')}-${value('day')}`,
      hour: value('hour'),
      minute: value('minute'),
    };
  };
  const isValidWallTime = (instant: number) => {
    const parts = partsAt(instant);
    return parts.date === date && parts.hour === hour && parts.minute === minute;
  };

  const matches: number[] = [];
  // IANA offsets are bounded by +/-14 hours; a one-hour margin covers
  // historical offset changes without scanning two full days per lookup.
  const offsetSearchMs = 15 * 60 * 60_000;
  for (let delta = -offsetSearchMs - 60 * 60_000; delta <= offsetSearchMs + 60 * 60_000; delta += 60_000) {
    const instant = desiredUtc + delta;
    if (isValidWallTime(instant)) matches.push(instant);
  }

  const instants = matches.sort((left, right) => left - right);
  if (instants.length === 0) {
    const threshold = firstInstantAtOrAfter ? Date.parse(firstInstantAtOrAfter) : desiredUtc;
    // The requested local time is in a DST gap. Move the wall clock forward
    // minute by minute until the first valid instant on the same local day.
    for (let wallMinute = 1; wallMinute <= 24 * 60; wallMinute += 1) {
      const candidateWall = desiredUtc + wallMinute * 60_000;
      const candidateParts = new Date(candidateWall).toISOString();
      const candidateDate = candidateParts.slice(0, 10);
      const candidateHour = candidateParts.slice(11, 13);
      const candidateMinute = candidateParts.slice(14, 16);
      if (candidateDate !== date) break;
      for (let delta = -offsetSearchMs; delta <= offsetSearchMs; delta += 60_000) {
        const instant = candidateWall + delta;
        const parts = partsAt(instant);
        if (parts.date === date && parts.hour === candidateHour && parts.minute === candidateMinute && instant >= threshold) {
          return new Date(instant).toISOString();
        }
      }
    }
    throw new SubscriptionSchedulerError('invalid-occurrence', 'wall time cannot be resolved');
  }
  return new Date(instants[0]!).toISOString();
}

export class SubscriptionControlPort {
  constructor(
    private readonly journal: JsonlOrganJournal,
    private readonly scope: ScopeRef,
    private readonly filePath: string,
    private readonly serveTask?: ServeTaskConsumerPort,
  ) {}

  async create(
    subscription: Subscription,
    policy: ExecutionPolicyDefinition,
    subscriptionId = subscription.subscriptionId,
  ): Promise<SubscriptionSnapshot> {
    const normalizedSubscription = { ...subscription, subscriptionId };
    validateSubscription(normalizedSubscription);
    validateExecutionPolicyDefinition(policy);
    return this.transaction(async (state, append) => {
      if (state.subscriptions[subscriptionId]) {
        throw new SubscriptionControlError('conflict', `subscription already exists: ${subscriptionId}`);
      }
      const snapshot = normalizeSnapshot({
        subscription: normalizedSubscription,
        policy,
        policyHash: executionPolicyHash(policy),
        receipts: [],
        occurrences: [],
        claims: [],
        settlements: [],
        reminders: [],
      });
      state.subscriptions[subscriptionId] = snapshot;
      await append(this.record(state));
      return snapshot;
    });
  }

  async snapshot(subscriptionId: string): Promise<SubscriptionSnapshot> {
    const state = await this.read();
    const snapshot = state.subscriptions[key(subscriptionId)];
    if (!snapshot) throw new SubscriptionControlError('not-found', `subscription not found: ${subscriptionId}`);
    return normalizeSnapshot(snapshot);
  }

  async receipt(idempotencyKey: string): Promise<SubscriptionControlReceipt> {
    const state = await this.read();
    for (const snapshot of Object.values(state.subscriptions)) {
      const found = snapshot.receipts.find((receipt) => receipt.idempotencyKey === idempotencyKey);
      if (found) return cloneState(found);
    }
    throw new SubscriptionControlError('not-found', `control receipt not found: ${idempotencyKey}`);
  }

  async control(request: SubscriptionControlRequest): Promise<SubscriptionControlReceipt> {
    validateSubscriptionControlRequest(request);
    return this.transaction(async (state, append) => {
      const snapshot = state.subscriptions[key(request.subscriptionId)];
      if (!snapshot) throw new SubscriptionControlError('not-found', `subscription not found: ${request.subscriptionId}`);
      let decision: SubscriptionControlDecision;
      try {
        decision = decideSubscriptionControl(
          snapshot.subscription,
          snapshot.policy,
          snapshot.policyHash,
          snapshot.occurrences,
          Object.fromEntries(snapshot.receipts.map((receipt) => [receipt.idempotencyKey, receipt])),
          request,
        );
      } catch (error) {
        if (error instanceof CoreSubscriptionControlError) {
          const code = error.code === 'stale-revision' ? 'stale-revision'
            : error.code === 'invalid-state' || error.code === 'invalid-transition' ? 'invalid-state'
              : error.code === 'policy-hash-mismatch' ? 'policy-hash-mismatch'
                : 'conflict';
          throw new SubscriptionControlError(code, error.message);
        }
        throw error;
      }
      if (decision.status !== 'applied') {
        state.subscriptions[key(request.subscriptionId)] = snapshot;
        return decision.receipt;
      }
      const next = normalizeSnapshot({
        ...snapshot,
        subscription: decision.subscription,
        policy: decision.policy,
        policyHash: decision.policyHash,
        receipts: [...snapshot.receipts, decision.receipt],
        occurrences: applyOccurrences(snapshot.occurrences, decision.superseded),
        reminders: snapshot.reminders.map((reminder) => decision.superseded.some((occurrence) => occurrence.subscriptionId === reminder.subscriptionId
          && occurrence.scheduleRevision === reminder.scheduleRevision
          && occurrence.occurrenceOrdinal === reminder.occurrenceOrdinal
          && occurrence.dueAt === reminder.dueAt) && reminder.state === 'pending'
            ? { ...reminder, state: 'invalidated' as const }
            : reminder),
      });
      state.subscriptions[key(request.subscriptionId)] = next;
      await append(this.record(state));
      return decision.receipt;
    });
  }

  async claim(input: ScheduledOccurrenceClaimInput): Promise<OccurrenceClaimRecord> {
    assertPositiveOrdinal(input.occurrenceOrdinal, 'occurrenceOrdinal');
    assertPositiveOrdinal(input.generation, 'generation');
    assertPositiveOrdinal(input.executionEpoch, 'executionEpoch');
    const acquiredAt = input.nowAt;
    if (Date.parse(input.leaseUntil) <= Date.parse(acquiredAt)) {
      throw new SubscriptionSchedulerError('lease-expired', 'lease expiration must be after acquisition');
    }
    return this.transaction(async (state, append) => {
      const snapshot = state.subscriptions[key(input.subscriptionId)];
      if (!snapshot) throw new SubscriptionSchedulerError('not-found', `subscription not found: ${input.subscriptionId}`);
      const expectedOrdinal = policySlotOrdinal(snapshot.policy, input.dueAt);
      if (expectedOrdinal !== input.occurrenceOrdinal) {
        throw new SubscriptionSchedulerError('invalid-occurrence', 'claim ordinal does not match the committed policy slot');
      }
      const occurrenceId = generatedOccurrenceId(input.subscriptionId, input.scheduleRevision, input.occurrenceOrdinal);
      const occurrence = findOccurrence(snapshot, occurrenceId) ?? {
        occurrenceId,
        subscriptionId: input.subscriptionId,
        scheduleRevision: input.scheduleRevision,
        occurrenceOrdinal: input.occurrenceOrdinal,
        state: 'due' as const,
        dueAt: input.dueAt,
      };
      if (occurrence.dueAt !== input.dueAt) {
        throw new SubscriptionSchedulerError('invalid-occurrence', 'claim dueAt does not match the persisted occurrence');
      }
      const current = snapshot.claims.find((claim) => claim.occurrenceId === occurrenceId);
      if (current) {
        if (snapshot.subscription.scheduleRevision !== input.scheduleRevision) {
          throw new SubscriptionSchedulerError('superseded', 'claim schedule revision is stale');
        }
        if (current.generation !== input.generation) throw new SubscriptionSchedulerError('lease-generation', 'claim generation is stale');
        if (current.executionEpoch !== input.executionEpoch) throw new SubscriptionSchedulerError('lease-generation', 'claim execution epoch is stale');
        if (current.leaseId !== input.leaseId || current.schedulerInstanceId !== input.schedulerInstanceId) {
          throw new SubscriptionSchedulerError('lease-generation', 'claim lease identity is stale');
        }
        if (current.taskId.scope !== input.taskId.scope
          || current.taskId.value !== input.taskId.value
          || current.operationId.scope !== input.operationId.scope
          || current.operationId.value !== input.operationId.value
          || current.inputArtifactDigest !== input.inputArtifactDigest) {
          throw new SubscriptionSchedulerError('invalid-occurrence', 'claim execution identity is stale');
        }
        try {
          assertOccurrenceClaimFence(snapshot.subscription, snapshot.policy, current, input.nowAt);
        } catch (error) {
          if (error instanceof CoreSubscriptionControlError) {
            const code = error.code === 'lease-expired' ? 'lease-expired' : error.code === 'superseded' ? 'superseded' : 'invalid-occurrence';
            throw new SubscriptionSchedulerError(code, error.message);
          }
          throw error;
        }
        return cloneState(current);
      }
      try {
        assertOccurrenceClaimable(snapshot.subscription, snapshot.policy, occurrence, input.nowAt);
      } catch (error) {
        if (error instanceof CoreSubscriptionControlError) {
          const code = error.code === 'superseded' ? 'superseded' : error.code === 'stale-revision' ? 'stale-revision' : 'invalid-occurrence';
          throw new SubscriptionSchedulerError(code, error.message);
        }
        throw error;
      }
      const claim: OccurrenceClaimRecord = {
        occurrenceId,
        subscriptionId: input.subscriptionId,
        scheduleRevision: input.scheduleRevision,
        occurrenceOrdinal: input.occurrenceOrdinal,
        claimedBy: input.schedulerInstanceId,
        leaseId: input.leaseId,
        schedulerInstanceId: input.schedulerInstanceId,
        generation: input.generation,
        executionEpoch: input.executionEpoch,
        acquiredAt,
        expiresAt: input.leaseUntil,
        policyRevision: snapshot.policy.policyRevision,
        policyHash: snapshot.policyHash,
        policy: cloneState(snapshot.policy),
        taskId: cloneState(input.taskId),
        operationId: cloneState(input.operationId),
        inputArtifactDigest: input.inputArtifactDigest,
      };
      const next = normalizeSnapshot({
        ...snapshot,
        occurrences: applyOccurrence(snapshot.occurrences, { ...occurrence, state: 'claimed' }),
        claims: [...snapshot.claims, claim],
      });
      state.subscriptions[key(input.subscriptionId)] = next;
      await append(this.record(state));
      return claim;
    });
  }

  async claimRecord(occurrenceId: string): Promise<OccurrenceClaimRecord> {
    const state = await this.read();
    for (const snapshot of Object.values(state.subscriptions)) {
      const found = snapshot.claims.find((claim) => claim.occurrenceId === occurrenceId);
      if (found) return cloneState(found);
    }
    throw new SubscriptionSchedulerError('not-found', `claim not found: ${occurrenceId}`);
  }

  async settleOccurrence(input: {
    readonly occurrenceId: string;
    readonly terminal: ServeTaskTerminalReceipt;
  }): Promise<OccurrenceSettlementRecord> {
    assertValidServeTaskTerminalReceipt(input.terminal);
    return this.transaction(async (state, append) => {
      for (const [subscriptionId, snapshot] of Object.entries(state.subscriptions)) {
        const occurrence = findOccurrence(snapshot, input.occurrenceId);
        if (!occurrence) continue;
        const settled = snapshot.settlements.find((candidate) => candidate.occurrence.occurrenceId === input.occurrenceId);
        if (settled) {
          if (settled.terminal.taskId.scope !== input.terminal.taskId.scope
            || settled.terminal.taskId.value !== input.terminal.taskId.value
            || settled.terminal.operationId.scope !== input.terminal.operationId.scope
            || settled.terminal.operationId.value !== input.terminal.operationId.value
            || settled.terminal.executionEpoch !== input.terminal.executionEpoch
            || settled.terminal.inputArtifactDigest !== input.terminal.inputArtifactDigest
            || canonicalJsonStringify(settled.terminal) !== canonicalJsonStringify(input.terminal)) {
            throw new SubscriptionSchedulerError('verification-rejected', 'settlement does not match the committed terminal receipt');
          }
          return cloneState(settled);
        }
        const claim = snapshot.claims.find((candidate) => candidate.occurrenceId === input.occurrenceId);
        if (!claim) throw new SubscriptionSchedulerError('invalid-occurrence', 'occurrence has not been claimed');
        if (occurrence.state !== 'claimed') throw new SubscriptionSchedulerError('invalid-occurrence', `occurrence is ${occurrence.state}`);
        try {
          assertVerifiedTerminalReceipt({
            occurrence,
            taskId: claim.taskId,
            operationId: claim.operationId,
            executionEpoch: claim.executionEpoch,
            inputArtifactDigest: claim.inputArtifactDigest,
            terminal: input.terminal,
          });
        } catch (error) {
          if (error instanceof CoreSubscriptionControlError) throw new SubscriptionSchedulerError('verification-rejected', error.message);
          throw error;
        }
        const consumed: Occurrence = { ...occurrence, state: 'consumed' };
        const settlementRecord: OccurrenceSettlementRecord = {
          occurrence: cloneState(consumed),
          terminal: cloneState(input.terminal),
        };
        const max = policyMaxOccurrences(claim.policy);
        const nextSubscription = preserveSamePolicyClaimProgress(
          snapshot.subscription,
          claim,
          snapshot.policyHash,
          occurrence.occurrenceOrdinal,
          snapshot.receipts,
          max,
        );
        const next = normalizeSnapshot({
          ...snapshot,
          subscription: nextSubscription,
          occurrences: applyOccurrence(snapshot.occurrences, consumed),
          settlements: [...snapshot.settlements, settlementRecord],
        });
        state.subscriptions[subscriptionId] = next;
        await append(this.record(state));
        return cloneState(settlementRecord);
      }
      throw new SubscriptionSchedulerError('not-found', `occurrence not found: ${input.occurrenceId}`);
    });
  }

  async claims(): Promise<readonly OccurrenceClaimRecord[]> {
    const state = await this.read();
    return Object.values(state.subscriptions).flatMap((snapshot) => snapshot.claims.map((claim) => cloneState(claim)));
  }

  async settlements(): Promise<readonly OccurrenceSettlementRecord[]> {
    const state = await this.read();
    return Object.values(state.subscriptions).flatMap((snapshot) => snapshot.settlements.map((settlement) => cloneState(settlement)));
  }

  async schedule(input: ScheduledOccurrenceInput): Promise<Occurrence> {
    validateOccurrence(input.occurrence);
    return this.transaction(async (state, append) => {
      const snapshot = state.subscriptions[key(input.occurrence.subscriptionId)];
      if (!snapshot) throw new SubscriptionSchedulerError('not-found', `subscription not found: ${input.occurrence.subscriptionId}`);
      const subscription = snapshot.subscription;
      if (input.occurrence.scheduleRevision !== subscription.scheduleRevision) {
        throw new SubscriptionSchedulerError('stale-revision', 'occurrence schedule revision is stale');
      }
      const expectedOrdinal = policySlotOrdinal(snapshot.policy, input.occurrence.dueAt);
      const occurrenceId = generatedOccurrenceId(input.occurrence.subscriptionId, input.occurrence.scheduleRevision, expectedOrdinal);
      const existing = findOccurrence(snapshot, occurrenceId);
      if (existing) {
        if (existing.dueAt !== input.occurrence.dueAt
          || policySlotOrdinal(snapshot.policy, existing.dueAt) !== existing.occurrenceOrdinal) {
          throw new SubscriptionSchedulerError('invalid-occurrence', 'occurrence does not match the committed policy slot');
        }
        if (!input.busy && existing.state === 'reminder-pending') {
          let recovered: Occurrence;
          let closed: boolean;
          let nextReminders = snapshot.reminders;
          try {
            assertPendingReminderRecoverable(subscription, snapshot.policy, existing, snapshot.reminders, input.nowAt);
            recovered = { ...existing, state: 'due' };
            closed = false;
            nextReminders = snapshot.reminders.map((reminder) => reminder.subscriptionId === existing.subscriptionId
              && reminder.scheduleRevision === existing.scheduleRevision
              && reminder.occurrenceOrdinal === existing.occurrenceOrdinal
              && reminder.dueAt === existing.dueAt
                ? { ...reminder, state: 'consumed' as const }
                : reminder);
          } catch (error) {
            if (error instanceof CoreSubscriptionControlError) {
              throw new SubscriptionSchedulerError(error.code === 'superseded' ? 'superseded' : 'invalid-occurrence', error.message);
            }
            throw error;
          }
          if (snapshot.policy.latePolicy === 'skip' && Date.parse(existing.dueAt) < Date.parse(input.nowAt)) {
            recovered = { ...existing, state: 'skipped-busy' };
            closed = true;
            nextReminders = snapshot.reminders.map((reminder) => reminder.subscriptionId === existing.subscriptionId
              && reminder.scheduleRevision === existing.scheduleRevision
              && reminder.occurrenceOrdinal === existing.occurrenceOrdinal
              && reminder.dueAt === existing.dueAt
                ? { ...reminder, state: 'invalidated' as const }
                : reminder);
          }
          const nextCurrentOccurrenceOrdinal = closed
            ? Math.max(subscription.currentOccurrenceOrdinal, existing.occurrenceOrdinal)
            : subscription.currentOccurrenceOrdinal;
          const max = policyMaxOccurrences(snapshot.policy);
          const next: SubscriptionSnapshot = normalizeSnapshot({
            ...snapshot,
            subscription: {
              ...subscription,
              currentOccurrenceOrdinal: nextCurrentOccurrenceOrdinal,
              state: closed && max !== undefined && nextCurrentOccurrenceOrdinal >= max
                ? 'exhausted' as const
                : subscription.state,
            },
            occurrences: applyOccurrence(snapshot.occurrences, recovered),
            reminders: nextReminders,
          });
          state.subscriptions[key(input.occurrence.subscriptionId)] = next;
          await append(this.record(state));
          return cloneState(recovered);
        }
        return cloneState(existing);
      }
      if (subscription.state !== 'active') throw new SubscriptionSchedulerError('invalid-transition', `subscription is ${subscription.state}`);
      if (expectedOrdinal <= subscription.currentOccurrenceOrdinal) {
        throw new SubscriptionSchedulerError('invalid-occurrence', 'occurrence ordinal has already been consumed');
      }
      const max = policyMaxOccurrences(snapshot.policy);
      if (max !== undefined && expectedOrdinal > max) throw new SubscriptionSchedulerError('exhausted', 'subscription occurrence limit is exhausted');
      const late = Date.parse(input.occurrence.dueAt) < Date.parse(input.nowAt);
      const busy = input.busy === true;
      let nextOccurrence: Occurrence = {
        ...input.occurrence,
        occurrenceId,
        occurrenceOrdinal: expectedOrdinal,
        state: 'due',
      };
      let nextReminders = snapshot.reminders;
      if (late && snapshot.policy.latePolicy === 'skip') {
        nextOccurrence = { ...nextOccurrence, state: 'skipped-busy' };
      } else if (busy && snapshot.policy.busyPolicy === 'skip') {
        nextOccurrence = { ...nextOccurrence, state: 'skipped-busy' };
      } else if (busy && snapshot.policy.busyPolicy === 'idle-reminder') {
        nextOccurrence = { ...nextOccurrence, state: 'reminder-pending' };
        const reminderId = `reminder:${input.occurrence.subscriptionId}`;
        const reminder = {
          reminderId,
          subscriptionId: input.occurrence.subscriptionId,
          scheduleRevision: input.occurrence.scheduleRevision,
          occurrenceOrdinal: expectedOrdinal,
          state: 'pending' as const,
          dueAt: input.occurrence.dueAt,
        };
        const pendingIndex = snapshot.reminders.findIndex((candidate) => candidate.subscriptionId === input.occurrence.subscriptionId
          && candidate.state === 'pending');
        const stableIndex = snapshot.reminders.findIndex((candidate) => candidate.reminderId === reminderId);
        if (pendingIndex >= 0) {
          nextReminders = snapshot.reminders.map((candidate, index) => index === pendingIndex ? reminder : candidate);
        } else if (stableIndex >= 0) {
          nextReminders = snapshot.reminders.map((candidate, index) => index === stableIndex ? reminder : candidate);
        } else {
          nextReminders = [...snapshot.reminders, reminder];
        }
      }
      const consumedOrdinal = nextOccurrence.state === 'skipped-busy';
      const recoverySkipped = snapshot.policy.latePolicy === 'run-once'
        && expectedOrdinal > subscription.currentOccurrenceOrdinal + 1;
      const currentOccurrenceOrdinal = consumedOrdinal
        ? Math.max(subscription.currentOccurrenceOrdinal, expectedOrdinal)
        : recoverySkipped
          ? expectedOrdinal - 1
          : subscription.currentOccurrenceOrdinal;
      const exhausted = consumedOrdinal && max !== undefined && currentOccurrenceOrdinal >= max;
      const nextSubscription: Subscription = {
        ...subscription,
        currentOccurrenceOrdinal,
        state: exhausted ? 'exhausted' : subscription.state,
      };
      const next = normalizeSnapshot({
        ...snapshot,
        subscription: nextSubscription,
        occurrences: applyOccurrence(snapshot.occurrences, nextOccurrence),
        reminders: nextReminders,
      });
      state.subscriptions[key(input.occurrence.subscriptionId)] = next;
      await append(this.record(state));
      return nextOccurrence;
    });
  }

  async nextOccurrence(input: NextOccurrenceInput): Promise<Occurrence> {
    return this.schedule(computeOccurrence(input));
  }

  async scheduleOnce(input: ScheduledOccurrenceInput): Promise<Occurrence> {
    return this.schedule(input);
  }

  async nextDue(timezone: string, localAt: string, firstInstantAtOrAfter?: string): Promise<string> {
    return wallTimeToInstant(timezone, localAt, 'wall', firstInstantAtOrAfter);
  }

  async dueTimes(input: {
    readonly policy: ExecutionPolicyDefinition;
    readonly nowAt: string;
    readonly count: number;
  }): Promise<readonly string[]> {
    validateExecutionPolicyDefinition(input.policy);
    if (!Number.isSafeInteger(input.count) || input.count < 1) {
      throw new SubscriptionSchedulerError('invalid-occurrence', 'dueTimes count must be a positive safe integer');
    }
    const now = Date.parse(input.nowAt);
    if (!Number.isFinite(now)) throw new SubscriptionSchedulerError('invalid-occurrence', 'nowAt must be a valid timestamp');

    const isDue = (instant: number): boolean => instant <= now + 1_000;
    if (input.policy.executionMode === 'once') {
      return isDue(Date.parse(input.policy.dueAt)) ? [input.policy.dueAt] : [];
    }
    if (input.policy.executionMode === 'scheduled') {
      const due = Date.parse(input.policy.startAt);
      const end = input.policy.endAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(input.policy.endAt);
      return isDue(due) && due < end ? [input.policy.startAt] : [];
    }

    const due: string[] = [];
    for (const slot of policySlotEntries(input.policy)) {
      if (!isDue(Date.parse(slot.dueAt))) break;
      due.push(slot.dueAt);
    }
    return due.slice(-input.count);
  }

  async consumeExecution(occurrenceId: string, claim?: OccurrenceClaimRecord): Promise<ServeTaskTerminalReceipt> {
    if (!this.serveTask) {
      throw new SubscriptionSchedulerError('serve-task-pending', 'execute_occurrence_task requires W3 humanagent-serve-task@2 bridge');
    }
    if (!claim) throw new SubscriptionSchedulerError('invalid-occurrence', 'occurrence claim is required before execution');
    const persisted = await this.claimRecord(occurrenceId);
    if (canonicalJsonStringify(persisted) !== canonicalJsonStringify(claim)) {
      throw new SubscriptionSchedulerError('lease-generation', 'execution claim does not match the persisted claim authority');
    }
    const state = await this.read();
    const snapshot = Object.values(state.subscriptions).find((candidate) => candidate.claims.some((item) => item.occurrenceId === occurrenceId));
    if (!snapshot) throw new SubscriptionSchedulerError('not-found', `claim not found: ${occurrenceId}`);
    const settlement = snapshot.settlements.find((candidate) => candidate.occurrence.occurrenceId === occurrenceId);
    if (settlement) return cloneState(settlement.terminal);
    try {
      assertOccurrenceClaimLease(persisted, new Date().toISOString());
    } catch (error) {
      if (error instanceof CoreSubscriptionControlError) {
        const code = error.code === 'lease-expired' ? 'lease-expired' : 'invalid-occurrence';
        throw new SubscriptionSchedulerError(code, error.message);
      }
      throw error;
    }
    const occurrence = findOccurrence(snapshot, claim.occurrenceId);
    if (!occurrence) throw new SubscriptionSchedulerError('not-found', 'claimed occurrence was not found');
    return this.serveTask.executeOccurrence({
      occurrence: {
        ...cloneState(occurrence),
        state: 'claimed',
      },
      policy: cloneState(claim.policy),
      claim: cloneState(claim),
    });
  }

  private async read(): Promise<PersistedState> {
    const verification = await this.journal.verify();
    if (!verification.valid) throw new SubscriptionSchedulerError('invalid-transition', verification.error ?? 'subscription journal is invalid');
    return stateFromJournal(verification.records);
  }

  private async transaction<T>(
    work: (state: PersistedState, append: (input: { readonly commitId: string; readonly kind: 'event'; readonly scope: ScopeRef; readonly payload: Record<string, unknown> }) => Promise<unknown>) => Promise<T>,
  ): Promise<T> {
    return this.journal.transaction(
      ({ records }) => stateFromJournal(records),
      async (state, append) => work(state, (input) => append(input)),
    );
  }

  private record(state: PersistedState): { readonly commitId: string; readonly kind: 'event'; readonly scope: ScopeRef; readonly payload: Record<string, unknown> } {
    const commitId = `subscription-state-${createDigest(stateVersion(state))}`;
    return {
      commitId,
      kind: 'event',
      scope: this.scope,
      payload: { type: 'subscription-state', state: cloneState(state) },
    };
  }
}

function createDigest(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function policyMaxOccurrences(policy: ExecutionPolicyDefinition): number | undefined {
  return policy.executionMode === 'once' ? 1 : policy.maxOccurrences;
}

function nextCalendarDate(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) throw new SubscriptionSchedulerError('invalid-occurrence', 'calendar date is invalid');
  return new Date(parsed + 24 * 60 * 60_000).toISOString().slice(0, 10);
}

function* recurringDueTimeEntries(
  policy: Extract<ExecutionPolicyDefinition, { readonly executionMode: 'recurring' }>,
): Generator<string> {
  const end = policy.endAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(policy.endAt);
  if (policy.frequency === 'interval') {
    const start = Date.parse(policy.startAt);
    for (let ordinal = 1; ; ordinal += 1) {
      const due = start + (ordinal - 1) * policy.intervalMinutes! * 60_000;
      if (due >= end) break;
      yield new Date(due).toISOString();
    }
    return;
  }

  const [hourText, minuteText] = policy.timeOfDay!.split(':');
  const start = Date.parse(policy.startAt);
  const weekDays = policy.frequency === 'weekly' ? new Set(policy.weekDays!) : undefined;
  const calendar = new Intl.DateTimeFormat('en-CA', {
    timeZone: policy.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const values = (instant: number): Record<string, string> => Object.fromEntries(
    calendar.formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const calendarDate = (instant: number): string => {
    const value = values(instant);
    return `${value.year}-${value.month}-${value.day}`;
  };
  let localDate = calendarDate(start);
  // No calendar horizon: policy end/max and each caller stop iteration.
  for (let day = 0; ; day += 1) {
    const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
    if (!weekDays || weekDays.has(weekday)) {
      const due = Date.parse(wallTimeToInstant(
        policy.timezone,
        `${localDate}T${hourText}:${minuteText}`,
        policy.dstMode,
      ));
      if (due >= end) break;
      if (due >= start) yield new Date(due).toISOString();
    }
    localDate = nextCalendarDate(localDate);
  }
}

function computeOccurrence(input: NextOccurrenceInput): ScheduledOccurrenceInput {
  const { subscription, policy, nowAt, busy } = input;
  validateSubscription(subscription);
  validateExecutionPolicyDefinition(policy);
  const now = Date.parse(nowAt);
  if (!Number.isFinite(now)) throw new SubscriptionSchedulerError('invalid-occurrence', 'nowAt must be a valid timestamp');
  const latest = policy.latePolicy === 'run-once'
    ? latestDuePolicySlot(policy, nowAt, subscription.currentOccurrenceOrdinal)
    : undefined;
  const slot = latest ?? nextPolicySlotAfter(policy, subscription.currentOccurrenceOrdinal);
  if (slot === undefined) throw new SubscriptionSchedulerError('exhausted', 'subscription has no further occurrence');
  const { ordinal, dueAt } = slot;
  if (policy.executionMode !== 'once' && policy.endAt !== undefined) {
    if (Date.parse(dueAt) >= Date.parse(policy.endAt)) {
      throw new SubscriptionSchedulerError('exhausted', 'subscription end has passed');
    }
  }
  if (Date.parse(dueAt) > now + 1_000) {
    throw new SubscriptionSchedulerError('invalid-occurrence', 'next occurrence is not due yet');
  }
  const taskId: TaskId = {
    scope: 'task',
    value: `scheduled-task-${subscription.subscriptionId}-${ordinal}`,
  };
  const operationId: OperationId = {
    scope: 'operation',
    value: `scheduled-operation-${subscription.subscriptionId}-${ordinal}`,
  };
  return {
    occurrence: {
      subscriptionId: subscription.subscriptionId,
      scheduleRevision: subscription.scheduleRevision,
      occurrenceOrdinal: ordinal,
      state: 'due',
      dueAt,
    },
    nowAt,
    taskId,
    operationId,
    inputArtifactDigest: `sha256:${subscription.subscriptionId}:${subscription.scheduleRevision}:${ordinal}`,
    executionEpoch: ordinal,
    ...(busy === undefined ? {} : { busy }),
  };
}

export function schedulerPatrolFromSubscription(snapshot: SubscriptionSnapshot): Readonly<{
  readonly subscription: Subscription;
  readonly policy: ExecutionPolicyDefinition;
  readonly claim: (input: ScheduledOccurrenceClaimInput) => Promise<OccurrenceClaimRecord>;
}> {
  return {
    subscription: cloneState(snapshot.subscription),
    policy: cloneState(snapshot.policy),
    claim: async () => {
      throw new SubscriptionSchedulerError('serve-task-pending', 'claim requires a SubscriptionControlPort');
    },
  };
}

export function terminalReceiptEvidence(receipt: ServeTaskTerminalReceipt): readonly EvidenceRef[] {
  return receipt.verification.evidenceRefs;
}
