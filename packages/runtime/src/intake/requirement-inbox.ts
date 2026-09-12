import {
  validateRequirementEnvelope,
  type RequirementEnvelope,
} from '../../../contracts/src/index.js';
import { RequirementInboxError } from './errors.js';

export interface InboxReceipt {
  readonly requirementId: string;
  readonly draftId: string;
  readonly fifoSeq: number;
}

export interface ReadInbox {
  readonly consumerId: string;
}

export class RequirementInbox {
  private readonly pending: RequirementEnvelope[] = [];
  private readonly requirementIds = new Set<string>();
  private readonly draftIds = new Set<string>();
  private readonly confirmedEnvelopes = new WeakSet<RequirementEnvelope>();
  private nextFifoSeq = 1;

  get size(): number {
    return this.pending.length;
  }

  get expectedNextFifoSeq(): number {
    return this.nextFifoSeq;
  }

  markConfirmed(input: RequirementEnvelope): void {
    this.confirmedEnvelopes.add(input);
  }

  async append(input: RequirementEnvelope): Promise<InboxReceipt> {
    if (!this.confirmedEnvelopes.has(input)) {
      throw new RequirementInboxError(
        'unconfirmed-envelope',
        'requirement envelope was not produced by explicit confirmation',
        {
          owner: 'runtime-coordinator',
          nextAction: 'return-to-explicit-confirmation',
          condition: 'confirmed-envelope-registration',
        },
      );
    }
    if (!input.confirmedBy || !input.confirmedBy.trim() || !input.confirmedAt || !Number.isFinite(Date.parse(input.confirmedAt))) {
      throw new RequirementInboxError(
        'unconfirmed-envelope',
        'requirement envelope requires explicit confirmation',
        {
          owner: 'runtime-coordinator',
          nextAction: 'return-to-explicit-confirmation',
          condition: 'confirmed-by-and-confirmed-at',
        },
      );
    }

    try {
      validateRequirementEnvelope(input);
    } catch (cause) {
      throw new RequirementInboxError(
        'invalid-envelope',
        'requirement envelope failed contract validation',
        {
          owner: 'explicit-intake',
          nextAction: 'repair-confirmed-draft',
          condition: 'requirement-envelope-contract',
          cause,
        },
      );
    }

    if (this.requirementIds.has(input.requirementId) || this.draftIds.has(input.draftId)) {
      throw new RequirementInboxError(
        'duplicate-envelope',
        'requirement or draft was already appended',
        {
          owner: 'runtime-coordinator',
          nextAction: 'inspect-existing-inbox-entry',
          condition: 'unique-requirement-and-draft',
        },
      );
    }

    if (input.fifoSeq !== this.nextFifoSeq) {
      throw new RequirementInboxError(
        'out-of-order-envelope',
        `requirement fifo sequence must be ${this.nextFifoSeq}`,
        {
          owner: 'runtime-coordinator',
          nextAction: 'restore-fifo-sequence',
          condition: `fifo-seq-${this.nextFifoSeq}`,
        },
      );
    }

    this.pending.push(input);
    this.requirementIds.add(input.requirementId);
    this.draftIds.add(input.draftId);
    this.nextFifoSeq += 1;

    return {
      requirementId: input.requirementId,
      draftId: input.draftId,
      fifoSeq: input.fifoSeq,
    };
  }

  async readNext(input: ReadInbox): Promise<RequirementEnvelope | null> {
    if (!input.consumerId || !input.consumerId.trim()) {
      throw new RequirementInboxError(
        'consumer-required',
        'requirement inbox consumer is required',
        {
          owner: 'runtime-coordinator',
          nextAction: 'bind-inbox-consumer',
          condition: 'non-empty-consumer-id',
        },
      );
    }

    return this.pending.shift() ?? null;
  }
}
