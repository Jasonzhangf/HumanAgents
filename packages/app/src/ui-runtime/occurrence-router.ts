// App-owned per-binding occurrence consumer router.
//
// `DurableOccurrenceConsumer` fixes one lifecycle scope at construction and
// rejects any binding whose task/operation identity differs, so the scheduler
// cannot use a single consumer for every plan. This router is the single owner
// of consumer construction: it memoizes one durable consumer per immutable
// binding identity and delegates `executeOccurrence`. Memoizing matters because
// the consumer holds the in-flight single-dispatch map; rebuilding a consumer
// per tick would lose that guarantee inside one process.
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

export class OccurrenceConsumerRouter implements ServeTaskConsumerPort {
  readonly ownsFirstAdmissionAuthority = true;

  private readonly consumers = new Map<string, DurableOccurrenceConsumer>();

  constructor(private readonly options: OccurrenceConsumerRouterOptions) {}

  async executeOccurrence(input: {
    readonly occurrence: Occurrence;
    readonly policy: ExecutionPolicyDefinition;
    readonly claim: OccurrenceClaimRecord;
    readonly binding: OccurrenceTaskBinding;
  }): Promise<ServeTaskTerminalReceipt> {
    return this.consumerFor(input.binding).executeOccurrence(input);
  }

  private consumerFor(binding: OccurrenceTaskBinding): DurableOccurrenceConsumer {
    const lease = this.options.lease();
    if (lease === undefined) {
      throw new DurableOccurrenceConsumerError(
        'owner-live-unproven',
        'no active supervisor lease is available for occurrence execution',
      );
    }
    const identity = [
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
    const existing = this.consumers.get(identity);
    if (existing !== undefined) return existing;

    const consumer = DurableOccurrenceConsumer.forTaskCycle({
      lease,
      scope: DurableOccurrenceConsumer.scopeForBinding(this.options.organId, binding),
      journalPath: join(this.options.root, DurableOccurrenceConsumer.journalFileNameForBinding(binding)),
      dispatch: this.options.dispatch,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
    this.consumers.set(identity, consumer);
    return consumer;
  }
}
