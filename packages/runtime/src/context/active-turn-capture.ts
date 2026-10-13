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
