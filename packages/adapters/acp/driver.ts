import {
  validateAgentCloseReceipt,
  validateAgentDispatchReceipt,
  validateAgentReconcileResult,
  validateAgentRequestEnvelope,
  validateAgentSettleReceipt,
  validateAgentBinding,
  validateAgentStopReceipt,
  validateInteractionClosure,
  type AcpDriverBinding,
  type AgentBinding,
  type AgentCloseReceipt,
  type AgentDispatchReceipt,
  type AgentReconcileResult,
  type AgentSettleReceipt,
  type AgentStopReceipt,
  type EvidenceRef,
  type InteractionClosure,
} from '../../contracts/src/index.js';
import { AcpDriverBindingGuard, sameAgentBinding } from './binding.js';
import {
  ACP_DRIVER_OWNER,
  AcpAdapterError,
  acpError,
  capabilityUnavailable,
} from './errors.js';
import type {
  AcpCancelReceipt,
  AcpDriverCancelRequest,
  AcpDriverCapabilityRequest,
  AcpDriverCloseReceipt,
  AcpDriverCloseRequest,
  AcpDriverLoadRequest,
  AcpDriverObserveRequest,
  AcpDriverOpenRequest,
  AcpDriverOpenResult,
  AcpDriverPort,
  AcpDriverReconcileRequest,
  AcpDriverRequest,
  AcpDriverSettleRequest,
  AcpDriverTransport,
  AcpDelegationProof,
  AcpObservationUpdate,
} from './types.js';

interface DriverSession {
  readonly acpSessionId: string;
  readonly binding: AgentBinding;
  readonly externalSessionRef: string;
  readonly executionEpoch: number;
  readonly evidenceRefs: readonly EvidenceRef[];
  closed: boolean;
}

function driverEvidence(binding: AcpDriverBinding, locator: string): EvidenceRef {
  return {
    evidenceId: {
      scope: 'evidence',
      value: `acp-driver-${binding.bindingRef}-${locator}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128),
    },
    kind: 'external',
    source: ACP_DRIVER_OWNER,
    locator: `acp/driver/${binding.bindingRef}/${locator}`,
    scope: {
      organId: { scope: 'organ', value: `acp-driver-${binding.bindingRef}` },
      ...(binding.taskId ? { taskId: binding.taskId } : {}),
    },
  };
}

function transportFailure(binding: AcpDriverBinding, phase: string, error: unknown): never {
  if (error instanceof AcpAdapterError) throw error;
  throw acpError(
    'transport-failure',
    error instanceof Error ? error.message : `ACP transport failed during ${phase}`,
    ACP_DRIVER_OWNER,
    { kind: 'recover', ref: `acp-transport:${phase}` },
    [driverEvidence(binding, `transport-${phase}`)],
    { binding, cause: error },
  );
}

export class AcpDriverAdapter implements AcpDriverPort {
  private readonly guard: AcpDriverBindingGuard;
  private readonly sessions = new Map<string, DriverSession>();
  private readonly closedSessions = new Set<string>();

  constructor(
    private readonly binding: AcpDriverBinding,
    private readonly transport: AcpDriverTransport,
  ) {
    this.guard = new AcpDriverBindingGuard(binding);
  }

  async capabilities(
    input: AcpDriverCapabilityRequest = { requestedCapabilities: [] },
    proof?: AcpDelegationProof,
  ): Promise<import('./types.js').AcpCapabilitySet> {
    this.guard.assertProof(proof);
    const requested = input.requestedCapabilities;
    for (const capability of requested) this.guard.assertDelegation(proof, capability);
    let remote;
    try {
      remote = await this.transport.capabilities(this.binding);
    } catch (error) {
      return transportFailure(this.binding, 'capabilities', error);
    }
    const delegatedCapabilities = this.binding.delegatedCapabilities.filter((capability) => (
      proof.delegatedCapabilities.includes(capability)
    ));
    const capabilities = (requested.length > 0 ? requested : remote.capabilities)
      .filter((capability) => remote.capabilities.includes(capability) && delegatedCapabilities.includes(capability));
    if (requested.length > 0 && capabilities.length === 0) {
      throw capabilityUnavailable('ACP driver transport does not provide the requested capabilities', ACP_DRIVER_OWNER, [driverEvidence(this.binding, 'capabilities')], this.binding);
    }
    const delegatedSessionKinds: readonly ('interaction' | 'task')[] = this.binding.taskId === undefined
      ? ['interaction']
      : ['task'];
    const sessionKinds = delegatedSessionKinds.filter((kind) => remote.sessionKinds.includes(kind));
    if (sessionKinds.length === 0) {
      throw capabilityUnavailable('ACP driver transport does not provide the delegated session kind', ACP_DRIVER_OWNER, [driverEvidence(this.binding, 'capabilities')], this.binding);
    }
    return {
      capabilities,
      sessionKinds,
      version: remote.version,
      evidenceRefs: [...remote.evidenceRefs, driverEvidence(this.binding, 'capabilities')],
    };
  }

  async open(input: AcpDriverOpenRequest, proof?: AcpDelegationProof): Promise<AcpDriverOpenResult> {
    this.guard.assertProof(proof);
    this.assertBinding(input.binding);
    if (this.sessions.has(input.acpSessionId)) {
      const existing = this.sessions.get(input.acpSessionId)!;
      this.assertSessionBinding(existing, input.binding, 'open');
      return this.result(existing);
    }
    if (this.closedSessions.has(input.acpSessionId)) {
      throw acpError(
        'transport-closed',
        'ACP driver session is closed',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'open-new-session' },
        [driverEvidence(this.binding, 'closed-session')],
        { binding: this.binding },
      );
    }
    try {
      const result = await this.transport.open(input);
      this.assertOpenResult(input.binding, result);
      const session: DriverSession = {
        acpSessionId: input.acpSessionId,
        binding: input.binding,
        externalSessionRef: result.externalSessionRef,
        executionEpoch: result.executionEpoch,
        evidenceRefs: [...result.evidenceRefs],
        closed: false,
      };
      this.sessions.set(input.acpSessionId, session);
      return this.result(session);
    } catch (error) {
      return transportFailure(this.binding, 'open', error);
    }
  }

  async load(input: AcpDriverLoadRequest, proof?: AcpDelegationProof): Promise<AcpDriverOpenResult> {
    this.guard.assertProof(proof);
    this.assertBinding(input.binding);
    if (input.binding.kind === 'task') {
      if (input.binding.executionEpoch !== this.binding.executionEpoch) {
        throw acpError(
          'stale-execution',
          'ACP driver load execution epoch does not match the delegated binding',
          ACP_DRIVER_OWNER,
          { kind: 'recover', ref: 'refresh-driver-binding' },
          [driverEvidence(this.binding, 'stale-load')],
          { binding: this.binding },
        );
      }
    }
    const existing = this.sessions.get(input.acpSessionId);
    if (existing) this.assertSessionBinding(existing, input.binding, 'load');
    try {
      const result = await this.transport.load(input);
      this.assertOpenResult(input.binding, result);
      const session: DriverSession = {
        acpSessionId: input.acpSessionId,
        binding: input.binding,
        externalSessionRef: result.externalSessionRef,
        executionEpoch: result.executionEpoch,
        evidenceRefs: [...result.evidenceRefs],
        closed: false,
      };
      this.sessions.set(input.acpSessionId, session);
      this.closedSessions.delete(input.acpSessionId);
      return this.result(session);
    } catch (error) {
      return transportFailure(this.binding, 'load', error);
    }
  }

  async *observe(input: AcpDriverObserveRequest, proof?: AcpDelegationProof): AsyncIterable<AcpObservationUpdate> {
    this.guard.assertDelegation(proof, 'observe');
    this.requireSession(input.acpSessionId);
    try {
      for await (const update of this.transport.observe(input)) {
        yield { ...update, evidenceRefs: [...update.evidenceRefs] };
      }
    } catch (error) {
      return transportFailure(this.binding, 'observe', error);
    }
  }

  async request(input: AcpDriverRequest, proof?: AcpDelegationProof): Promise<AgentDispatchReceipt> {
    this.guard.assertDelegation(proof, 'request');
    const session = this.requireSession(input.acpSessionId);
    try {
      validateAgentRequestEnvelope(input.envelope);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP driver request envelope is invalid',
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: 'reject-request' },
        session.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    if (!sameAgentBinding(session.binding, input.envelope.control.binding)) {
      throw acpError(
        'identity-mismatch',
        'ACP driver request binding does not match the opened session',
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: 'reject-request-binding' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
    if (input.envelope.control.permissionRevision !== this.binding.permissionRevision) {
      throw acpError(
        'identity-mismatch',
        'ACP driver request permission revision does not match the delegated binding',
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: 'reject-request-permission' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
    let receipt: AgentDispatchReceipt;
    try {
      receipt = await this.transport.request(input);
    } catch (error) {
      return transportFailure(this.binding, 'request', error);
    }
    try {
      validateAgentDispatchReceipt(receipt);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP driver dispatch receipt is invalid',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'reconcile-driver-receipt' },
        session.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    if (receipt.requestId !== input.envelope.control.requestId
      || receipt.attemptId !== input.envelope.control.attemptId
      || receipt.executionEpoch !== session.executionEpoch) {
      throw acpError(
        'identity-mismatch',
        'ACP driver dispatch receipt does not match the request',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'reconcile-driver-receipt' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
    return receipt;
  }

  async cancel(input: AcpDriverCancelRequest, proof?: AcpDelegationProof): Promise<AcpCancelReceipt> {
    const session = this.requireSession(input.acpSessionId);
    this.guard.assertDelegation(proof, 'cancel');
    if (!input.requestId.trim() || !input.attemptId.trim()) {
      throw acpError(
        'protocol-error',
        'ACP cancel requires request and attempt identity',
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: 'reject-cancel-identity' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
    if (session.binding.kind === 'interaction') {
      let closure: InteractionClosure;
      try {
        closure = await this.transport.cancelInteraction(input);
      } catch (error) {
        return transportFailure(this.binding, 'interaction-cancel', error);
      }
      this.assertInteractionClosure(closure, session, input);
      return {
        accepted: true,
        stopped: false,
        sessionKind: 'interaction',
        ownerId: ACP_DRIVER_OWNER,
        nextAction: { kind: 'wait', ref: `interaction-closure:${closure.closureRef}` },
        evidenceRefs: [...closure.evidenceRefs],
        interactionClosure: closure,
      };
    }
    if (!input.operationId) {
      throw acpError(
        'capability-unavailable',
        'task cancel requires the HumanAgent operation identity',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'provide-operation-id' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
    let taskStop: AgentStopReceipt;
    try {
      taskStop = await this.transport.requestStop(input);
    } catch (error) {
      return transportFailure(this.binding, 'task-stop', error);
    }
    try {
      validateAgentStopReceipt(taskStop);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP driver stop receipt is invalid',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'reconcile-driver-receipt' },
        session.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    if (taskStop.requestId !== input.requestId
      || taskStop.attemptId !== input.attemptId
      || taskStop.executionEpoch !== session.executionEpoch
      || taskStop.operationRef !== input.operationId.value) {
      throw acpError(
        'identity-mismatch',
        'ACP driver stop receipt does not match the requested operation',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'reconcile-driver-receipt' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
    return {
      accepted: taskStop.status === 'accepted',
      stopped: false,
      sessionKind: 'task',
      ownerId: taskStop.driverRef,
      nextAction: { kind: 'wait', ref: `task-stop:${session.externalSessionRef}` },
      evidenceRefs: [...taskStop.evidenceRefs],
      taskStop,
    };
  }

  async reconcile(input: AcpDriverReconcileRequest, proof?: AcpDelegationProof): Promise<AgentReconcileResult> {
    this.guard.assertDelegation(proof, 'reconcile');
    const session = this.requireSession(input.acpSessionId);
    this.assertSessionKind(session.binding, 'task', 'reconcile');
    if (!input.requestId.trim() || !input.attemptId.trim() || !input.operationRef.trim()) {
      throw acpError(
        'protocol-error',
        'ACP driver reconcile requires request, attempt, and operation identity',
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: 'reject-reconcile-identity' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
    let receipt: AgentReconcileResult;
    try {
      receipt = await this.transport.reconcile(input);
    } catch (error) {
      return transportFailure(this.binding, 'reconcile', error);
    }
    try {
      validateAgentReconcileResult(receipt);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP driver reconcile receipt is invalid',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'reconcile-driver-receipt' },
        session.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    if (receipt.requestId !== input.requestId
      || receipt.attemptId !== input.attemptId
      || receipt.executionEpoch !== session.executionEpoch
      || receipt.operationRef !== input.operationRef) {
      throw acpError(
        'identity-mismatch',
        'ACP driver reconcile receipt does not match the request',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'reconcile-driver-receipt' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
    return receipt;
  }

  async settle(input: AcpDriverSettleRequest, proof?: AcpDelegationProof): Promise<AgentSettleReceipt> {
    this.guard.assertDelegation(proof, 'settle');
    const session = this.requireSession(input.acpSessionId);
    this.assertSessionKind(session.binding, 'task', 'settle');
    if (!input.requestId.trim() || !input.attemptId.trim()) {
      throw acpError(
        'protocol-error',
        'ACP driver settle requires request and attempt identity',
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: 'reject-settle-identity' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
    let receipt: AgentSettleReceipt;
    try {
      receipt = await this.transport.settle(input);
    } catch (error) {
      return transportFailure(this.binding, 'settle', error);
    }
    try {
      validateAgentSettleReceipt(receipt);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP driver settle receipt is invalid',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'reconcile-driver-receipt' },
        session.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    if (receipt.requestId !== input.requestId
      || receipt.attemptId !== input.attemptId
      || receipt.executionEpoch !== session.executionEpoch) {
      throw acpError(
        'identity-mismatch',
        'ACP driver settle receipt does not match the request',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'reconcile-driver-receipt' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
    return receipt;
  }

  async close(input: AcpDriverCloseRequest): Promise<AcpDriverCloseReceipt> {
    if (this.closedSessions.has(input.acpSessionId)) {
      return { closed: true, idempotent: true };
    }
    const session = this.requireSession(input.acpSessionId);
    if (!input.requestId.trim() || !input.attemptId.trim()) {
      throw acpError(
        'protocol-error',
        'ACP close requires request and attempt identity',
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: 'reject-close-identity' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
    try {
      const receipt = await this.transport.close(input);
      try {
        validateAgentCloseReceipt(receipt);
      } catch (error) {
        throw acpError(
          'protocol-error',
          error instanceof Error ? error.message : 'ACP driver close receipt is invalid',
          ACP_DRIVER_OWNER,
          { kind: 'recover', ref: 'reconcile-driver-receipt' },
          session.evidenceRefs,
          { binding: this.binding, cause: error },
        );
      }
      if (receipt.requestId !== input.requestId
        || receipt.attemptId !== input.attemptId
        || receipt.executionEpoch !== session.executionEpoch) {
        throw acpError(
          'identity-mismatch',
          'ACP driver close receipt does not match the request',
          ACP_DRIVER_OWNER,
          { kind: 'recover', ref: 'reconcile-driver-receipt' },
          session.evidenceRefs,
          { binding: this.binding },
        );
      }
      if (receipt.closed) {
        this.sessions.delete(input.acpSessionId);
        this.closedSessions.add(input.acpSessionId);
      }
      return { closed: receipt.closed, idempotent: false, receipt };
    } catch (error) {
      return transportFailure(this.binding, 'close', error);
    }
  }

  private assertBinding(binding: AgentBinding): void {
    try {
      validateAgentBinding(binding);
    } catch (error) {
      throw acpError(
        'binding-invalid',
        error instanceof Error ? error.message : 'ACP driver binding is invalid',
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: 'reject-binding' },
        [driverEvidence(this.binding, 'binding')],
        { binding: this.binding, cause: error },
      );
    }
    if (this.binding.taskId === undefined) {
      if (binding.kind !== 'interaction') {
        throw acpError(
          'identity-mismatch',
          'ACP driver is not delegated for a task binding',
          ACP_DRIVER_OWNER,
          { kind: 'stop', ref: 'reject-binding' },
          [driverEvidence(this.binding, 'binding')],
          { binding: this.binding },
        );
      }
      return;
    }
    if (binding.kind !== 'task') {
      throw acpError(
        'identity-mismatch',
        'ACP driver is not delegated for an interaction binding',
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: 'reject-binding' },
        [driverEvidence(this.binding, 'binding')],
        { binding: this.binding },
      );
    }
    if (binding.taskId.value !== this.binding.taskId.value
      || binding.assignmentId !== this.binding.assignmentId
      || binding.executionEpoch !== this.binding.executionEpoch) {
      throw acpError(
        'stale-execution',
        'ACP driver task binding does not match the delegated execution',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'refresh-driver-binding' },
        [driverEvidence(this.binding, 'binding')],
        { binding: this.binding },
      );
    }
  }

  private assertSessionKind(binding: AgentBinding, kind: AgentBinding['kind'], operation: string): void {
    if (binding.kind !== kind) {
      throw acpError(
        'session-kind-mismatch',
        `ACP driver ${operation} is not valid for ${binding.kind} sessions`,
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: `reject-${operation}` },
        [driverEvidence(this.binding, operation)],
        { binding: this.binding },
      );
    }
  }

  private assertSessionBinding(session: DriverSession, binding: AgentBinding, operation: string): void {
    if (!sameAgentBinding(session.binding, binding)) {
      throw acpError(
        'identity-mismatch',
        `ACP driver ${operation} cannot replace a session with another HumanAgent binding`,
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: `reject-${operation}-binding` },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
  }

  private assertOpenResult(binding: AgentBinding, result: AcpDriverOpenResult): void {
    if (!result.externalSessionRef.trim() || !Number.isSafeInteger(result.executionEpoch) || result.executionEpoch < 1) {
      throw acpError(
        'protocol-error',
        'ACP driver transport returned an invalid open result',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'reconcile-driver-session' },
        result.evidenceRefs,
        { binding: this.binding },
      );
    }
    if (binding.kind === 'task' && result.executionEpoch !== binding.executionEpoch) {
      throw acpError(
        'stale-execution',
        'ACP driver transport returned a different execution epoch',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'refresh-driver-binding' },
        result.evidenceRefs,
        { binding: this.binding },
      );
    }
  }

  private assertInteractionClosure(closure: InteractionClosure, session: DriverSession, input: AcpDriverCancelRequest): void {
    try {
      validateInteractionClosure(closure);
    } catch (error) {
      throw acpError(
        'protocol-error',
        error instanceof Error ? error.message : 'ACP driver interaction closure is invalid',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'reconcile-interaction-closure' },
        session.evidenceRefs,
        { binding: this.binding, cause: error },
      );
    }
    if (session.binding.kind !== 'interaction'
      || closure.interactionScopeId !== session.binding.interactionScopeId
      || closure.requestId !== input.requestId
      || closure.attemptId !== input.attemptId) {
      throw acpError(
        'identity-mismatch',
        'ACP driver interaction closure does not match the cancelled interaction',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'reconcile-interaction-closure' },
        session.evidenceRefs,
        { binding: this.binding },
      );
    }
  }

  private requireSession(acpSessionId: string): DriverSession {
    const session = this.sessions.get(acpSessionId);
    if (!session) {
      if (this.closedSessions.has(acpSessionId)) {
        throw acpError(
          'transport-closed',
          'ACP driver session is closed',
          ACP_DRIVER_OWNER,
          { kind: 'recover', ref: 'open-new-session' },
          [driverEvidence(this.binding, 'closed')],
          { binding: this.binding },
        );
      }
      throw acpError(
        'session-not-found',
        'ACP driver session is not open',
        ACP_DRIVER_OWNER,
        { kind: 'recover', ref: 'open-session' },
        [],
        { binding: this.binding },
      );
    }
    return session;
  }

  private result(session: DriverSession): AcpDriverOpenResult {
    return {
      externalSessionRef: session.externalSessionRef,
      executionEpoch: session.executionEpoch,
      evidenceRefs: [...session.evidenceRefs],
    };
  }
}
