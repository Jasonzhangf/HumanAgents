import {
  id,
  type AcpDriverBinding,
  type AcpServerBinding,
  type AgentCloseReceipt,
  type AgentDispatchReceipt,
  type AgentReconcileResult,
  type AgentSettleReceipt,
  type AgentStopReceipt,
  type EvidenceRef,
  type InteractionClosure,
} from '../../contracts/src/index.js';
import {
  ACP_DRIVER_OWNER,
  ACP_SERVER_OWNER,
  acpError,
} from './errors.js';
import type {
  AcpDriverCancelRequest,
  AcpDriverCloseRequest,
  AcpDriverLoadRequest,
  AcpDriverObserveRequest,
  AcpDriverOpenRequest,
  AcpDriverOpenResult,
  AcpDriverReconcileRequest,
  AcpDriverRequest,
  AcpDriverSettleRequest,
  AcpDriverTransport,
  AcpObservationUpdate,
  AcpRuntimeCapabilityRequest,
  AcpRuntimeCloseRequest,
  AcpRuntimeCloseResult,
  AcpRuntimeInteractionCancelRequest,
  AcpRuntimeLoadRequest,
  AcpRuntimeObserveRequest,
  AcpRuntimeOpenRequest,
  AcpRuntimeRequest,
  AcpRuntimeSession,
  AcpRuntimeTaskReconcileRequest,
  AcpRuntimeTaskSettleRequest,
  AcpRuntimeTaskStopRequest,
  AcpServerRuntimePort,
  AcpSessionRecord,
} from './types.js';

export type AcpFakeFailure =
  | 'transport-error'
  | 'no-response'
  | 'closed';

export interface AcpFakeTransportOptions {
  readonly failures?: readonly AcpFakeFailure[];
  readonly failuresByOperation?: Readonly<Record<string, AcpFakeFailure>>;
  readonly capabilities?: readonly string[];
  readonly sessionKinds?: readonly ('interaction' | 'task')[];
  readonly taskStopStatus?: AgentStopReceipt['status'];
  readonly taskStopOperationRef?: string;
  readonly closeResult?: boolean;
  readonly dispatchReceipt?: Partial<AgentDispatchReceipt>;
  readonly reconcileReceipt?: Partial<AgentReconcileResult>;
  readonly settleReceipt?: Partial<AgentSettleReceipt>;
  readonly interactionClosure?: Partial<InteractionClosure>;
  readonly version?: string;
}

interface FakeRuntimeSession {
  readonly record: AcpSessionRecord;
  readonly scopeRef: string;
  readonly history: AcpObservationUpdate[];
  cancelled: boolean;
}

function evidence(
  source: string,
  locator: string,
  scope: EvidenceRef['scope'] = { organId: id('organ', 'acp-fake') },
): EvidenceRef {
  return {
    evidenceId: id('evidence', `${source}-${locator}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128)),
    kind: 'external',
    source,
    locator,
    scope,
  };
}

function driverEvidence(binding: AcpDriverBinding, locator: string): EvidenceRef {
  return evidence(
    ACP_DRIVER_OWNER,
    `acp/driver/${binding.bindingRef}/${locator}`,
    {
      organId: id('organ', `acp-driver-${binding.bindingRef}`),
      ...(binding.taskId ? { taskId: binding.taskId } : {}),
    },
  );
}

function serverEvidence(binding: AcpServerBinding, locator: string): EvidenceRef {
  return evidence(ACP_SERVER_OWNER, `acp/server/${binding.bindingRef}/${locator}`, {
    organId: id('organ', `acp-server-${binding.bindingRef}`),
  });
}

function failIfConfigured(
  failures: readonly AcpFakeFailure[],
  failuresByOperation: Readonly<Record<string, AcpFakeFailure>>,
  operation: string,
  ownerId: string,
  evidenceRef: EvidenceRef,
): void {
  const configured = failuresByOperation[operation];
  if (configured === 'closed' || failures.includes('closed')) {
    throw acpError('transport-closed', `fake ACP transport is closed during ${operation}`, ownerId, { kind: 'recover', ref: 'open-transport' }, [evidenceRef]);
  }
  if (configured === 'no-response' || failures.includes('no-response')) {
    throw acpError('no-response', `fake ACP transport did not respond during ${operation}`, ownerId, { kind: 'recover', ref: 'retry-observation' }, [evidenceRef]);
  }
  if (configured === 'transport-error' || failures.includes('transport-error')) {
    throw acpError('transport-failure', `fake ACP transport failed during ${operation}`, ownerId, { kind: 'recover', ref: 'inspect-transport' }, [evidenceRef]);
  }
}

export class DeterministicAcpRuntimeTransport implements AcpServerRuntimePort {
  private readonly sessions = new Map<string, FakeRuntimeSession>();
  private readonly capabilitiesList: readonly string[];
  private readonly sessionKinds: readonly ('interaction' | 'task')[];
  private readonly failures: readonly AcpFakeFailure[];
  private readonly failuresByOperation: Readonly<Record<string, AcpFakeFailure>>;
  private readonly options: AcpFakeTransportOptions;
  private closeCount = 0;

  constructor(
    private readonly binding: AcpServerBinding,
    options: AcpFakeTransportOptions = {},
  ) {
    this.failures = [...(options.failures ?? [])];
    this.failuresByOperation = { ...(options.failuresByOperation ?? {}) };
    this.options = options;
    this.sessionKinds = [...(options.sessionKinds ?? this.binding.allowedSessionKinds)];
    this.capabilitiesList = [...(options.capabilities ?? [
      'session.open',
      'session.load',
      'observe',
      'request',
      'cancel',
      'reconcile',
      'settle',
    ])];
  }

  async capabilities(_input: AcpRuntimeCapabilityRequest): Promise<import('./types.js').AcpCapabilitySet> {
    failIfConfigured(this.failures, this.failuresByOperation, 'capabilities', ACP_SERVER_OWNER, serverEvidence(this.binding, 'capabilities'));
    return {
      capabilities: this.capabilitiesList,
      sessionKinds: [...this.sessionKinds],
      version: 'fake-acp-1',
      evidenceRefs: [serverEvidence(this.binding, 'capabilities')],
    };
  }

  async open(input: AcpRuntimeOpenRequest): Promise<AcpRuntimeSession> {
    failIfConfigured(this.failures, this.failuresByOperation, 'open', ACP_SERVER_OWNER, serverEvidence(this.binding, 'open'));
    const runtimeId = `acp-runtime-${input.acpSessionId}`;
    const openedAt = '2026-09-17T00:00:00.000Z';
    const record: AcpSessionRecord = {
      acpSessionId: input.acpSessionId,
      binding: input.binding,
      runtimeId,
      permissionRevision: input.permissionRevision,
      capabilities: [...input.requestedCapabilities],
      evidenceRefs: [serverEvidence(this.binding, `open-${input.acpSessionId}`)],
      openedAt,
    };
    this.sessions.set(input.acpSessionId, { record, scopeRef: input.scopeRef, history: [], cancelled: false });
    return {
      binding: input.binding,
      runtimeId,
      permissionRevision: input.permissionRevision,
      capabilities: [...input.requestedCapabilities],
      evidenceRefs: [...record.evidenceRefs],
      openedAt,
    };
  }

  async load(input: AcpRuntimeLoadRequest): Promise<AcpRuntimeSession> {
    failIfConfigured(this.failures, this.failuresByOperation, 'load', ACP_SERVER_OWNER, serverEvidence(this.binding, 'load'));
    const existing = this.sessions.get(input.acpSessionId);
    if (existing) {
      return {
        binding: existing.record.binding,
        runtimeId: existing.record.runtimeId,
        permissionRevision: existing.record.permissionRevision,
        capabilities: [...existing.record.capabilities],
        evidenceRefs: [...existing.record.evidenceRefs],
        openedAt: existing.record.openedAt,
      };
    }
    if (input.binding.kind === 'task'
      && input.expectedExecutionEpoch !== undefined
      && input.expectedExecutionEpoch !== input.binding.executionEpoch) {
      throw acpError(
        'stale-execution',
        'fake ACP runtime rejected a stale execution epoch',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reload-current-execution' },
        [serverEvidence(this.binding, 'stale-load')],
      );
    }
    const runtimeId = `acp-runtime-${input.acpSessionId}`;
    const openedAt = '2026-09-17T00:00:00.000Z';
    const record: AcpSessionRecord = {
      acpSessionId: input.acpSessionId,
      binding: input.binding,
      runtimeId,
      permissionRevision: input.permissionRevision,
      capabilities: [...input.requestedCapabilities],
      evidenceRefs: [serverEvidence(this.binding, `load-${input.acpSessionId}`)],
      openedAt,
    };
    this.sessions.set(input.acpSessionId, { record, scopeRef: input.scopeRef, history: [], cancelled: false });
    return {
      binding: input.binding,
      runtimeId,
      permissionRevision: input.permissionRevision,
      capabilities: [...input.requestedCapabilities],
      evidenceRefs: [...record.evidenceRefs],
      openedAt,
    };
  }

  async *observe(input: AcpRuntimeObserveRequest): AsyncIterable<AcpObservationUpdate> {
    failIfConfigured(this.failures, this.failuresByOperation, 'observe', ACP_SERVER_OWNER, serverEvidence(this.binding, 'observe'));
    const session = this.sessions.get(input.acpSessionId);
    if (!session) {
      throw acpError(
        'session-not-found',
        'fake ACP runtime session is not open',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'open-session' },
        [serverEvidence(this.binding, 'missing-observe')],
      );
    }
    const cursor = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    for (const update of session.history.slice(Number.isFinite(cursor) ? cursor : 0)) yield { ...update, evidenceRefs: [...update.evidenceRefs] };
  }

  async request(input: AcpRuntimeRequest): Promise<AgentDispatchReceipt> {
    failIfConfigured(this.failures, this.failuresByOperation, 'request', ACP_SERVER_OWNER, serverEvidence(this.binding, 'request'));
    const session = this.sessions.get(input.acpSessionId);
    if (!session) {
      throw acpError(
        'session-not-found',
        'fake ACP runtime session is not open',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'open-session' },
        [serverEvidence(this.binding, 'missing-request')],
      );
    }
    const sequence = session.history.length + 1;
    const update: AcpObservationUpdate = {
      sequence,
      cursor: String(sequence),
      kind: 'progress',
      summary: 'deterministic fake progress',
      evidenceRefs: [serverEvidence(this.binding, `update-${sequence}`)],
    };
    session.history.push(update);
    return {
      requestId: input.envelope.control.requestId,
      attemptId: input.envelope.control.attemptId,
      runtimeId: session.record.runtimeId,
      executionEpoch: input.envelope.control.binding.kind === 'task' ? input.envelope.control.binding.executionEpoch : 1,
      driverRef: 'deterministic-acp-fake',
      status: 'accepted',
      evidenceRefs: [...update.evidenceRefs],
      ...this.options.dispatchReceipt,
    };
  }

  async cancelInteraction(input: AcpRuntimeInteractionCancelRequest): Promise<InteractionClosure> {
    failIfConfigured(this.failures, this.failuresByOperation, 'cancel-interaction', ACP_SERVER_OWNER, serverEvidence(this.binding, 'cancel-interaction'));
    const session = this.sessions.get(input.acpSessionId);
    if (!session || session.record.binding.kind !== 'interaction') {
      throw acpError(
        'session-kind-mismatch',
        'fake ACP interaction cancel requires an interaction session',
        ACP_SERVER_OWNER,
        { kind: 'stop', ref: 'reject-interaction-cancel' },
        [serverEvidence(this.binding, 'cancel-kind')],
      );
    }
    session.cancelled = true;
    return {
      interactionScopeId: input.interactionScopeId,
      requestId: input.requestId,
      attemptId: input.attemptId,
      disposition: 'cancelled',
      inputRefs: [],
      feedbackRefs: [],
      evidenceRefs: [serverEvidence(this.binding, `interaction-closure-${input.requestId}`)],
      closureRef: `interaction-closure-${input.requestId}`,
      closedAt: '2026-09-17T00:00:00.000Z',
      ...this.options.interactionClosure,
    };
  }

  async requestTaskStop(input: AcpRuntimeTaskStopRequest): Promise<AgentStopReceipt> {
    failIfConfigured(this.failures, this.failuresByOperation, 'task-stop', ACP_SERVER_OWNER, serverEvidence(this.binding, 'task-stop'));
    return {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runtimeId: input.runtimeId,
      executionEpoch: input.executionEpoch,
      driverRef: 'deterministic-acp-fake',
      status: this.options.taskStopStatus ?? 'accepted',
      operationRef: input.operationId.value,
      ...(this.options.taskStopOperationRef === undefined ? {} : { operationRef: this.options.taskStopOperationRef }),
      evidenceRefs: [serverEvidence(this.binding, `task-stop-${input.requestId}`)],
    };
  }

  async reconcileTask(input: AcpRuntimeTaskReconcileRequest): Promise<AgentReconcileResult> {
    failIfConfigured(this.failures, this.failuresByOperation, 'reconcile', ACP_SERVER_OWNER, serverEvidence(this.binding, 'reconcile'));
    return {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runtimeId: input.runtimeId,
      executionEpoch: input.executionEpoch,
      driverRef: 'deterministic-acp-fake',
      operationRef: input.operationRef,
      reconciled: true,
      status: 'accepted',
      evidenceRefs: [serverEvidence(this.binding, `reconcile-${input.operationRef}`)],
      ...this.options.reconcileReceipt,
    };
  }

  async settleTask(input: AcpRuntimeTaskSettleRequest): Promise<AgentSettleReceipt> {
    failIfConfigured(this.failures, this.failuresByOperation, 'settle', ACP_SERVER_OWNER, serverEvidence(this.binding, 'settle'));
    return {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runtimeId: input.runtimeId,
      executionEpoch: input.executionEpoch,
      driverRef: 'deterministic-acp-fake',
      state: 'stopped',
      status: 'accepted',
      evidenceRefs: [serverEvidence(this.binding, `settle-${input.requestId}`)],
      ...this.options.settleReceipt,
    };
  }

  async close(_input: AcpRuntimeCloseRequest): Promise<AcpRuntimeCloseResult> {
    failIfConfigured(this.failures, this.failuresByOperation, 'close', ACP_SERVER_OWNER, serverEvidence(this.binding, 'close'));
    this.closeCount += 1;
    return {
      closed: this.options.closeResult ?? true,
      evidenceRefs: [serverEvidence(this.binding, `close-${this.closeCount}`)],
    };
  }
}

export class DeterministicAcpDriverTransport implements AcpDriverTransport {
  private readonly failures: readonly AcpFakeFailure[];
  private readonly failuresByOperation: Readonly<Record<string, AcpFakeFailure>>;
  private readonly options: AcpFakeTransportOptions;
  private readonly capabilitiesList: readonly string[];
  private readonly sessionKinds: readonly ('interaction' | 'task')[];
  private readonly sessions = new Map<string, AcpDriverOpenResult>();
  private closeCount = 0;

  constructor(
    private readonly binding: AcpDriverBinding,
    options: AcpFakeTransportOptions = {},
  ) {
    this.failures = [...(options.failures ?? [])];
    this.failuresByOperation = { ...(options.failuresByOperation ?? {}) };
    this.options = options;
    this.sessionKinds = [...(options.sessionKinds ?? ['interaction', 'task'])];
    this.capabilitiesList = [...(options.capabilities ?? [
      'session.open',
      'session.load',
      'observe',
      'request',
      'cancel',
      'reconcile',
      'settle',
    ])];
  }

  async capabilities(_binding: AcpDriverBinding): Promise<import('./types.js').AcpCapabilitySet> {
    failIfConfigured(this.failures, this.failuresByOperation, 'capabilities', ACP_DRIVER_OWNER, driverEvidence(this.binding, 'capabilities'));
    return {
      capabilities: this.capabilitiesList,
      sessionKinds: [...this.sessionKinds],
      version: 'fake-acp-1',
      evidenceRefs: [driverEvidence(this.binding, 'capabilities')],
    };
  }

  async open(input: AcpDriverOpenRequest): Promise<AcpDriverOpenResult> {
    failIfConfigured(this.failures, this.failuresByOperation, 'open', ACP_DRIVER_OWNER, driverEvidence(this.binding, 'open'));
    const result = {
      externalSessionRef: `fake-acp-session-${input.acpSessionId}`,
      executionEpoch: input.binding.kind === 'task' ? input.binding.executionEpoch : 1,
      evidenceRefs: [driverEvidence(this.binding, `open-${input.acpSessionId}`)],
    };
    this.sessions.set(input.acpSessionId, result);
    return result;
  }

  async load(input: AcpDriverLoadRequest): Promise<AcpDriverOpenResult> {
    failIfConfigured(this.failures, this.failuresByOperation, 'load', ACP_DRIVER_OWNER, driverEvidence(this.binding, 'load'));
    const result = {
      externalSessionRef: `fake-acp-session-${input.acpSessionId}`,
      executionEpoch: input.binding.kind === 'task' ? input.binding.executionEpoch : 1,
      evidenceRefs: [driverEvidence(this.binding, `load-${input.acpSessionId}`)],
    };
    this.sessions.set(input.acpSessionId, result);
    return result;
  }

  async *observe(input: AcpDriverObserveRequest): AsyncIterable<AcpObservationUpdate> {
    failIfConfigured(this.failures, this.failuresByOperation, 'observe', ACP_DRIVER_OWNER, driverEvidence(this.binding, 'observe'));
    const session = this.sessions.get(input.acpSessionId);
    if (!session) {
      throw acpError(
        'session-not-found',
        'fake ACP driver session is not open',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'open-session' },
        [driverEvidence(this.binding, 'missing-observe')],
      );
    }
    yield {
      sequence: 1,
      cursor: '1',
      kind: 'progress',
      summary: 'deterministic fake driver progress',
      evidenceRefs: [driverEvidence(this.binding, 'update-1')],
    };
  }

  async request(input: AcpDriverRequest): Promise<AgentDispatchReceipt> {
    failIfConfigured(this.failures, this.failuresByOperation, 'request', ACP_DRIVER_OWNER, driverEvidence(this.binding, 'request'));
    return {
      requestId: input.envelope.control.requestId,
      attemptId: input.envelope.control.attemptId,
      runtimeId: this.binding.taskId ? `runtime-${this.binding.taskId.value}` : `runtime-${this.binding.bindingRef}`,
      executionEpoch: input.envelope.control.binding.kind === 'task' ? input.envelope.control.binding.executionEpoch : this.binding.executionEpoch,
      driverRef: 'deterministic-acp-driver-fake',
      status: 'accepted',
      evidenceRefs: [driverEvidence(this.binding, `request-${input.envelope.control.requestId}`)],
      ...this.options.dispatchReceipt,
    };
  }

  async cancelInteraction(input: AcpDriverCancelRequest): Promise<InteractionClosure> {
    failIfConfigured(this.failures, this.failuresByOperation, 'cancel-interaction', ACP_DRIVER_OWNER, driverEvidence(this.binding, 'cancel-interaction'));
    return {
      interactionScopeId: `interaction-${input.acpSessionId}`,
      requestId: input.requestId,
      attemptId: input.attemptId,
      disposition: 'cancelled',
      inputRefs: [],
      feedbackRefs: [],
      evidenceRefs: [driverEvidence(this.binding, `interaction-closure-${input.requestId}`)],
      closureRef: `interaction-closure-${input.requestId}`,
      closedAt: '2026-09-17T00:00:00.000Z',
      ...this.options.interactionClosure,
    };
  }

  async requestStop(input: AcpDriverCancelRequest): Promise<AgentStopReceipt> {
    failIfConfigured(this.failures, this.failuresByOperation, 'task-stop', ACP_DRIVER_OWNER, driverEvidence(this.binding, 'task-stop'));
    return {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runtimeId: this.binding.taskId ? `runtime-${this.binding.taskId.value}` : `runtime-${this.binding.bindingRef}`,
      executionEpoch: this.binding.executionEpoch,
      driverRef: 'deterministic-acp-driver-fake',
      status: this.options.taskStopStatus ?? 'accepted',
      operationRef: input.operationId?.value,
      ...(this.options.taskStopOperationRef === undefined ? {} : { operationRef: this.options.taskStopOperationRef }),
      evidenceRefs: [driverEvidence(this.binding, `task-stop-${input.requestId}`)],
    };
  }

  async reconcile(input: AcpDriverReconcileRequest): Promise<AgentReconcileResult> {
    failIfConfigured(this.failures, this.failuresByOperation, 'reconcile', ACP_DRIVER_OWNER, driverEvidence(this.binding, 'reconcile'));
    return {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runtimeId: this.binding.taskId ? `runtime-${this.binding.taskId.value}` : `runtime-${this.binding.bindingRef}`,
      executionEpoch: this.binding.executionEpoch,
      driverRef: 'deterministic-acp-driver-fake',
      operationRef: input.operationRef,
      reconciled: true,
      status: 'accepted',
      evidenceRefs: [driverEvidence(this.binding, `reconcile-${input.operationRef}`)],
      ...this.options.reconcileReceipt,
    };
  }

  async settle(input: AcpDriverSettleRequest): Promise<AgentSettleReceipt> {
    failIfConfigured(this.failures, this.failuresByOperation, 'settle', ACP_DRIVER_OWNER, driverEvidence(this.binding, 'settle'));
    return {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runtimeId: this.binding.taskId ? `runtime-${this.binding.taskId.value}` : `runtime-${this.binding.bindingRef}`,
      executionEpoch: this.binding.executionEpoch,
      driverRef: 'deterministic-acp-driver-fake',
      state: 'stopped',
      status: 'accepted',
      evidenceRefs: [driverEvidence(this.binding, `settle-${input.requestId}`)],
      ...this.options.settleReceipt,
    };
  }

  async close(input: AcpDriverCloseRequest): Promise<AgentCloseReceipt> {
    failIfConfigured(this.failures, this.failuresByOperation, 'close', ACP_DRIVER_OWNER, driverEvidence(this.binding, 'close'));
    this.closeCount += 1;
    return {
      requestId: input.requestId,
      attemptId: input.attemptId,
      runtimeId: this.binding.taskId ? `runtime-${this.binding.taskId.value}` : `runtime-${this.binding.bindingRef}`,
      executionEpoch: this.binding.executionEpoch,
      driverRef: 'deterministic-acp-driver-fake',
      status: 'accepted',
      closed: this.options.closeResult ?? true,
      evidenceRefs: [driverEvidence(this.binding, `close-${this.closeCount}`)],
    };
  }
}
