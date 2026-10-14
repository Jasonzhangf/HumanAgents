import type {
  ActiveTurnProviderExecutionIdentityRef,
  CompletionReadInput,
  ProviderProducerDrainResult,
  RecoveryHoldFacts,
} from '../../../contracts/src/index.js';
import {
  validatePreparedActiveTurnSegmentCaptureV2,
  type ActiveTurnSegmentCaptureV2,
  type PreparedActiveTurnSegmentCaptureV2,
} from '../../../contracts/src/active-turn-segments.js';

/**
 * One active turn's admitted producer work. Register the whole operation before
 * starting it; its promise must include observation and the last durable write.
 * Closing admission does not cancel work already owned by the turn.
 */
export class ActiveTurnProducerBarrier {
  private closed = false;
  private readonly pending = new Set<Promise<void>>();
  private failure: { readonly cause: unknown } | undefined;
  private drain: Promise<void> | undefined;

  assertOpen(): void {
    if (this.closed) throw new Error('active-turn production admission is closed');
  }

  run<T>(produce: () => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('active-turn production admission is closed'));
    // Scheduling the callback after registration also covers synchronous throws
    // and a producer which asks to close admission from within its callback.
    const result = Promise.resolve().then(produce);
    const tracked = result.then(
      () => { this.pending.delete(tracked); },
      (cause: unknown) => {
        this.failure ??= { cause };
        this.pending.delete(tracked);
      },
    );
    this.pending.add(tracked);
    return result;
  }

  /** Wait for every admitted operation, even when another operation failed. */
  closeAndDrain(): Promise<void> {
    this.closed = true;
    this.drain ??= Promise.all([...this.pending]).then(() => {
      if (this.failure) throw this.failure.cause;
    });
    return this.drain;
  }
}

/**
 * A bound Provider producer for one resumed segment. `closeProductionAndDrain`
 * returns the actual drain result for this segment's boundary and execution.
 */
export interface ActiveTurnSegmentProviderProducer {
  closeProductionAndDrain(input: {
    readonly execution: ActiveTurnProviderExecutionIdentityRef;
    readonly boundaryId: string;
  }): Promise<ProviderProducerDrainResult>;
}

export interface SegmentRecoveryCaptureReferences {
  readonly completionLookups: readonly CompletionReadInput[];
  readonly recovery: RecoveryHoldFacts;
}

/**
 * Narrow owner port the capture adapter needs from a segment context. Keeping it
 * narrow avoids a context <-> capture import cycle and keeps the capture owner
 * free of the mutable record surface.
 */
export interface ActiveTurnSegmentCaptureOwner {
  executionIdentity(): ActiveTurnProviderExecutionIdentityRef;
  runProducer<T>(produce: () => T | Promise<T>): Promise<T>;
  assertProductionOpen(): void;
  closeAndDrainProducers(): Promise<void>;
  captureSegment(input: { readonly boundaryId: string; readonly frozenAt: string }): ActiveTurnSegmentCaptureV2;
  controlRecordCount(): number;
}

/**
 * The real v2 producer-drain capture boundary for one resumed segment. Closing
 * admission synchronously freezes the segment; the returned prepared capture
 * waits for the bound Provider lifetimes and the durable mutation queue, then
 * carries the actual scoped drains plus completion/recovery references. A
 * boolean or a fabricated receipt never stands in for a real drain.
 */
export class ActiveTurnSegmentRecoveryCapture {
  private readonly producers: Array<{
    readonly producer: ActiveTurnSegmentProviderProducer;
    readonly release: () => void;
    readonly lifetime: Promise<void>;
  }> = [];
  private prepared: Promise<PreparedActiveTurnSegmentCaptureV2> | undefined;
  private boundaryId: string | undefined;

  constructor(
    private readonly context: ActiveTurnSegmentCaptureOwner,
    private readonly readReferences: () => Promise<SegmentRecoveryCaptureReferences>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  bindProvider(producer: ActiveTurnSegmentProviderProducer): void {
    this.context.assertProductionOpen();
    if (this.producers.some((entry) => entry.producer === producer)) return;
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const lifetime = this.context.runProducer(() => done);
    this.producers.push({ producer, release, lifetime });
  }

  async prepare(boundaryId: string): Promise<PreparedActiveTurnSegmentCaptureV2> {
    if (this.boundaryId !== undefined && this.boundaryId !== boundaryId) {
      throw new Error('active-turn.segment-capture.boundary-conflict: a segment capture has one boundary');
    }
    this.boundaryId = boundaryId;
    this.prepared ??= this.prepareOnce(boundaryId);
    return structuredClone(await this.prepared);
  }

  private async prepareOnce(boundaryId: string): Promise<PreparedActiveTurnSegmentCaptureV2> {
    // Closing admission synchronously freezes the segment. Bound Provider
    // lifetimes keep this pending until their actual close/drain finishes,
    // including their durable writes.
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
    const references = await this.readReferences();
    const body = this.context.captureSegment({ boundaryId, frozenAt: this.now().toISOString() });
    const prepared: PreparedActiveTurnSegmentCaptureV2 = {
      body,
      controlRecordCount: this.context.controlRecordCount(),
      producerDrains: await Promise.all(providerDrains),
      completionLookups: references.completionLookups,
      recovery: references.recovery,
    };
    validatePreparedActiveTurnSegmentCaptureV2(prepared);
    return prepared;
  }
}
