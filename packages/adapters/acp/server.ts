import {
  validateAgentBinding,
  validateAgentDispatchReceipt,
  validateAgentRequestEnvelope,
  validateAgentReconcileResult,
  validateAgentSettleReceipt,
  validateAgentStopReceipt,
  validateInteractionClosure,
  type AcpServerBinding,
  type AgentBinding,
  type AgentDispatchReceipt,
  type AgentReconcileResult,
  type AgentSettleReceipt,
  type AgentStopReceipt,
  type EvidenceRef,
  type InteractionClosure,
} from '../../contracts/src/index.js';
import { AcpServerBindingGuard, sameAgentBinding } from './binding.js';
import {
  ACP_SERVER_OWNER,
  AcpAdapterError,
  acpError,
  capabilityUnavailable,
} from './errors.js';
import type {
  AcpCancelReceipt,
  AcpCancelRequest,
  AcpCloseReceipt,
  AcpCloseRequest,
  AcpInitializeRequest,
  AcpLoadRequest,
  AcpNegotiatedCapabilities,
  AcpObservationUpdate,
  AcpObserveRequest,
  AcpOpenRequest,
  AcpReconcileRequest,
  AcpRequest,
  AcpServerPort,
  AcpServerRuntimePort,
  AcpSessionRecord,
  AcpSettleRequest,
} from './types.js';

interface ServerSession {
  readonly record: AcpSessionRecord;
  readonly scopeRef: string;
}

function sessionEvidenceForId(acpSessionId: string, locator: string): EvidenceRef {
  return {
    evidenceId: {
      scope: 'evidence',
      value: `acp-session-${acpSessionId}-${locator}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128),
    },
    kind: 'external',
    source: ACP_SERVER_OWNER,
    locator: `acp/session/${acpSessionId}/${locator}`,
    scope: { organId: { scope: 'organ', value: `acp-session-${acpSessionId}` } },
  };
}

function serverTransportFailure(binding: AcpServerBinding, phase: string, error: unknown): never {
  if (error instanceof AcpAdapterError) throw error;
  throw acpError(
    'transport-failure',
    error instanceof Error ? error.message : `ACP runtime failed during ${phase}`,
    ACP_SERVER_OWNER,
    { kind: 'recover', ref: `acp-runtime:${phase}` },
    [sessionEvidenceForId(binding.bindingRef, `transport-${phase}`)],
    { binding, cause: error },
  );
}

function assertNonEmpty(value: string | undefined, label: string, evidenceRefs: readonly EvidenceRef[]): asserts value is string {
  if (!value?.trim()) {
    throw acpError(
      'protocol-error',
      `ACP ${label} is required`,
      ACP_SERVER_OWNER,
      { kind: 'stop', ref: `reject-${label}` },
      evidenceRefs,
    );
  }
}

function assertAttemptIdentity(
  input: { readonly requestId: string; readonly attemptId: string },
  evidenceRefs: readonly EvidenceRef[],
): void {
  assertNonEmpty(input.requestId, 'requestId', evidenceRefs);
  assertNonEmpty(input.attemptId, 'attemptId', evidenceRefs);
}

function assertTaskReceiptIdentity(
  receipt: AgentStopReceipt | AgentReconcileResult | AgentSettleReceipt,
  session: ServerSession,
  requestId: string,
  attemptId: string,
  binding: AcpServerBinding,
): void {
  const executionEpoch = session.record.binding.kind === 'task'
    ? session.record.binding.executionEpoch
    : receipt.executionEpoch;
  if (receipt.requestId !== requestId || receipt.attemptId !== attemptId) {
    throw acpError(
      'identity-mismatch',
      'ACP runtime receipt does not match the requested attempt',
      ACP_SERVER_OWNER,
      { kind: 'recover', ref: 'reconcile-runtime-receipt' },
      session.record.evidenceRefs,
      { binding },
    );
  }
  if (receipt.runtimeId !== session.record.runtimeId || receipt.executionEpoch !== executionEpoch) {
    throw acpError(
      'identity-mismatch',
      'ACP runtime receipt does not match the session execution identity',
      ACP_SERVER_OWNER,
      { kind: 'recover', ref: 'reconcile-runtime-receipt' },
      session.record.evidenceRefs,
      { binding },
    );
  }
}

function validateRuntimeInteractionClosure(
  closure: InteractionClosure,
  session: ServerSession,
  input: { readonly requestId: string; readonly attemptId: string },
  binding: AcpServerBinding,
): void {
  try {
    validateInteractionClosure(closure);
  } catch (error) {
    throw acpError(
      'protocol-error',
      error instanceof Error ? error.message : 'ACP interaction closure is invalid',
      ACP_SERVER_OWNER,
      { kind: 'recover', ref: 'reconcile-interaction-closure' },
      session.record.evidenceRefs,
      { binding, cause: error },
    );
  }
  if (session.record.binding.kind !== 'interaction'
    || closure.interactionScopeId !== session.record.binding.interactionScopeId
    || closure.requestId !== input.requestId
    || closure.attemptId !== input.attemptId) {
    throw acpError(
      'identity-mismatch',
      'ACP interaction closure does not match the cancelled interaction',
      ACP_SERVER_OWNER,
      { kind: 'recover', ref: 'reconcile-interaction-closure' },
      session.record.evidenceRefs,
      { binding },
    );
  }
}

export class AcpServerAdapter implements AcpServerPort {
  private readonly binding: AcpServerBinding;
  private readonly guard: AcpServerBindingGuard;
  private readonly sessions = new Map<string, ServerSession>();
  private readonly closedSessions = new Map<string, AcpCloseReceipt>();
  private negotiated?: AcpNegotiatedCapabilities;

  constructor(
    binding: AcpServerBinding,
    private readonly runtime: AcpServerRuntimePort,
  ) {
    this.binding = binding;
    this.guard = new AcpServerBindingGuard(binding);
  }

  async initialize(input: AcpInitializeRequest): Promise<AcpNegotiatedCapabilities> {
    this.guard.assertProof(input.proof);
    const negotiated = this.guard.negotiate(input.requestedCapabilities, input.requestedSessionKinds);
    let runtimeCapabilities;
    try {
      runtimeCapabilities = await this.runtime.capabilities({
        bindingRef: this.binding.bindingRef,
        principalRef: this.binding.principalRef,
        scopeRef: this.binding.scopeRef,
        permissionRevision: this.binding.permissionRevision,
      });
    } catch (error) {
      return serverTransportFailure(this.binding, 'initialize', error);
    }
    const capabilities = negotiated.capabilities.filter((capability) => runtimeCapabilities.capabilities.includes(capability));
    if (input.requestedCapabilities.length > 0 && capabilities.length === 0) {
      throw capabilityUnavailable('runtime does not provide the requested ACP capabilities', ACP_SERVER_OWNER, negotiated.evidenceRefs, this.binding);
    }
    const sessionKinds = negotiated.sessionKinds.filter((kind) => runtimeCapabilities.sessionKinds.includes(kind));
    if (input.requestedSessionKinds.length > 0 && sessionKinds.length === 0) {
      throw capabilityUnavailable('runtime does not provide the requested ACP session kinds', ACP_SERVER_OWNER, negotiated.evidenceRefs, this.binding);
    }
    this.negotiated = {
      bindingRef: this.binding.bindingRef,
      capabilities,
      sessionKinds,
      version: runtimeCapabilities.version,
      evidenceRefs: [...negotiated.evidenceRefs, ...runtimeCapabilities.evidenceRefs],
      requestedCapabilities: [...input.requestedCapabilities],
    };
    return this.negotiated;
  }

  async open(input: AcpOpenRequest): Promise<AcpSessionRecord> {
    this.assertInitialized();
    this.guard.assertProof(input.proof);
    const capability = 'session.open';
    this.guard.assert({
      kind: input.binding.kind,
      capability,
      ...input.proof,
    });
    this.assertCapability(capability);
    this.assertSessionKind(input.binding.kind);
    const requested = input.requestedCapabilities.length > 0 ? input.requestedCapabilities : this.negotiated!.capabilities;
    for (const requestedCapability of requested) this.assertCapability(requestedCapability);
    const existing = this.sessions.get(input.acpSessionId);
    if (existing) {
      this.assertSessionBinding(existing, input.binding, 'open');
      return this.cloneRecord(existing.record);
    }
    if (this.closedSessions.has(input.acpSessionId)) {
      throw acpError(
        'session-not-found',
        'ACP session was closed and cannot be reopened with the same transport identity',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'open-new-session' },
        [sessionEvidenceForId(input.acpSessionId, 'closed')],
        { binding: this.binding },
      );
    }
    let opened;
    try {
      opened = await this.runtime.open({
        binding: input.binding,
        acpSessionId: input.acpSessionId,
        principalRef: input.proof.principalRef,
        scopeRef: input.proof.scopeRef,
        permissionRevision: input.proof.permissionRevision,
        requestedCapabilities: requested,
      });
    } catch (error) {
      return serverTransportFailure(this.binding, 'open', error);
    }
    try {
      validateAgentBinding(opened.binding);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP runtime returned an invalid binding',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-binding' },
        opened.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    if (!sameAgentBinding(input.binding, opened.binding)) {
      throw acpError(
        'identity-mismatch',
        'ACP runtime open returned a different HumanAgent binding',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-binding' },
        opened.evidenceRefs,
        { binding: this.binding },
      );
    }
    if (opened.permissionRevision !== input.proof.permissionRevision) {
      throw acpError(
        'identity-mismatch',
        'ACP runtime open returned a different permission revision',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-permission' },
        opened.evidenceRefs,
        { binding: this.binding },
      );
    }
    const record: AcpSessionRecord = {
      acpSessionId: input.acpSessionId,
      binding: opened.binding,
      runtimeId: opened.runtimeId,
      permissionRevision: opened.permissionRevision,
      capabilities: opened.capabilities.filter((capability) => requested.includes(capability)),
      evidenceRefs: [...opened.evidenceRefs],
      openedAt: opened.openedAt,
    };
    this.sessions.set(input.acpSessionId, { record, scopeRef: input.proof.scopeRef });
    return this.cloneRecord(record);
  }

  async load(input: AcpLoadRequest): Promise<AcpSessionRecord> {
    this.assertInitialized();
    this.guard.assertProof(input.proof);
    this.guard.assert({
      kind: input.binding.kind,
      capability: 'session.load',
      ...input.proof,
    });
    this.assertCapability('session.load');
    this.assertSessionKind(input.binding.kind);
    if (input.binding.kind === 'task'
      && (input.expectedExecutionEpoch === undefined
        || input.expectedExecutionEpoch !== input.binding.executionEpoch)) {
      throw acpError(
        'stale-execution',
        'task session load requires the expected execution epoch to match the binding',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reload-current-execution' },
        [],
        { binding: this.binding },
      );
    }
    const existing = this.sessions.get(input.acpSessionId);
    if (existing) this.assertSessionBinding(existing, input.binding, 'load');
    let opened;
    try {
      opened = await this.runtime.load({
        binding: input.binding,
        acpSessionId: input.acpSessionId,
        principalRef: input.proof.principalRef,
        scopeRef: input.proof.scopeRef,
        permissionRevision: input.proof.permissionRevision,
        requestedCapabilities: this.negotiated!.capabilities,
        ...(input.expectedExecutionEpoch === undefined ? {} : { expectedExecutionEpoch: input.expectedExecutionEpoch }),
        ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
        reason: input.reason,
      });
    } catch (error) {
      return serverTransportFailure(this.binding, 'load', error);
    }
    try {
      validateAgentBinding(opened.binding);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP runtime returned an invalid binding',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-binding' },
        opened.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    if (!sameAgentBinding(input.binding, opened.binding)) {
      throw acpError(
        'identity-mismatch',
        'ACP runtime load returned a different HumanAgent binding',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-binding' },
        opened.evidenceRefs,
        { binding: this.binding },
      );
    }
    if (opened.permissionRevision !== input.proof.permissionRevision) {
      throw acpError(
        'identity-mismatch',
        'ACP runtime load returned a different permission revision',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-permission' },
        opened.evidenceRefs,
        { binding: this.binding },
      );
    }
    const record: AcpSessionRecord = {
      acpSessionId: input.acpSessionId,
      binding: opened.binding,
      runtimeId: opened.runtimeId,
      permissionRevision: opened.permissionRevision,
      capabilities: [...opened.capabilities],
      evidenceRefs: [...opened.evidenceRefs],
      openedAt: opened.openedAt,
    };
    this.sessions.set(input.acpSessionId, { record, scopeRef: input.proof.scopeRef });
    this.closedSessions.delete(input.acpSessionId);
    return this.cloneRecord(record);
  }

  async *observe(input: AcpObserveRequest): AsyncIterable<AcpObservationUpdate> {
    const session = this.requireSession(input.acpSessionId);
    this.assertSessionCapability(session, 'observe');
    try {
      for await (const update of this.runtime.observe({
        runtimeId: session.record.runtimeId,
        acpSessionId: input.acpSessionId,
        binding: session.record.binding,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      })) {
        yield { ...update, evidenceRefs: [...update.evidenceRefs] };
      }
    } catch (error) {
      return serverTransportFailure(this.binding, 'observe', error);
    }
  }

  async request(input: AcpRequest): Promise<AgentDispatchReceipt> {
    const session = this.requireSession(input.acpSessionId);
    this.assertSessionCapability(session, 'request');
    try {
      validateAgentRequestEnvelope(input.envelope);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP request envelope is invalid',
        ACP_SERVER_OWNER,
        { kind: 'stop', ref: 'reject-request' },
        session.record.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    if (!sameAgentBinding(session.record.binding, input.envelope.control.binding)) {
      throw acpError(
        'identity-mismatch',
        'ACP request binding does not match the session',
        ACP_SERVER_OWNER,
        { kind: 'stop', ref: 'reject-request-binding' },
        session.record.evidenceRefs,
        { binding: this.binding },
      );
    }
    if (input.envelope.control.permissionRevision !== session.record.permissionRevision) {
      throw acpError(
        'identity-mismatch',
        'ACP request permission revision does not match the session',
        ACP_SERVER_OWNER,
        { kind: 'stop', ref: 'reject-request-permission' },
        session.record.evidenceRefs,
        { binding: this.binding },
      );
    }
    let receipt: AgentDispatchReceipt;
    try {
      receipt = await this.runtime.request({
        runtimeId: session.record.runtimeId,
        acpSessionId: input.acpSessionId,
        envelope: input.envelope,
      });
    } catch (error) {
      return serverTransportFailure(this.binding, 'request', error);
    }
    try {
      validateAgentDispatchReceipt(receipt);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP runtime dispatch receipt is invalid',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-receipt' },
        session.record.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    if (receipt.requestId !== input.envelope.control.requestId
      || receipt.attemptId !== input.envelope.control.attemptId
      || receipt.runtimeId !== session.record.runtimeId
      || receipt.executionEpoch !== (session.record.binding.kind === 'task'
        ? session.record.binding.executionEpoch
        : receipt.executionEpoch)) {
      throw acpError(
        'identity-mismatch',
        'ACP runtime dispatch receipt does not match the request',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-receipt' },
        session.record.evidenceRefs,
        { binding: this.binding },
      );
    }
    return receipt;
  }

  async cancel(input: AcpCancelRequest): Promise<AcpCancelReceipt> {
    const session = this.requireSession(input.acpSessionId);
    this.assertSessionCapability(session, 'cancel');
    assertAttemptIdentity(input, session.record.evidenceRefs);
    if (session.record.binding.kind === 'task' && !input.operationId?.value.trim()) {
      throw acpError(
        'capability-unavailable',
        'task cancel requires the HumanAgent operation identity',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'provide-operation-id' },
        session.record.evidenceRefs,
        { binding: this.binding },
      );
    }
    if (session.record.binding.kind === 'interaction') {
      let closure: InteractionClosure;
      try {
        closure = await this.runtime.cancelInteraction({
          runtimeId: session.record.runtimeId,
          acpSessionId: input.acpSessionId,
          interactionScopeId: session.record.binding.interactionScopeId,
          requestId: input.requestId,
          attemptId: input.attemptId,
          reason: input.reason,
        });
      } catch (error) {
        return serverTransportFailure(this.binding, 'interaction-cancel', error);
      }
      validateRuntimeInteractionClosure(closure, session, input, this.binding);
      return {
        accepted: true,
        stopped: false,
        sessionKind: 'interaction',
        ownerId: ACP_SERVER_OWNER,
        nextAction: { kind: 'wait', ref: `interaction-closure:${closure.closureRef}` },
        evidenceRefs: [...closure.evidenceRefs],
        interactionClosure: closure,
      };
    }
    let taskStop;
    try {
      taskStop = await this.runtime.requestTaskStop({
        runtimeId: session.record.runtimeId,
        acpSessionId: input.acpSessionId,
        taskId: session.record.binding.taskId,
        assignmentId: session.record.binding.assignmentId,
        executionEpoch: session.record.binding.executionEpoch,
        requestId: input.requestId,
        attemptId: input.attemptId,
        reason: input.reason,
        ownerId: ACP_SERVER_OWNER,
        operationId: input.operationId!,
      });
      } catch (error) {
        return serverTransportFailure(this.binding, 'task-stop', error);
      }
    try {
      validateAgentStopReceipt(taskStop);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP runtime stop receipt is invalid',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-receipt' },
        session.record.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    assertTaskReceiptIdentity(taskStop, session, input.requestId, input.attemptId, this.binding);
    if (taskStop.operationRef !== input.operationId!.value) {
      throw acpError(
        'identity-mismatch',
        'ACP runtime stop receipt does not match the requested operation',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-receipt' },
        session.record.evidenceRefs,
        { binding: this.binding },
      );
    }
    return {
      accepted: taskStop.status === 'accepted',
      stopped: false,
      sessionKind: 'task',
      ownerId: taskStop.driverRef,
      nextAction: { kind: 'wait', ref: `task-stop:${session.record.runtimeId}:${session.record.binding.executionEpoch}` },
      evidenceRefs: [...taskStop.evidenceRefs],
      taskStop,
    };
  }

  async reconcile(input: AcpReconcileRequest): Promise<AgentReconcileResult> {
    const session = this.requireSession(input.acpSessionId);
    this.assertSessionCapability(session, 'reconcile');
    if (session.record.binding.kind !== 'task') {
      throw acpError(
        'session-kind-mismatch',
        'ACP reconcile is only valid for task sessions',
        ACP_SERVER_OWNER,
        { kind: 'stop', ref: 'reject-task-only' },
        session.record.evidenceRefs,
        { binding: this.binding },
      );
    }
    assertAttemptIdentity(input, session.record.evidenceRefs);
    assertNonEmpty(input.operationRef, 'operationRef', session.record.evidenceRefs);
    let receipt: AgentReconcileResult;
    try {
      receipt = await this.runtime.reconcileTask({
        runtimeId: session.record.runtimeId,
        acpSessionId: input.acpSessionId,
        taskId: session.record.binding.taskId,
        assignmentId: session.record.binding.assignmentId,
        executionEpoch: session.record.binding.executionEpoch,
        requestId: input.requestId,
        attemptId: input.attemptId,
        operationRef: input.operationRef,
      });
    } catch (error) {
      return serverTransportFailure(this.binding, 'reconcile', error);
    }
    try {
      validateAgentReconcileResult(receipt);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP runtime reconcile receipt is invalid',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-receipt' },
        session.record.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    assertTaskReceiptIdentity(receipt, session, input.requestId, input.attemptId, this.binding);
    if (receipt.operationRef !== input.operationRef) {
      throw acpError(
        'identity-mismatch',
        'ACP runtime reconcile receipt does not match the operation reference',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-receipt' },
        session.record.evidenceRefs,
        { binding: this.binding },
      );
    }
    return receipt;
  }

  async settle(input: AcpSettleRequest): Promise<AgentSettleReceipt> {
    const session = this.requireSession(input.acpSessionId);
    this.assertSessionCapability(session, 'settle');
    if (session.record.binding.kind !== 'task') {
      throw acpError(
        'session-kind-mismatch',
        'ACP settle is only valid for task sessions',
        ACP_SERVER_OWNER,
        { kind: 'stop', ref: 'reject-task-only' },
        session.record.evidenceRefs,
        { binding: this.binding },
      );
    }
    assertAttemptIdentity(input, session.record.evidenceRefs);
    let receipt: AgentSettleReceipt;
    try {
      receipt = await this.runtime.settleTask({
        runtimeId: session.record.runtimeId,
        acpSessionId: input.acpSessionId,
        taskId: session.record.binding.taskId,
        assignmentId: session.record.binding.assignmentId,
        executionEpoch: session.record.binding.executionEpoch,
        requestId: input.requestId,
        attemptId: input.attemptId,
      });
    } catch (error) {
      return serverTransportFailure(this.binding, 'settle', error);
    }
    try {
      validateAgentSettleReceipt(receipt);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP runtime settle receipt is invalid',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'reconcile-runtime-receipt' },
        session.record.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    assertTaskReceiptIdentity(receipt, session, input.requestId, input.attemptId, this.binding);
    return receipt;
  }

  async close(input: AcpCloseRequest): Promise<AcpCloseReceipt> {
    const prior = this.closedSessions.get(input.acpSessionId);
    if (prior) return { ...prior, idempotent: true, evidenceRefs: [...prior.evidenceRefs] };
    const session = this.requireSession(input.acpSessionId);
    let result;
    try {
      result = await this.runtime.close({
        runtimeId: session.record.runtimeId,
        acpSessionId: input.acpSessionId,
        binding: session.record.binding,
        reason: input.reason,
      });
    } catch (error) {
      return serverTransportFailure(this.binding, 'close', error);
    }
    const receipt: AcpCloseReceipt = {
      acpSessionId: input.acpSessionId,
      closed: result.closed,
      idempotent: false,
      evidenceRefs: [...result.evidenceRefs],
    };
    if (receipt.closed) {
      this.sessions.delete(input.acpSessionId);
      this.closedSessions.set(input.acpSessionId, receipt);
    }
    return receipt;
  }

  private assertInitialized(): void {
    if (!this.negotiated) {
      throw acpError(
        'capability-unavailable',
        'ACP server must negotiate capabilities before opening a session',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'initialize' },
        [],
        { binding: this.binding },
      );
    }
  }

  private assertCapability(capability: string): void {
    if (!this.negotiated?.capabilities.includes(capability)) {
      throw capabilityUnavailable(`ACP capability was not negotiated: ${capability}`, ACP_SERVER_OWNER, this.negotiated?.evidenceRefs ?? [], this.binding);
    }
  }

  private assertSessionCapability(session: ServerSession, capability: string): void {
    this.assertCapability(capability);
    if (!session.record.capabilities.includes(capability)) {
      throw capabilityUnavailable(
        `ACP capability was not requested for session: ${capability}`,
        ACP_SERVER_OWNER,
        session.record.evidenceRefs,
        this.binding,
      );
    }
  }

  private assertSessionKind(kind: string): void {
    if (!this.negotiated?.sessionKinds.includes(kind as 'interaction' | 'task')) {
      throw capabilityUnavailable(`ACP session kind was not negotiated: ${kind}`, ACP_SERVER_OWNER, this.negotiated?.evidenceRefs ?? [], this.binding);
    }
  }

  private assertSessionBinding(session: ServerSession, binding: AgentBinding, operation: string): void {
    if (!sameAgentBinding(session.record.binding, binding)) {
      throw acpError(
        'identity-mismatch',
        `ACP ${operation} cannot replace a session with another HumanAgent binding`,
        ACP_SERVER_OWNER,
        { kind: 'stop', ref: `reject-${operation}-binding` },
        session.record.evidenceRefs,
        { binding: this.binding },
      );
    }
  }

  private requireSession(acpSessionId: string): ServerSession {
    const session = this.sessions.get(acpSessionId);
    if (!session) {
      if (this.closedSessions.has(acpSessionId)) {
        throw acpError(
          'transport-closed',
          'ACP session is closed',
          ACP_SERVER_OWNER,
          { kind: 'recover', ref: 'open-new-session' },
          this.closedSessions.get(acpSessionId)?.evidenceRefs ?? [],
          { binding: this.binding },
        );
      }
      throw acpError(
        'session-not-found',
        'ACP session is not open',
        ACP_SERVER_OWNER,
        { kind: 'recover', ref: 'open-session' },
        [],
        { binding: this.binding },
      );
    }
    return session;
  }

  private cloneRecord(record: AcpSessionRecord): AcpSessionRecord {
    return {
      ...record,
      capabilities: [...record.capabilities],
      evidenceRefs: [...record.evidenceRefs],
    };
  }
}
