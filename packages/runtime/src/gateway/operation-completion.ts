import {
  validateFileWriteCompletionFact,
  validateFileWriteEffectIntent,
  type CompletionReadInput,
  type CompletionReadback,
  type DurableCompletionReceipt,
  type EffectExecutionBinding,
  type FileWriteEffect,
  type FileWriteCompletionFact,
  type FileWriteEffectIntent,
} from '../../../contracts/src/index.js';

export interface OperationCompletionCommitPort {
  commitIntent(input: FileWriteEffectIntent): Promise<void>;
  commitCompletion(input: FileWriteCompletionFact): Promise<DurableCompletionReceipt>;
}

export interface OperationCompletionJournalPort extends OperationCompletionCommitPort {
  readExact(input: CompletionReadInput): Promise<CompletionReadback>;
}

export class OperationCompletionIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OperationCompletionIntegrityError';
  }
}

/**
 * Owns the only valid order for a durable effect: commit intent, perform the
 * effect, confirm it, then commit completion. A failure after intent remains an
 * unresolved reconcile obligation because the effect may already have happened.
 */
export class OperationCompletionOwner {
  constructor(private readonly journal: OperationCompletionCommitPort) {}

  async begin(binding: EffectExecutionBinding, effect: FileWriteEffect): Promise<void> {
    const intent: FileWriteEffectIntent = {
      kind: 'operation-effect-intent',
      version: 1,
      binding,
      effect,
    };
    validateFileWriteEffectIntent(intent);
    await this.journal.commitIntent(intent);
  }

  async commit(
    binding: EffectExecutionBinding,
    effect: FileWriteEffect,
    observedContentDigest: FileWriteEffect['expectedContentDigest'],
    result: FileWriteCompletionFact['result'],
  ): Promise<DurableCompletionReceipt> {
    if (observedContentDigest !== effect.expectedContentDigest) {
      throw new OperationCompletionIntegrityError('file write readback digest does not match the requested content');
    }
    const fact: FileWriteCompletionFact = {
      kind: 'operation-completion',
      version: 1,
      binding,
      effect,
      confirmation: {
        ownerId: 'humanagent.app.provider-tool-execution.file-write',
        method: 'file-readback-digest',
        observedContentDigest,
      },
      result,
    };
    validateFileWriteCompletionFact(fact);
    return await this.journal.commitCompletion(fact);
  }
}
