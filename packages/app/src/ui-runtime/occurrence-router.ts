// App-owned per-binding occurrence consumer router.
//
// `DurableOccurrenceConsumer` fixes one lifecycle scope at construction and
// rejects any binding whose task/operation identity differs, so the scheduler
// cannot use a single consumer for every plan. This router is the single owner
// of consumer construction: it retains one durable consumer per immutable
// binding identity while an execution is in flight and delegates
// `executeOccurrence`. Retaining matters because the consumer holds the
// in-flight single-dispatch map; rebuilding a consumer per tick would lose that
// guarantee inside one process. Retention must not outlive the dispatch: a
// settled occurrence is released, and the next execution for that identity
// rebuilds a consumer that replays the committed journal receipt.
import { join } from 'node:path';

import type {
  ExecutionPolicyDefinition,
  Occurrence,
  OccurrenceTaskBinding,
  OrganId,
  ServeTaskTerminalReceipt,
} from '../../../contracts/src/index.js';
import type { OccurrenceClaimRecord, ServeTaskConsumerPort } from '../../../runtime/src/subscriptions/ports.js';
import type { SupervisorLease } from '../supervisor/index.js';
import {
  DurableOccurrenceConsumer,
  DurableOccurrenceConsumerError,
  type OccurrenceDispatchPort,
} from './occurrence-consumer.js';

export interface OccurrenceConsumerRouterOptions {
  readonly organId: OrganId;
  /**
   * Directory that holds one consumer journal per binding. It must not be the
   * coordinator's business task-cycle checkpoint file, otherwise the consumer
   * reads a checkpoint without a receipt and stays recovery-pending forever.
   */
  readonly root: string;
  /**
   * The live supervisor lease. The router resolves it when it builds the first
   * consumer for a binding; nothing resolves means fail closed with a typed
   * error instead of inventing a lease.
   */
  readonly lease: () => SupervisorLease | undefined;
  readonly dispatch: OccurrenceDispatchPort;
  readonly now?: () => string;
}

// A consumer plus the number of calls currently executing through it. One
// registry holds both facts, so retention and in-flight state cannot drift.
interface RetainedConsumer {
  readonly consumer: DurableOccurrenceConsumer;
  inFlightCalls: number;
}

export class OccurrenceConsumerRouter implements ServeTaskConsumerPort {
  readonly ownsFirstAdmissionAuthority = true;

  private readonly consumers = new Map<string, RetainedConsumer>();

  constructor(private readonly options: OccurrenceConsumerRouterOptions) {}

  /**
   * Read-only observation of how many per-binding consumers this router
   * currently retains. A retained consumer is one whose execution is in flight;
   * a settled consumer is released, because the next execution for the same
   * identity rebuilds one and replays the committed journal receipt.
   */
  get retainedConsumerCount(): number {
    return this.consumers.size;
  }

  async executeOccurrence(input: {
    readonly occurrence: Occurrence;
    readonly policy: ExecutionPolicyDefinition;
    readonly claim: OccurrenceClaimRecord;
    readonly binding: OccurrenceTaskBinding;
  }): Promise<ServeTaskTerminalReceipt> {
    const lease = this.options.lease();
    if (lease === undefined) {
      throw new DurableOccurrenceConsumerError(
        'owner-live-unproven',
        'no active supervisor lease is available for occurrence execution',
      );
    }
    const identity = identityFor(input.binding, lease);
    const retained = this.consumerFor(identity, input.binding, lease);
    retained.inFlightCalls += 1;
    try {
      return await retained.consumer.executeOccurrence(input);
    } finally {
      // Release the consumer only once no call for this identity is in flight.
      // The next call for an already-settled occurrence then rebuilds a consumer
      // and replays the committed journal receipt, which is the design intent:
      // the in-memory map only has to cover a dispatch that is still running.
      retained.inFlightCalls -= 1;
      if (retained.inFlightCalls === 0) this.consumers.delete(identity);
    }
  }

  private consumerFor(
    identity: string,
    binding: OccurrenceTaskBinding,
    lease: SupervisorLease,
  ): RetainedConsumer {
    const existing = this.consumers.get(identity);
    if (existing !== undefined) return existing;

    const consumer = DurableOccurrenceConsumer.forTaskCycle({
      lease,
      scope: DurableOccurrenceConsumer.scopeForBinding(this.options.organId, binding),
      journalPath: join(this.options.root, DurableOccurrenceConsumer.journalFileNameForBinding(binding)),
      dispatch: this.options.dispatch,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
    const retained: RetainedConsumer = { consumer, inFlightCalls: 0 };
    this.consumers.set(identity, retained);
    return retained;
  }
}

function identityFor(binding: OccurrenceTaskBinding, lease: SupervisorLease): string {
  return [
    binding.occurrenceId,
    binding.taskId.value,
    binding.operationId.value,
    String(binding.executionEpoch),
    binding.inputArtifactDigest,
    // A different lease is a different execution owner: its consumer must be
    // rebuilt so the in-flight single-dispatch map cannot outlive the owner
    // that proved liveness for it.
    lease.record.leaseId,
    String(lease.record.generation),
  ].join('|');
}
