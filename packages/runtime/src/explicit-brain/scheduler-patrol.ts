import {
  validateOccurrence,
  validateSubscription,
  type Occurrence,
  type Subscription,
} from '../../../contracts/src/index.js';
import {
  SubscriptionSchedulerError,
  type ScheduledOccurrenceInput,
  type SubscriptionControlPort,
} from '../subscriptions/index.js';

export class SchedulerPatrolError extends Error {
  readonly code: 'subscription-not-found' | 'subscription-state' | 'idempotency-conflict' | 'serve-task-pending';

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
  /** Legacy transport hook retained for source compatibility; it is never treated as execution success. */
  submitTrigger?(input: SchedulerPatrolTrigger): Promise<{
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
  readonly subscriptionPort?: SubscriptionControlPort;
  readonly schedule?: Pick<ScheduledOccurrenceInput, 'occurrence'>;
}

export class SchedulerPatrol {
  private subscription: Subscription;

  constructor(private readonly options: SchedulerPatrolOptions) {
    validateSubscription(options.subscription);
    this.subscription = { ...options.subscription };
  }

  snapshot(): Subscription {
    return { ...this.subscription };
  }

  pause(): Subscription {
    if (this.subscription.state !== 'active') {
      throw new SchedulerPatrolError('subscription-state', `subscription is ${this.subscription.state}`);
    }
    return { ...this.subscription, state: 'suspended', scheduleRevision: this.subscription.scheduleRevision + 1 };
  }

  resume(): Subscription {
    if (this.subscription.state !== 'suspended') {
      throw new SchedulerPatrolError('subscription-state', 'only a suspended subscription can be resumed');
    }
    return { ...this.subscription, state: 'active', scheduleRevision: this.subscription.scheduleRevision + 1 };
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
    const occurrence: Occurrence = this.options.schedule?.occurrence === undefined
      ? {
        subscriptionId: this.subscription.subscriptionId,
        scheduleRevision: this.subscription.scheduleRevision,
        occurrenceOrdinal: this.subscription.currentOccurrenceOrdinal + 1,
        state: 'due',
        dueAt: input.dueAt,
      }
      : {
        ...this.options.schedule.occurrence,
        subscriptionId: this.subscription.subscriptionId,
        scheduleRevision: this.subscription.scheduleRevision,
      };
    validateOccurrence(occurrence);
    if (this.options.subscriptionPort === undefined || this.options.schedule === undefined) {
      const error = new SchedulerPatrolError('serve-task-pending', 'scheduler patrol requires the typed SubscriptionControlPort');
      const attention = await this.options.port.createAttention({
        sourceRef: this.options.trigger.triggerRef,
        reason: error.message,
        nextAction: 'retry-scheduler-patrol',
        conditionRef: `${occurrence.subscriptionId}::${occurrence.scheduleRevision}::${occurrence.occurrenceOrdinal}:${error.code}`,
      });
      return {
        subscriptionId: this.subscription.subscriptionId,
        occurrence,
        attentionRef: attention.attentionRef,
        nextCheckRef: `next-check:${occurrence.subscriptionId}::${occurrence.scheduleRevision}::${occurrence.occurrenceOrdinal}:${error.code}`,
      };
    }
    try {
      validateOccurrence(occurrence);
      const scheduled = await this.options.subscriptionPort.schedule({
        occurrence,
        nowAt: now.toISOString(),
        busy: input.busy,
      });
      this.subscription = {
        ...this.subscription,
        currentOccurrenceOrdinal: scheduled.occurrenceOrdinal,
      };
      return {
        subscriptionId: this.subscription.subscriptionId,
        occurrence: scheduled,
        nextCheckRef: `next-check:${scheduled.subscriptionId}::${scheduled.scheduleRevision}::${scheduled.occurrenceOrdinal}`,
      };
    } catch (error) {
      if (!(error instanceof SubscriptionSchedulerError)) throw error;
      const failedOccurrence: Occurrence = { ...occurrence, state: 'due' };
      const failureKey = `${occurrence.subscriptionId}::${occurrence.scheduleRevision}::${occurrence.occurrenceOrdinal}:${error.code}`;
      const attention = await this.options.port.createAttention({
        sourceRef: this.options.trigger.triggerRef,
        reason: error.message,
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
