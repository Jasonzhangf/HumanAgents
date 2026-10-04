import {
  assertOccurrenceClaimFence,
  assertOccurrenceClaimable,
  assertVerifiedTerminalReceipt,
  decideSubscriptionControl,
  executionPolicyHash,
  SubscriptionControlError as CoreSubscriptionControlError,
  type SubscriptionControlDecision,
} from '../../../core/src/subscription.js';
import {
  canonicalJsonStringify,
  validateExecutionPolicyDefinition,
  validateOccurrence,
  validateOccurrenceClaim,
  validateReminder,
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
  validateSubscription(input.subscription);
  validateExecutionPolicyDefinition(input.policy);
  if (input.policyHash !== executionPolicyHash(input.policy)) {
    throw new SubscriptionSchedulerError('invalid-transition', 'subscription policy hash does not match the persisted policy');
  }
  for (const receipt of input.receipts) validateSubscriptionControlReceipt(receipt);
  for (const occurrence of input.occurrences) validateOccurrence(occurrence);
  for (const claim of input.claims) validateOccurrenceClaim(claim);
  for (const reminder of input.reminders) validateReminder(reminder);
  return cloneState(input);
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
  }): Promise<Occurrence> {
    return this.transaction(async (state, append) => {
      for (const [subscriptionId, snapshot] of Object.entries(state.subscriptions)) {
        const occurrence = findOccurrence(snapshot, input.occurrenceId);
        if (!occurrence) continue;
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
        const max = policyMaxOccurrences(snapshot.policy);
        const currentOccurrenceOrdinal = Math.max(snapshot.subscription.currentOccurrenceOrdinal, occurrence.occurrenceOrdinal);
        const nextState = snapshot.subscription.state === 'active'
          && max !== undefined
          && currentOccurrenceOrdinal >= max
          ? 'exhausted'
          : snapshot.subscription.state;
        const next = normalizeSnapshot({
          ...snapshot,
          subscription: {
            ...snapshot.subscription,
            currentOccurrenceOrdinal,
            state: nextState,
          },
          occurrences: applyOccurrence(snapshot.occurrences, consumed),
        });
        state.subscriptions[subscriptionId] = next;
        await append(this.record(state));
        return cloneState(consumed);
      }
      throw new SubscriptionSchedulerError('not-found', `occurrence not found: ${input.occurrenceId}`);
    });
  }

  async claims(): Promise<readonly OccurrenceClaimRecord[]> {
    const state = await this.read();
    return Object.values(state.subscriptions).flatMap((snapshot) => snapshot.claims.map((claim) => cloneState(claim)));
  }

  async schedule(input: ScheduledOccurrenceInput): Promise<Occurrence> {
    validateOccurrence(input.occurrence);
    return this.transaction(async (state, append) => {
      const snapshot = state.subscriptions[key(input.occurrence.subscriptionId)];
      if (!snapshot) throw new SubscriptionSchedulerError('not-found', `subscription not found: ${input.occurrence.subscriptionId}`);
      const subscription = snapshot.subscription;
      if (subscription.state !== 'active') throw new SubscriptionSchedulerError('invalid-transition', `subscription is ${subscription.state}`);
      if (input.occurrence.scheduleRevision !== subscription.scheduleRevision) {
        throw new SubscriptionSchedulerError('stale-revision', 'occurrence schedule revision is stale');
      }
      const occurrenceId = generatedOccurrenceId(input.occurrence.subscriptionId, input.occurrence.scheduleRevision, input.occurrence.occurrenceOrdinal);
      const existing = findOccurrence(snapshot, occurrenceId);
      if (existing) return cloneState(existing);
      if (input.occurrence.occurrenceOrdinal <= subscription.currentOccurrenceOrdinal) {
        throw new SubscriptionSchedulerError('invalid-occurrence', 'occurrence ordinal has already been consumed');
      }
      const max = policyMaxOccurrences(snapshot.policy);
      if (max !== undefined && input.occurrence.occurrenceOrdinal > max) throw new SubscriptionSchedulerError('exhausted', 'subscription occurrence limit is exhausted');
      const late = Date.parse(input.occurrence.dueAt) < Date.parse(input.nowAt);
      const busy = input.busy === true;
      let nextOccurrence: Occurrence = {
        ...input.occurrence,
        occurrenceId,
        state: 'due',
      };
      let nextReminders = snapshot.reminders;
      if (late && snapshot.policy.latePolicy === 'skip') {
        nextOccurrence = { ...nextOccurrence, state: 'skipped-busy' };
      } else if (busy && snapshot.policy.busyPolicy === 'skip') {
        nextOccurrence = { ...nextOccurrence, state: 'skipped-busy' };
      } else if (busy && snapshot.policy.busyPolicy === 'idle-reminder') {
        nextOccurrence = { ...nextOccurrence, state: 'reminder-pending' };
        const reminderId = `reminder:${occurrenceId}`;
        if (!snapshot.reminders.some((reminder) => reminder.reminderId === reminderId)) {
          nextReminders = [...snapshot.reminders, {
            reminderId,
            subscriptionId: input.occurrence.subscriptionId,
            scheduleRevision: input.occurrence.scheduleRevision,
            occurrenceOrdinal: input.occurrence.occurrenceOrdinal,
            state: 'pending',
            dueAt: input.occurrence.dueAt,
          }];
        }
      }
      const consumedOrdinal = nextOccurrence.state === 'skipped-busy';
      const currentOccurrenceOrdinal = consumedOrdinal
        ? Math.max(subscription.currentOccurrenceOrdinal, input.occurrence.occurrenceOrdinal)
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

    return recurringDueTimes(input.policy, input.count)
      .filter((dueAt) => isDue(Date.parse(dueAt)));
  }

  async consumeExecution(occurrenceId: string, claim?: OccurrenceClaimRecord): Promise<ServeTaskTerminalReceipt> {
    if (!this.serveTask) {
      throw new SubscriptionSchedulerError('serve-task-pending', 'execute_occurrence_task requires W3 humanagent-serve-task@2 bridge');
    }
    if (!claim) throw new SubscriptionSchedulerError('invalid-occurrence', 'occurrence claim is required before execution');
    return this.serveTask.executeOccurrence({
      occurrence: {
        occurrenceId,
        subscriptionId: claim.subscriptionId,
        scheduleRevision: claim.scheduleRevision,
        occurrenceOrdinal: claim.occurrenceOrdinal,
        state: 'claimed',
        dueAt: claim.acquiredAt,
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

function recurringDueTimes(
  policy: Extract<ExecutionPolicyDefinition, { readonly executionMode: 'recurring' }>,
  count: number,
): readonly string[] {
  const max = policy.maxOccurrences;
  const limit = max === undefined ? count : Math.min(count, max);
  if (limit < 1) return [];
  const end = policy.endAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(policy.endAt);
  const results: string[] = [];
  if (policy.frequency === 'interval') {
    const start = Date.parse(policy.startAt);
    for (let ordinal = 1; ordinal <= limit; ordinal += 1) {
      const due = start + (ordinal - 1) * policy.intervalMinutes! * 60_000;
      if (due >= end) break;
      results.push(new Date(due).toISOString());
    }
    return results;
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
  for (let day = 0; day < 3660 && results.length < limit; day += 1) {
    const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
    if (!weekDays || weekDays.has(weekday)) {
      const due = Date.parse(wallTimeToInstant(
        policy.timezone,
        `${localDate}T${hourText}:${minuteText}`,
        policy.dstMode,
      ));
      if (due >= end) break;
      if (due >= start) results.push(new Date(due).toISOString());
    }
    localDate = nextCalendarDate(localDate);
  }
  return results;
}

function computeOccurrence(input: NextOccurrenceInput): ScheduledOccurrenceInput {
  const { subscription, policy, nowAt, busy } = input;
  validateSubscription(subscription);
  validateExecutionPolicyDefinition(policy);
  const now = Date.parse(nowAt);
  if (!Number.isFinite(now)) throw new SubscriptionSchedulerError('invalid-occurrence', 'nowAt must be a valid timestamp');
  const ordinal = subscription.currentOccurrenceOrdinal + 1;
  let dueAt: string;
  if (policy.executionMode === 'once') {
    if (ordinal > 1) throw new SubscriptionSchedulerError('exhausted', 'once policy has no further occurrence');
    dueAt = policy.dueAt;
  } else if (policy.executionMode === 'scheduled') {
    if (ordinal > 1) {
      throw new SubscriptionSchedulerError('exhausted', 'scheduled policy has no further occurrence');
    }
    dueAt = policy.startAt;
  } else {
    const due = recurringDueTimes(policy, ordinal)[ordinal - 1];
    if (due === undefined) throw new SubscriptionSchedulerError('exhausted', 'subscription recurrence has no further occurrence');
    dueAt = due;
  }
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
