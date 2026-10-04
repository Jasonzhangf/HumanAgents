import {
  validateOccurrence,
  validateSubscription,
  type Occurrence,
  type Subscription,
} from '../../../contracts/src/index.js';
import {
  SubscriptionSchedulerError,
  type SubscriptionControlPort,
  type SubscriptionControlReceipt,
  type SubscriptionControlRequest,
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
  readonly attentionRef?: string;
}

export interface SchedulerPatrolControlInput {
  readonly expectedPolicyRevision: number;
  readonly expectedScheduleRevision?: number;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface SchedulerPatrolOptions {
  readonly subscription: Subscription;
  readonly trigger: Omit<SchedulerPatrolTrigger, 'idempotencyKey'>;
  readonly port: SchedulerPatrolPort;
  readonly now: () => Date;
  readonly subscriptionPort?: SubscriptionControlPort;
}

export class SchedulerPatrol {
  private readonly subscriptionId: string;

  constructor(private readonly options: SchedulerPatrolOptions) {
    validateSubscription(options.subscription);
    this.subscriptionId = options.subscription.subscriptionId;
  }

  async snapshot(): Promise<Subscription> {
    return (await this.requireSubscriptionPort().snapshot(this.subscriptionId)).subscription;
  }

  async pause(input: SchedulerPatrolControlInput): Promise<SubscriptionControlReceipt> {
    return this.control({ ...input, subscriptionId: this.subscriptionId, action: 'pause' });
  }

  async resume(input: SchedulerPatrolControlInput): Promise<SubscriptionControlReceipt> {
    return this.control({ ...input, subscriptionId: this.subscriptionId, action: 'resume' });
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
    if (this.options.subscriptionPort === undefined) {
      const occurrence = this.occurrenceFor(this.options.subscription, input.dueAt);
      validateOccurrence(occurrence);
      return this.pendingAttention(occurrence, 'scheduler patrol requires the typed SubscriptionControlPort');
    }
    const subscription = (await this.options.subscriptionPort.snapshot(this.subscriptionId)).subscription;
    if (subscription.state !== 'active') {
      throw new SchedulerPatrolError('subscription-state', `subscription is ${subscription.state}`);
    }
    const occurrence = this.occurrenceFor(subscription, input.dueAt);
    validateOccurrence(occurrence);
    try {
      const scheduled = await this.options.subscriptionPort.schedule({
        occurrence,
        nowAt: now.toISOString(),
        busy: input.busy,
      });
      return {
        subscriptionId: this.subscriptionId,
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
        subscriptionId: this.subscriptionId,
        occurrence: failedOccurrence,
        attentionRef: attention.attentionRef,
        nextCheckRef: `next-check:${failureKey}`,
      };
      return { ...receipt };
    }
  }

  private requireSubscriptionPort(): SubscriptionControlPort {
    if (this.options.subscriptionPort === undefined) {
      throw new SchedulerPatrolError('serve-task-pending', 'scheduler patrol requires the typed SubscriptionControlPort');
    }
    return this.options.subscriptionPort;
  }

  private async control(request: SubscriptionControlRequest): Promise<SubscriptionControlReceipt> {
    return this.requireSubscriptionPort().control(request);
  }

  private occurrenceFor(subscription: Subscription, dueAt: string): Occurrence {
    return {
      subscriptionId: subscription.subscriptionId,
      scheduleRevision: subscription.scheduleRevision,
      occurrenceOrdinal: subscription.currentOccurrenceOrdinal + 1,
      state: 'due',
      dueAt,
    };
  }

  private async pendingAttention(occurrence: Occurrence, message: string): Promise<SchedulerPatrolReceipt> {
    const error = new SchedulerPatrolError('serve-task-pending', message);
    const attention = await this.options.port.createAttention({
      sourceRef: this.options.trigger.triggerRef,
      reason: error.message,
      nextAction: 'retry-scheduler-patrol',
      conditionRef: `${occurrence.subscriptionId}::${occurrence.scheduleRevision}::${occurrence.occurrenceOrdinal}:${error.code}`,
    });
    return {
      subscriptionId: this.subscriptionId,
      occurrence,
      attentionRef: attention.attentionRef,
      nextCheckRef: `next-check:${occurrence.subscriptionId}::${occurrence.scheduleRevision}::${occurrence.occurrenceOrdinal}:${error.code}`,
    };
  }
}
