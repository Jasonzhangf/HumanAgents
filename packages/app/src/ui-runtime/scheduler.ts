// App-owned due-time patrol for persisted execution plans.
//
// The subscription control port owns the persisted plan truth, slot arithmetic,
// claims and settlements. This module is only the clock: it enumerates active
// plans, asks the port which slots are due, and drives schedule → claim →
// consumeExecution → settleOccurrence for one slot at a time. It never invents a
// slot, a claim, or a terminal outcome.
import { createHash } from 'node:crypto';

import {
  canonicalJsonStringify,
  id,
  type Occurrence,
  type OperationId,
  type TaskId,
} from '../../../contracts/src/index.js';
import {
  policySlotOrdinal,
  type SubscriptionControlPort,
  type SubscriptionSnapshot,
} from '../../../runtime/src/subscriptions/index.js';
import type { OccurrenceClaimRecord } from '../../../runtime/src/subscriptions/ports.js';
import type { SupervisorLease } from '../supervisor/index.js';
import { occurrenceIdentityToken } from './occurrence-identity.js';

const SCHEDULER_OWNER = 'humanagent.app.scheduled-occurrence-patrol';

/**
 * Stable scheduler identity for persisted claims. It must not encode the process
 * or the lease: a restarted process resumes the persisted claim instead of
 * minting a competing one.
 */
const SCHEDULER_INSTANCE_ID = 'humanagent.app.scheduled-occurrence-patrol';

/**
 * Durable occurrence decisions that record a patrol skip. `due` and `claimed`
 * are still pending and `consumed` executed, so only these three states count.
 * The status projection derives the skip count from the same plan snapshot it
 * already reads, so the reported number can never lag the durable decision the
 * way a tick-local counter does.
 */
const SKIPPED_OCCURRENCE_STATES: ReadonlySet<string> = new Set([
  'skipped-busy',
  'reminder-pending',
  'invalidated',
]);

export interface UiRuntimeSchedulerIssue {
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: string;
  readonly occurredAt: string;
  readonly subscriptionId?: string;
}

export interface UiRuntimeSchedulerOccurrenceProjection {
  readonly occurrenceId?: string;
  readonly occurrenceOrdinal: number;
  readonly state: string;
  readonly dueAt: string;
}

export interface UiRuntimeSchedulerSettlementProjection {
  readonly occurrenceId?: string;
  readonly occurrenceOrdinal: number;
  readonly verificationStatus: string;
  readonly settlementReceiptRef: string;
}

export interface UiRuntimeSchedulerPlanProjection {
  readonly subscriptionId: string;
  readonly goalId: string;
  readonly scheduleRevision: number;
  readonly state: string;
  readonly currentOccurrenceOrdinal: number;
  readonly occurrences: readonly UiRuntimeSchedulerOccurrenceProjection[];
  readonly settlements: readonly UiRuntimeSchedulerSettlementProjection[];
}

export interface UiRuntimeSchedulerStatusProjection {
  readonly state: 'idle' | 'running' | 'stopped';
  readonly schedulerInstanceId: string;
  readonly intervalMs: number;
  readonly ticks: number;
  readonly claimed: number;
  readonly executed: number;
  readonly settled: number;
  readonly skipped: number;
  readonly lastTickAt?: string;
  readonly issue?: UiRuntimeSchedulerIssue;
  readonly plans: readonly UiRuntimeSchedulerPlanProjection[];
}

export interface UiRuntimeSchedulerOptions {
  readonly port: SubscriptionControlPort;
  /**
   * The live supervisor lease. Every tick resolves it; nothing resolved means
   * fail closed with a typed reason and no dispatch, never a fabricated lease.
   */
  readonly lease: () => SupervisorLease | undefined;
  readonly runningTaskCount: () => number;
  readonly now?: () => Date;
  readonly intervalMs?: number;
  /**
   * How long one persisted occurrence claim stays valid. It must outlast the
   * real execution, because the consumer re-checks the claim lease when it
   * commits the terminal receipt.
   */
  readonly claimLeaseMs?: number;
  /**
   * How many due slots one tick may look at. The port returns the latest slots,
   * and `latePolicy` semantics are defined against the latest slot, so the
   * default is one slot per plan per tick.
   */
  readonly dueSlotCount?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class UiRuntimeScheduler {
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly claimLeaseMs: number;
  private readonly dueSlotCount: number;
  private timer: (ReturnType<typeof setInterval> & { unref?(): void }) | undefined;
  private inFlight: Promise<void> | undefined;
  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private ticks = 0;
  private claimed = 0;
  private executed = 0;
  private settled = 0;
  private lastTickAt: string | undefined;
  private issue: UiRuntimeSchedulerIssue | undefined;

  constructor(private readonly options: UiRuntimeSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? 1_000;
    this.claimLeaseMs = options.claimLeaseMs ?? 60 * 60_000;
    this.dueSlotCount = options.dueSlotCount ?? 1;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1) {
      throw new Error('scheduler interval must be a positive safe integer');
    }
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'running';
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.state = 'stopped';
    // A patrol that is already dispatching owns a real execution. Shutdown must
    // wait for it instead of returning while the patrol is still in flight.
    await this.inFlight;
  }

  /**
   * One patrol tick. Overlapping calls share the in-flight promise, so a slow
   * execution cannot let a second tick dispatch the same occurrence again.
   */
  tick(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = this.runTick().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  async status(): Promise<UiRuntimeSchedulerStatusProjection> {
    let plans: readonly UiRuntimeSchedulerPlanProjection[] = [];
    let listIssue: UiRuntimeSchedulerIssue | undefined;
    try {
      plans = (await this.options.port.list()).map((snapshot) => this.projectPlan(snapshot));
    } catch (error) {
      listIssue = this.issueFor('scheduler.plans-unreadable', messageOf(error), 'inspect the subscription journal', undefined);
    }
    const issue = this.issue ?? listIssue;
    const skipped = plans.reduce(
      (total, plan) => total + plan.occurrences.filter((occurrence) => SKIPPED_OCCURRENCE_STATES.has(occurrence.state)).length,
      0,
    );
    return {
      state: this.state,
      schedulerInstanceId: SCHEDULER_INSTANCE_ID,
      intervalMs: this.intervalMs,
      ticks: this.ticks,
      claimed: this.claimed,
      executed: this.executed,
      settled: this.settled,
      skipped,
      ...(this.lastTickAt === undefined ? {} : { lastTickAt: this.lastTickAt }),
      ...(issue === undefined ? {} : { issue }),
      plans,
    };
  }

  private projectPlan(snapshot: SubscriptionSnapshot): UiRuntimeSchedulerPlanProjection {
    return {
      subscriptionId: snapshot.subscription.subscriptionId,
      goalId: snapshot.subscription.goalId,
      scheduleRevision: snapshot.subscription.scheduleRevision,
      state: snapshot.subscription.state,
      currentOccurrenceOrdinal: snapshot.subscription.currentOccurrenceOrdinal,
      occurrences: snapshot.occurrences.map((occurrence) => ({
        ...(occurrence.occurrenceId === undefined ? {} : { occurrenceId: occurrence.occurrenceId }),
        occurrenceOrdinal: occurrence.occurrenceOrdinal,
        state: occurrence.state,
        dueAt: occurrence.dueAt,
      })),
      settlements: snapshot.settlements.map((settlement) => ({
        ...(settlement.occurrence.occurrenceId === undefined ? {} : { occurrenceId: settlement.occurrence.occurrenceId }),
        occurrenceOrdinal: settlement.occurrence.occurrenceOrdinal,
        verificationStatus: settlement.terminal.verification.status,
        settlementReceiptRef: settlement.terminal.settlementReceiptRef,
      })),
    };
  }

  private async runTick(): Promise<void> {
    // `stop()` retires the patrol. A tick that was already queued when the
    // runtime stopped must not claim or dispatch a new occurrence.
    if (this.state !== 'running') return;
    const lease = this.options.lease();
    if (lease === undefined) {
      this.issue = this.issueFor(
        'scheduler.lease.unavailable',
        'the runtime has no active supervisor lease, so no scheduled occurrence may be claimed',
        'start the runtime through the supervisor-owned serve entry and retry',
        undefined,
      );
      return;
    }
    const now = this.now();
    const nowAt = now.toISOString();
    const busy = this.options.runningTaskCount() > 0;
    let snapshots: readonly SubscriptionSnapshot[];
    try {
      snapshots = await this.options.port.list();
    } catch (error) {
      this.issue = this.issueFor('scheduler.plans-unreadable', messageOf(error), 'inspect the subscription journal', undefined);
      return;
    }
    for (const snapshot of snapshots) {
      if (snapshot.subscription.state !== 'active') continue;
      try {
        await this.patrolPlan(snapshot, lease, now, nowAt, busy);
      } catch (error) {
        this.issue = this.issueFor(
          'scheduler.plan-failed',
          messageOf(error),
          'inspect the execution plan and its persisted occurrence claim',
          snapshot.subscription.subscriptionId,
        );
      }
    }
    this.ticks += 1;
    this.lastTickAt = nowAt;
  }

  private async patrolPlan(
    snapshot: SubscriptionSnapshot,
    lease: SupervisorLease,
    now: Date,
    nowAt: string,
    busy: boolean,
  ): Promise<void> {
    const subscription = snapshot.subscription;
    // Occurrences this tick already drove to a settlement. The snapshot is read
    // once per tick, so step 2 would otherwise see a stale `claimed` occurrence
    // that step 1 just settled and consume it a second time.
    const consumed = new Set<string>();
    // 1. Resume occurrences that are already claimed but not settled. This is
    //    the restart and deferred-slot path: it reuses the persisted claim and
    //    re-enters the durable consumer, which replays a committed receipt or
    //    commits a blocked recovery instead of dispatching a second execution.
    for (const occurrence of snapshot.occurrences) {
      if (occurrence.state !== 'claimed' || occurrence.occurrenceId === undefined) continue;
      if (this.isSettled(snapshot, occurrence.occurrenceId)) continue;
      const claim = snapshot.claims.find((candidate) => candidate.occurrenceId === occurrence.occurrenceId);
      if (claim === undefined) continue;
      if (Date.parse(occurrence.dueAt) > now.getTime()) {
        // Claimed inside the due-time grace window; the real execution waits for
        // the slot time so the plan never runs before its start.
        continue;
      }
      await this.consume(occurrence, claim);
      consumed.add(occurrence.occurrenceId);
    }

    // 2. Schedule a newly due slot.
    const due = await this.options.port.dueTimes({
      policy: snapshot.policy,
      nowAt,
      count: this.dueSlotCount,
    });
    if (due.length === 0) return;
    const dueAt = due[due.length - 1]!;
    const occurrenceOrdinal = policySlotOrdinal(snapshot.policy, dueAt);
    const occurrenceId = `${subscription.subscriptionId}::${subscription.scheduleRevision}::${occurrenceOrdinal}`;
    if (this.isSettled(snapshot, occurrenceId) || consumed.has(occurrenceId)) {
      return;
    }
    const existing = snapshot.occurrences.find((candidate) => candidate.occurrenceId === occurrenceId);
    const existingClaim = snapshot.claims.find((candidate) => candidate.occurrenceId === occurrenceId);
    if (existingClaim !== undefined) {
      if (existing !== undefined && Date.parse(existing.dueAt) <= now.getTime()) {
        await this.consume(existing, existingClaim);
      }
      return;
    }

    const scheduled = await this.options.port.schedule({
      occurrence: {
        occurrenceId,
        subscriptionId: subscription.subscriptionId,
        scheduleRevision: subscription.scheduleRevision,
        occurrenceOrdinal,
        state: 'due',
        dueAt,
      },
      nowAt,
      busy,
    });
    if (scheduled.state !== 'due') {
      // skipped-busy / reminder-pending / consumed / invalidated are all closed
      // or waiting decisions owned by the port; the patrol does not re-open them
      // and the status projection reads the skip from that durable state.
      return;
    }

    const identity = occurrenceExecutionIdentity(occurrenceId, snapshot.policyHash, dueAt);
    const claim = await this.options.port.claim({
      subscriptionId: subscription.subscriptionId,
      scheduleRevision: subscription.scheduleRevision,
      occurrenceOrdinal,
      dueAt,
      taskId: identity.taskId,
      operationId: identity.operationId,
      inputArtifactDigest: identity.inputArtifactDigest,
      schedulerInstanceId: SCHEDULER_INSTANCE_ID,
      leaseId: lease.record.leaseId,
      generation: lease.record.generation,
      executionEpoch: 1,
      nowAt,
      leaseUntil: new Date(now.getTime() + this.claimLeaseMs).toISOString(),
    });
    this.claimed += 1;
    if (Date.parse(scheduled.dueAt) > now.getTime()) return;
    await this.consume(scheduled, claim);
  }

  private isSettled(snapshot: SubscriptionSnapshot, occurrenceId: string): boolean {
    return snapshot.settlements.some((settlement) => settlement.occurrence.occurrenceId === occurrenceId);
  }

  private async consume(occurrence: Occurrence, claim: OccurrenceClaimRecord): Promise<void> {
    const occurrenceId = occurrence.occurrenceId ?? claim.occurrenceId;
    const terminal = await this.options.port.consumeExecution(occurrenceId, claim);
    this.executed += 1;
    await this.options.port.settleOccurrence({ occurrenceId, terminal });
    this.settled += 1;
  }

  private issueFor(
    code: string,
    message: string,
    nextAction: string,
    subscriptionId: string | undefined,
  ): UiRuntimeSchedulerIssue {
    return {
      code,
      ownerId: SCHEDULER_OWNER,
      message,
      nextAction,
      occurredAt: this.now().toISOString(),
      ...(subscriptionId === undefined ? {} : { subscriptionId }),
    };
  }
}

/**
 * Deterministic execution identity for one occurrence slot. A restarted process
 * rebuilds exactly the same task/operation/digest for the same slot, so the
 * persisted claim still matches its binding instead of forking a new execution.
 */
export function occurrenceExecutionIdentity(
  occurrenceId: string,
  policyHash: string,
  dueAt: string,
): { readonly taskId: TaskId; readonly operationId: OperationId; readonly inputArtifactDigest: string } {
  const token = occurrenceIdentityToken(occurrenceId);
  return {
    taskId: id('task', `scheduled-task-${token}`),
    operationId: id('operation', `scheduled-operation-${token}`),
    inputArtifactDigest: `sha256:${createHash('sha256')
      .update(canonicalJsonStringify({ occurrenceId, policyHash, dueAt }))
      .digest('hex')}`,
  };
}
