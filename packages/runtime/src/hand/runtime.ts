import {
  validateOperationIntent,
  type OperationId,
  type OperationIntent,
} from '../../../contracts/src/index.js';
import type {
  OperationSnapshot,
  ResolveReconcileInput,
  ResumeOperationInput,
  OperationSubmissionResult,
} from '../gateway/ports.js';
import type { ToolExecutionGateway } from '../gateway/gateway.js';

/**
 * Boundary from the implicit brain to a semantic virtual tool.
 *
 * The intent identifies one complete operation such as `code.symbol_search`.
 * The Hand runtime does not expose or schedule the route's internal shell,
 * read, parse, or edit steps; those belong to the registered gateway route.
 */
export interface HandOperationRequest {
  readonly intent: OperationIntent;
  readonly signal?: AbortSignal;
}

export interface HandOperationResult {
  readonly submission: OperationSubmissionResult;
  readonly operation: OperationSnapshot;
}

/**
 * Thin Hand execution boundary over the existing ToolExecutionGateway.
 * Gateway/Core remain the sole owners of admission, lifecycle, recovery, and
 * terminal truth. This class owns no duplicate operation state.
 */
export class HandOperationRuntime {
  constructor(private readonly gateway: ToolExecutionGateway) {}

  async execute(input: HandOperationRequest): Promise<HandOperationResult> {
    validateOperationIntent(input.intent);
    if (input.signal?.aborted) throw abortError();
    const submission = await this.gateway.submit(input.intent);
    if (!canStart(submission.operation.status)) {
      return { submission, operation: submission.operation };
    }
    let cancellation: Promise<void> | undefined;
    let cancellationFailure: unknown;
    const cancel = (): Promise<void> => {
      cancellation ??= (async () => {
        await this.gateway.requestCancel(input.intent.operationId);
        await this.gateway.settleCancellation(input.intent.operationId);
      })().catch((error: unknown) => {
        cancellationFailure = error;
      });
      return cancellation;
    };
    const onAbort = (): void => { void cancel(); };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    let operation: OperationSnapshot;
    let executionFailure: unknown;
    try {
      if (input.signal?.aborted) {
        await cancel();
        operation = this.gateway.get(input.intent.operationId);
      } else {
        operation = await this.gateway.execute(input.intent.operationId);
      }
    } catch (error) {
      executionFailure = error;
      operation = this.gateway.get(input.intent.operationId);
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      if (cancellation) await cancellation;
    }
    if (executionFailure !== undefined && cancellationFailure !== undefined) {
      throw new AggregateError([executionFailure, cancellationFailure], 'operation execution and cancellation both failed');
    }
    if (cancellationFailure !== undefined) throw cancellationFailure;
    if (executionFailure !== undefined) throw executionFailure;
    return { submission, operation };
  }

  async resume(
    operationId: OperationId,
    input: ResumeOperationInput = {},
  ): Promise<OperationSnapshot> {
    return this.gateway.resume(operationId, input);
  }

  async resolveReconcile(
    operationId: OperationId,
    input: ResolveReconcileInput,
  ): Promise<OperationSnapshot> {
    return this.gateway.resolveReconcile(operationId, input);
  }

  get(operationId: OperationId): OperationSnapshot {
    return this.gateway.get(operationId);
  }

  requestCancel(operationId: OperationId): Promise<OperationSnapshot> {
    return this.gateway.requestCancel(operationId);
  }

  settleCancellation(operationId: OperationId): Promise<OperationSnapshot> {
    return this.gateway.settleCancellation(operationId);
  }
}

function abortError(): Error {
  return Object.assign(new Error('operation was stopped before admission'), { name: 'AbortError' });
}

function canStart(status: OperationSnapshot['status']): boolean {
  return status === 'accepted' || status === 'queued';
}
