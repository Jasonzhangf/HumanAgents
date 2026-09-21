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
    const submission = await this.gateway.submit(input.intent);
    if (!canStart(submission.operation.status)) {
      return { submission, operation: submission.operation };
    }
    const operation = await this.gateway.execute(input.intent.operationId);
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
}

function canStart(status: OperationSnapshot['status']): boolean {
  return status === 'accepted' || status === 'queued';
}
