import { ContractError, validateToolExecutionFact } from '../../../contracts/src/index.js';
import type { RuntimeTaskEvent } from '../../../runtime/src/ui-runtime/coordinator.js';

export class ToolExecutionFactIntegrityError extends Error {
  readonly code = 'tool.execution-fact.integrity' as const;
  readonly ownerId = 'humanagent.app.projection' as const;
  readonly nextAction = 'repair or discard the UI runtime journal before restarting';

  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionFactIntegrityError';
  }
}

export type ToolExecutionFactOuterIdentity = {
  readonly taskId: { readonly scope: 'task'; readonly value: string };
  readonly operationId: { readonly scope: 'operation'; readonly value: string };
  readonly executionEpoch: number;
};

type PersistedJournalEvent = {
  readonly eventId: string;
  readonly seq: number;
  readonly occurredAt: string;
  readonly taskId: { readonly scope: 'task'; readonly value: string };
  readonly operationId: string;
  readonly executionEpoch: number;
  readonly kind: string;
  readonly state: string;
  readonly summary: string;
  readonly evidenceRefs: readonly unknown[];
  readonly turnId?: string;
  readonly requestId?: string;
  readonly parentRequestId?: string;
  readonly providerOccurredAt?: string;
  readonly callId?: string;
  readonly toolId?: string;
  readonly arguments?: unknown;
  readonly status?: RuntimeTaskEvent['status'];
  readonly error?: RuntimeTaskEvent['error'];
  readonly outputRef?: string;
  readonly outputDigest?: string;
  readonly executionFact?: unknown;
};

export function toolExecutionFactIntegrityError(message: string): ToolExecutionFactIntegrityError {
  return new ToolExecutionFactIntegrityError(message);
}

export function validatePersistedToolExecutionFact(
  event: PersistedJournalEvent,
  outer: ToolExecutionFactOuterIdentity,
): void {
  const fact = event.executionFact;
  if (fact === undefined) return;

  try {
    validateToolExecutionFact(fact);
  } catch (error) {
    if (error instanceof ContractError) {
      throw toolExecutionFactIntegrityError(`tool execution fact is malformed: ${error.message}`);
    }
    throw error;
  }
  if (event.kind !== 'provider.tool-result') {
    throw toolExecutionFactIntegrityError('tool execution fact requires provider.tool-result');
  }
  if (event.taskId.value !== outer.taskId.value || event.operationId !== outer.operationId.value || event.executionEpoch !== outer.executionEpoch) {
    throw toolExecutionFactIntegrityError('operation.event record and event identity differ');
  }
  if (event.toolId === undefined || event.callId === undefined || event.requestId === undefined) {
    throw toolExecutionFactIntegrityError('tool execution fact requires event tool, call and request');
  }
  if (fact.state !== event.status) {
    throw toolExecutionFactIntegrityError('tool execution fact requires matching event status');
  }
  if (fact.requestRef !== event.requestId) {
    throw toolExecutionFactIntegrityError('tool execution fact requires matching requestRef');
  }
  if (fact.callRef !== event.callId) {
    throw toolExecutionFactIntegrityError('tool execution fact requires matching callRef');
  }
  if (fact.operationRef !== event.operationId) {
    throw toolExecutionFactIntegrityError('tool execution fact requires matching operationRef');
  }
  if (fact.identity.toolId !== event.toolId) {
    throw toolExecutionFactIntegrityError('tool execution fact requires matching toolId');
  }
  if (fact.resultRef !== event.outputRef || fact.resultDigest !== event.outputDigest) {
    throw toolExecutionFactIntegrityError('tool execution fact requires matching output descriptor');
  }
}
