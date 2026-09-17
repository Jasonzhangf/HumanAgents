import {
  occurrenceIdempotencyKey,
  validateOccurrence,
  validateSubscription,
  type Occurrence,
  type Subscription,
} from '../../../contracts/src/index.js';

export class SchedulerPatrolError extends Error {
  readonly code: 'subscription-not-found' | 'subscription-state' | 'idempotency-conflict';

  constructor(code: SchedulerPatrolError['code'], message: string) {
    super(message);
    this.name = 'SchedulerPatrolError';
    this.code = code;
  }
}

export interface SchedulerPatrolTrigger {
  readonly triggerRef: string;
  readonly source: 'schedule';
  readonly policyRef: string;
  readonly policyRevision: number;
  readonly skillRef: string;
  readonly skillDigest: string;
  readonly scopeRef: string;
  readonly priorityProposalRef: string;
  readonly payloadRef: string;
  readonly idempotencyKey: string;
}

export interface SchedulerPatrolPort {
  submitTrigger(input: SchedulerPatrolTrigger): Promise<{
    readonly triggerReceiptRef: string;
    readonly accepted: boolean;
  }>;
  createAttention(input: {
    readonly sourceRef: string;
    readonly reason: string;
    readonly nextAction: string;
    readonly conditionRef: string;
  }): Promise<{ readonly attentionRef: string }>;
}

export interface SchedulerPatrolReceipt {
  readonly subscriptionId: string;
  readonly occurrence: Occurrence;
  readonly nextCheckRef: string;
  readonly triggerReceiptRef?: string;
  readonly attentionRef?: string;
}

export interface SchedulerPatrolOptions {
  readonly subscription: Subscription;
  readonly trigger: Omit<SchedulerPatrolTrigger, 'idempotencyKey'>;
  readonly port: SchedulerPatrolPort;
  readonly now: () => Date;
}

export class SchedulerPatrol {
  private subscription: Subscription;
  private readonly completed = new Map<string, SchedulerPatrolReceipt>();
  private lastOccurrence?: Occurrence;

  constructor(private readonly options: SchedulerPatrolOptions) {
    validateSubscription(options.subscription);
    this.subscription = { ...options.subscription };
  }

  snapshot(): Subscription {
    return { ...this.subscription };
  }

  pause(): Subscription {
    this.subscription = {
      ...this.subscription,
      state: 'suspended',
      scheduleRevision: this.subscription.scheduleRevision + 1,
    };
    validateSubscription(this.subscription);
    return this.snapshot();
  }

  resume(): Subscription {
    if (this.subscription.state !== 'suspended') {
      throw new SchedulerPatrolError('subscription-state', 'only a suspended subscription can be resumed');
    }
    this.subscription = {
      ...this.subscription,
      state: 'active',
      scheduleRevision: this.subscription.scheduleRevision + 1,
    };
    validateSubscription(this.subscription);
    return this.snapshot();
  }

  async run(input: {
    readonly dueAt: string;
    readonly busy: boolean;
  }): Promise<SchedulerPatrolReceipt> {
    const now = this.options.now();
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(input.dueAt))) {
      throw new SchedulerPatrolError('subscription-state', 'scheduler patrol requires a valid current time and due time');
    }
    if (Date.parse(input.dueAt) > now.getTime()) {
      throw new SchedulerPatrolError('subscription-state', 'scheduler patrol occurrence is not due yet');
    }
    if (this.subscription.state !== 'active') {
      throw new SchedulerPatrolError('subscription-state', `subscription is ${this.subscription.state}`);
    }
    const replay = this.lastOccurrence?.dueAt === input.dueAt
      && this.lastOccurrence.scheduleRevision === this.subscription.scheduleRevision;
    const occurrenceOrdinal = replay
      ? this.lastOccurrence!.occurrenceOrdinal
      : this.subscription.currentOccurrenceOrdinal + 1;
    const occurrence: Occurrence = {
      subscriptionId: this.subscription.subscriptionId,
      scheduleRevision: this.subscription.scheduleRevision,
      occurrenceOrdinal,
      state: input.busy && this.subscription.busyPolicy === 'skip' ? 'skipped-busy' : 'claimed',
      dueAt: input.dueAt,
    };
    validateOccurrence(occurrence);
    const idempotencyKey = occurrenceIdempotencyKey(occurrence);
    const existing = this.completed.get(idempotencyKey);
    if (existing) return { ...existing };

    if (!replay) {
      this.subscription = {
        ...this.subscription,
        currentOccurrenceOrdinal: occurrenceOrdinal,
      };
      this.lastOccurrence = occurrence;
    }

    if (occurrence.state === 'skipped-busy') {
      const receipt = {
        subscriptionId: this.subscription.subscriptionId,
        occurrence: { ...occurrence, state: 'consumed' as const },
        nextCheckRef: `next-check:${idempotencyKey}`,
      };
      this.completed.set(idempotencyKey, receipt);
      return { ...receipt };
    }

    try {
      const submitted = await this.options.port.submitTrigger({
        ...this.options.trigger,
        idempotencyKey,
      });
      if (!submitted.accepted) {
        throw new Error('scheduler patrol trigger was not accepted');
      }
      const receipt = {
        subscriptionId: this.subscription.subscriptionId,
        occurrence: { ...occurrence, state: 'consumed' as const },
        triggerReceiptRef: submitted.triggerReceiptRef,
        nextCheckRef: `next-check:${idempotencyKey}`,
      };
      this.completed.set(idempotencyKey, receipt);
      return { ...receipt };
    } catch (error) {
      const failedOccurrence: Occurrence = { ...occurrence, state: 'due' };
      const failureKey = `${idempotencyKey}:attention`;
      const attention = await this.options.port.createAttention({
        sourceRef: this.options.trigger.triggerRef,
        reason: error instanceof Error ? error.message : String(error),
        nextAction: 'retry-scheduler-patrol',
        conditionRef: failureKey,
      });
      const receipt = {
        subscriptionId: this.subscription.subscriptionId,
        occurrence: failedOccurrence,
        attentionRef: attention.attentionRef,
        nextCheckRef: `next-check:${failureKey}`,
      };
      return { ...receipt };
    }
  }
}
