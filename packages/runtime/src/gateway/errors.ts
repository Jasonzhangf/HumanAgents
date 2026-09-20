import type {
  EvidenceRef,
  OperationEvent,
  OperationFailure,
  OperationStatus,
} from '../../../contracts/src/index.js';
import { RuntimeError, type RuntimeErrorContext } from '../nodes/errors.js';

export type GatewayErrorCode =
  | 'invalid-registration'
  | 'route-not-found'
  | 'permission-denied'
  | 'scope-denied'
  | 'idempotency-conflict'
  | 'invalid-state'
  | 'stale-epoch'
  | 'notification-failed';

export interface GatewayErrorContext extends RuntimeErrorContext {
  readonly operationStatus?: OperationStatus;
  readonly failure?: OperationFailure;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export class GatewayError extends RuntimeError {
  readonly code: GatewayErrorCode;
  readonly operationStatus?: OperationStatus;
  readonly failure?: OperationFailure;
  readonly evidenceRefs: readonly EvidenceRef[];

  constructor(code: GatewayErrorCode, message: string, context: GatewayErrorContext = {}) {
    super(message, context);
    this.name = 'GatewayError';
    this.code = code;
    this.operationStatus = context.operationStatus;
    this.failure = context.failure;
    this.evidenceRefs = [...(context.evidenceRefs ?? [])];
  }
}

export class OperationNotificationError extends GatewayError {
  readonly event: OperationEvent;

  constructor(event: OperationEvent, cause: unknown) {
    super(
      'notification-failed',
      `operation notification failed after commit: ${event.kind}`,
      {
        ownerRef: 'runtime-gateway',
        operationStatus: event.status,
        evidenceRefs: event.evidenceRefs,
        cause,
      },
    );
    this.name = 'OperationNotificationError';
    this.event = event;
  }
}
