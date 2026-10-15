import {
  validatePreparedRecoveryCapture,
  type ActiveTurnProviderExecutionIdentityRef,
  type CompletionReadInput,
  type CompletionRef,
  type PreparedRecoveryCapture,
  type ProviderProducerDrainResult,
  type RecoveryHoldFacts,
} from '../../../contracts/src/index.js';
import { ActiveTurnContext, RuntimeActiveTurnError } from './active-turn-context.js';

export interface ActiveTurnProviderProducer {
  closeProductionAndDrain(input: {
    readonly execution: ActiveTurnProviderExecutionIdentityRef;
    readonly boundaryId: string;
  }): Promise<ProviderProducerDrainResult>;
}

export interface RecoveryCaptureReferences {
  readonly checkpointPath: readonly string[];
  readonly completionRefs: readonly CompletionRef[];
  readonly completionLookups: readonly CompletionReadInput[];
  readonly recovery: RecoveryHoldFacts;
}

/** One admitted execution segment, with actual producer handles bound before dispatch. */
export class ActiveTurnRecoveryCapture {
  private readonly producers: Array<{
    readonly producer: ActiveTurnProviderProducer;
    readonly release: () => void;
    readonly lifetime: Promise<void>;
  }> = [];
  private prepared: Promise<PreparedRecoveryCapture> | undefined;
  private boundaryId: string | undefined;

  constructor(
    private readonly context: ActiveTurnContext,
    private readonly readReferences: () => Promise<RecoveryCaptureReferences>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  bindProvider(producer: ActiveTurnProviderProducer): void {
    this.context.assertProductionOpen();
    if (this.producers.some((entry) => entry.producer === producer)) return;
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const lifetime = this.context.runProducer(() => done);
    this.producers.push({ producer, release, lifetime });
  }

  async prepare(boundaryId: string): Promise<PreparedRecoveryCapture> {
    if (this.boundaryId !== undefined && this.boundaryId !== boundaryId) {
      throw new RuntimeActiveTurnError('active-turn.capture.boundary-conflict', 'a capture segment has one boundary');
    }
    this.boundaryId = boundaryId;
    this.prepared ??= this.prepareOnce(boundaryId);
    return structuredClone(await this.prepared);
  }

  private async prepareOnce(boundaryId: string): Promise<PreparedRecoveryCapture> {
    // Closes child admission synchronously. Bound Provider lifetimes keep this
    // pending until their actual close/drain methods finish, including writes.
    const runtimeDrain = this.context.closeAndDrainProducers();
    const providerDrains = this.producers.map(async ({ producer, release, lifetime }) => {
      try {
        return await producer.closeProductionAndDrain({ execution: this.context.executionIdentity(), boundaryId });
      } finally {
        release();
        await lifetime;
      }
    });
    const results = await Promise.allSettled([runtimeDrain, ...providerDrains]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const initialInput = this.context.initialInput();
    if (!initialInput) throw new RuntimeActiveTurnError('active-turn.input.missing', 'capture requires the actual persisted initial input');
    const references = await this.readReferences();
    const body = this.context.capture({
      pauseId: boundaryId,
      frozenAt: this.now().toISOString(),
      initialInput,
      checkpointPath: references.checkpointPath,
      completionRefs: references.completionRefs,
    });
    const prepared: PreparedRecoveryCapture = {
      body,
      controlRecordCount: this.context.controlRecordCount(),
      producerDrains: await Promise.all(providerDrains),
      completionLookups: references.completionLookups,
      recovery: references.recovery,
    };
    validatePreparedRecoveryCapture(prepared);
    return prepared;
  }
}
