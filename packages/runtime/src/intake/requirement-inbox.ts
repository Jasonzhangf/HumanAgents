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

export interface RequirementInboxAppendResult {
  readonly status: 'appended' | 'duplicate';
  readonly receipt: InboxReceipt;
}

export interface ReadInbox {
  readonly consumerId: string;
}

export interface RequirementInboxState {
  readonly nextFifoSeq: number;
  readonly pendingDraftIds: readonly string[];
  readonly envelopes: readonly RequirementEnvelope[];
}

export class RequirementInbox {
  private readonly pending: RequirementEnvelope[] = [];
  private readonly envelopes = new Map<string, RequirementEnvelope>();
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

  exportState(): RequirementInboxState {
    return {
      nextFifoSeq: this.nextFifoSeq,
      pendingDraftIds: this.pending.map((envelope) => envelope.draftId),
      envelopes: [...this.envelopes.values()].map((envelope) => structuredClone(envelope)),
    };
  }

  restoreState(state: RequirementInboxState): void {
    this.pending.length = 0;
    this.envelopes.clear();
    this.requirementIds.clear();
    this.draftIds.clear();
    this.nextFifoSeq = state.nextFifoSeq;
    const byDraft = new Map<string, RequirementEnvelope>();
    for (const envelope of state.envelopes) {
      const restored = structuredClone(envelope);
      byDraft.set(restored.draftId, restored);
      this.envelopes.set(restored.draftId, restored);
      this.requirementIds.add(restored.requirementId);
      this.draftIds.add(restored.draftId);
      this.confirmedEnvelopes.add(restored);
    }
    for (const draftId of state.pendingDraftIds) {
      const envelope = byDraft.get(draftId);
      if (!envelope) throw new RequirementInboxError('invalid-state', `pending requirement draft is missing: ${draftId}`, {
        owner: 'runtime-coordinator',
        nextAction: 'repair-the-ui-runtime-journal',
        condition: 'existing-pending-envelope',
      });
      this.pending.push(envelope);
    }
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

    const existing = this.find(input.draftId);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(input)) {
        if (!this.confirmedEnvelopes.has(existing)) {
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
        return {
          requirementId: existing.requirementId,
          draftId: existing.draftId,
          fifoSeq: existing.fifoSeq,
        };
      }
      throw new RequirementInboxError(
        'duplicate-envelope',
        'draft was already appended with different content',
        {
          owner: 'runtime-coordinator',
          nextAction: 'inspect-existing-inbox-entry',
          condition: 'unique-requirement-and-draft',
        },
      );
    }
    if (this.requirementIds.has(input.requirementId)) {
      throw new RequirementInboxError(
        'duplicate-envelope',
        'requirement id was already appended',
        {
          owner: 'runtime-coordinator',
          nextAction: 'inspect-existing-inbox-entry',
          condition: 'unique-requirement-id',
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
    this.envelopes.set(input.draftId, input);
    this.requirementIds.add(input.requirementId);
    this.draftIds.add(input.draftId);
    this.nextFifoSeq += 1;

    return {
      requirementId: input.requirementId,
      draftId: input.draftId,
      fifoSeq: input.fifoSeq,
    };
  }

  find(draftId: string): RequirementEnvelope | undefined {
    return this.envelopes.get(draftId);
  }

  async peekNext(input: ReadInbox): Promise<RequirementEnvelope | null> {
    this.assertConsumer(input);
    return this.pending[0] ?? null;
  }

  async acknowledge(input: ReadInbox & { readonly requirementId: string }): Promise<InboxReceipt> {
    this.assertConsumer(input);
    const current = this.pending[0];
    if (!current) {
      throw new RequirementInboxError(
        'empty-inbox',
        'requirement inbox has no pending entry to acknowledge',
        {
          owner: 'runtime-coordinator',
          nextAction: 'wait-for-confirmed-requirement',
          condition: 'pending-requirement',
        },
      );
    }
    if (current.requirementId !== input.requirementId) {
      throw new RequirementInboxError(
        'out-of-order-envelope',
        `requirement inbox head is ${current.requirementId}`,
        {
          owner: 'runtime-coordinator',
          nextAction: 'acknowledge-the-fifo-head',
          condition: current.requirementId,
        },
      );
    }
    this.pending.shift();
    return {
      requirementId: current.requirementId,
      draftId: current.draftId,
      fifoSeq: current.fifoSeq,
    };
  }

  restoreAcknowledged(input: ReadInbox & { readonly requirementId: string }): void {
    this.assertConsumer(input);
    const envelope = [...this.envelopes.values()].find((candidate) => candidate.requirementId === input.requirementId);
    if (!envelope) {
      throw new RequirementInboxError(
        'invalid-state',
        `acknowledged requirement is missing: ${input.requirementId}`,
        {
          owner: 'runtime-coordinator',
          nextAction: 'repair-the-ui-runtime-journal',
          condition: 'existing-requirement-envelope',
        },
      );
    }
    if (this.pending.some((candidate) => candidate.requirementId === input.requirementId)) return;
    this.pending.push(envelope);
    this.pending.sort((left, right) => left.fifoSeq - right.fifoSeq);
  }

  async readNext(input: ReadInbox): Promise<RequirementEnvelope | null> {
    this.assertConsumer(input);
    return this.pending.shift() ?? null;
  }

  private assertConsumer(input: ReadInbox): void {
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
  }
}
