import type {
  AcpAllowedSessionKind,
  AgentBinding,
  AgentCloseReceipt,
  AgentDispatchReceipt,
  AgentReconcileResult,
  AgentRequestEnvelope,
  AgentSettleReceipt,
  AgentStopReceipt,
  CheckpointId,
  EvidenceRef,
  InteractionClosure,
  NextAction,
  OperationId,
  TaskId,
} from '../../contracts/src/index.js';

export type AcpSessionKind = AcpAllowedSessionKind;

export interface AcpPeerProof {
  readonly principalRef: string;
  readonly scopeRef: string;
  readonly permissionRevision: string;
  readonly bindingDigest: string;
}

export interface AcpSessionAdmissionSubject extends AcpPeerProof {
  readonly kind: AcpSessionKind;
  readonly capability: string;
}

export interface AcpCapabilitySet {
  readonly capabilities: readonly string[];
  readonly sessionKinds: readonly AcpSessionKind[];
  readonly version: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AcpInitializeRequest {
  readonly proof: AcpPeerProof;
  readonly requestedCapabilities: readonly string[];
  readonly requestedSessionKinds: readonly AcpSessionKind[];
}

export interface AcpNegotiatedCapabilities extends AcpCapabilitySet {
  readonly bindingRef: string;
  readonly requestedCapabilities: readonly string[];
}

export interface AcpRuntimeSession {
  readonly binding: AgentBinding;
  readonly runtimeId: string;
  readonly permissionRevision: string;
  readonly capabilities: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly openedAt: string;
}

export interface AcpRuntimeCapabilityRequest {
  readonly bindingRef: string;
  readonly principalRef: string;
  readonly scopeRef: string;
  readonly permissionRevision: string;
}

export interface AcpRuntimeOpenRequest {
  readonly binding: AgentBinding;
  readonly acpSessionId: string;
  readonly principalRef: string;
  readonly scopeRef: string;
  readonly permissionRevision: string;
  readonly requestedCapabilities: readonly string[];
}

export interface AcpRuntimeLoadRequest extends AcpRuntimeOpenRequest {
  readonly checkpointId?: CheckpointId;
  readonly expectedExecutionEpoch?: number;
  readonly reason: string;
}

export interface AcpRuntimeObserveRequest {
  readonly runtimeId: string;
  readonly acpSessionId: string;
  readonly binding: AgentBinding;
  readonly cursor?: string;
}

export interface AcpObservationUpdate {
  readonly sequence: number;
  readonly cursor: string;
  readonly kind: string;
  readonly summary?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AcpRuntimeRequest {
  readonly runtimeId: string;
  readonly acpSessionId: string;
  readonly envelope: AgentRequestEnvelope;
}

export interface AcpRuntimeInteractionCancelRequest {
  readonly runtimeId: string;
  readonly acpSessionId: string;
  readonly interactionScopeId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly reason: string;
}

export interface AcpRuntimeTaskStopRequest {
  readonly runtimeId: string;
  readonly acpSessionId: string;
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly executionEpoch: number;
  readonly requestId: string;
  readonly attemptId: string;
  readonly reason: string;
  readonly ownerId: string;
  readonly operationId: OperationId;
}

export interface AcpRuntimeTaskReconcileRequest {
  readonly runtimeId: string;
  readonly acpSessionId: string;
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly executionEpoch: number;
  readonly requestId: string;
  readonly attemptId: string;
  readonly operationRef: string;
}

export interface AcpRuntimeTaskSettleRequest {
  readonly runtimeId: string;
  readonly acpSessionId: string;
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly executionEpoch: number;
  readonly requestId: string;
  readonly attemptId: string;
}

export interface AcpRuntimeCloseRequest {
  readonly runtimeId: string;
  readonly acpSessionId: string;
  readonly binding: AgentBinding;
  readonly reason: string;
}

export interface AcpRuntimeCloseResult {
  readonly closed: boolean;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AcpServerRuntimePort {
  capabilities(input: AcpRuntimeCapabilityRequest): Promise<AcpCapabilitySet>;
  open(input: AcpRuntimeOpenRequest): Promise<AcpRuntimeSession>;
  load(input: AcpRuntimeLoadRequest): Promise<AcpRuntimeSession>;
  observe(input: AcpRuntimeObserveRequest): AsyncIterable<AcpObservationUpdate>;
  request(input: AcpRuntimeRequest): Promise<AgentDispatchReceipt>;
  cancelInteraction(input: AcpRuntimeInteractionCancelRequest): Promise<InteractionClosure>;
  requestTaskStop(input: AcpRuntimeTaskStopRequest): Promise<AgentStopReceipt>;
  reconcileTask(input: AcpRuntimeTaskReconcileRequest): Promise<AgentReconcileResult>;
  settleTask(input: AcpRuntimeTaskSettleRequest): Promise<AgentSettleReceipt>;
  close(input: AcpRuntimeCloseRequest): Promise<AcpRuntimeCloseResult>;
}

export interface AcpOpenRequest {
  readonly acpSessionId: string;
  readonly proof: AcpPeerProof;
  readonly binding: AgentBinding;
  readonly requestedCapabilities: readonly string[];
}

export interface AcpLoadRequest {
  readonly acpSessionId: string;
  readonly proof: AcpPeerProof;
  readonly binding: AgentBinding;
  readonly expectedExecutionEpoch?: number;
  readonly checkpointId?: CheckpointId;
  readonly reason: string;
}

export interface AcpObserveRequest {
  readonly acpSessionId: string;
  readonly cursor?: string;
}

export interface AcpRequest {
  readonly acpSessionId: string;
  readonly envelope: AgentRequestEnvelope;
}

export interface AcpCancelRequest {
  readonly acpSessionId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly reason: string;
  readonly operationId?: OperationId;
}

export interface AcpReconcileRequest {
  readonly acpSessionId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly operationRef: string;
}

export interface AcpSettleRequest {
  readonly acpSessionId: string;
  readonly requestId: string;
  readonly attemptId: string;
}

export interface AcpCloseRequest {
  readonly acpSessionId: string;
  readonly reason: string;
}

export interface AcpSessionRecord {
  readonly acpSessionId: string;
  readonly binding: AgentBinding;
  readonly runtimeId: string;
  readonly permissionRevision: string;
  readonly capabilities: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly openedAt: string;
}

export interface AcpCancelReceipt {
  readonly accepted: boolean;
  readonly stopped: false;
  readonly sessionKind: AcpSessionKind;
  readonly ownerId: string;
  readonly nextAction: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly interactionClosure?: InteractionClosure;
  readonly taskStop?: AgentStopReceipt;
}

export interface AcpCloseReceipt {
  readonly acpSessionId: string;
  readonly closed: boolean;
  readonly idempotent: boolean;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AcpDelegationProof {
  readonly proofRef: string;
  readonly bindingRef: string;
  readonly externalPeerRef: string;
  readonly delegatedCapabilities: readonly string[];
  readonly permissionRevision: string;
}

export interface AcpDriverCapabilityRequest {
  readonly requestedCapabilities: readonly string[];
}

export interface AcpDriverOpenRequest {
  readonly acpSessionId: string;
  readonly binding: AgentBinding;
}

export interface AcpDriverLoadRequest extends AcpDriverOpenRequest {
  readonly checkpointId?: CheckpointId;
  readonly reason: string;
}

export interface AcpDriverObserveRequest {
  readonly acpSessionId: string;
  readonly cursor?: string;
}

export interface AcpDriverRequest {
  readonly acpSessionId: string;
  readonly envelope: AgentRequestEnvelope;
}

export interface AcpDriverCancelRequest {
  readonly acpSessionId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly reason: string;
  readonly operationId?: OperationId;
}

export interface AcpDriverReconcileRequest {
  readonly acpSessionId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly operationRef: string;
}

export interface AcpDriverSettleRequest {
  readonly acpSessionId: string;
  readonly requestId: string;
  readonly attemptId: string;
}

export interface AcpDriverCloseRequest {
  readonly acpSessionId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly reason: string;
}

export interface AcpDriverOpenResult {
  readonly externalSessionRef: string;
  readonly executionEpoch: number;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AcpDriverCloseReceipt {
  readonly closed: boolean;
  readonly idempotent: boolean;
  readonly receipt?: AgentCloseReceipt;
}

export interface AcpDriverTransport {
  capabilities(binding: import('../../contracts/src/index.js').AcpDriverBinding): Promise<AcpCapabilitySet>;
  open(input: AcpDriverOpenRequest): Promise<AcpDriverOpenResult>;
  load(input: AcpDriverLoadRequest): Promise<AcpDriverOpenResult>;
  observe(input: AcpDriverObserveRequest): AsyncIterable<AcpObservationUpdate>;
  request(input: AcpDriverRequest): Promise<AgentDispatchReceipt>;
  cancelInteraction(input: AcpDriverCancelRequest): Promise<InteractionClosure>;
  requestStop(input: AcpDriverCancelRequest): Promise<AgentStopReceipt>;
  reconcile(input: AcpDriverReconcileRequest): Promise<AgentReconcileResult>;
  settle(input: AcpDriverSettleRequest): Promise<AgentSettleReceipt>;
  close(input: AcpDriverCloseRequest): Promise<AgentCloseReceipt>;
}

export interface AcpServerPort {
  initialize(input: AcpInitializeRequest): Promise<AcpNegotiatedCapabilities>;
  open(input: AcpOpenRequest): Promise<AcpSessionRecord>;
  load(input: AcpLoadRequest): Promise<AcpSessionRecord>;
  observe(input: AcpObserveRequest): AsyncIterable<AcpObservationUpdate>;
  request(input: AcpRequest): Promise<AgentDispatchReceipt>;
  cancel(input: AcpCancelRequest): Promise<AcpCancelReceipt>;
  reconcile(input: AcpReconcileRequest): Promise<AgentReconcileResult>;
  settle(input: AcpSettleRequest): Promise<AgentSettleReceipt>;
  close(input: AcpCloseRequest): Promise<AcpCloseReceipt>;
}

export interface AcpDriverPort {
  capabilities(input?: AcpDriverCapabilityRequest, proof?: AcpDelegationProof): Promise<AcpCapabilitySet>;
  open(input: AcpDriverOpenRequest, proof?: AcpDelegationProof): Promise<AcpDriverOpenResult>;
  load(input: AcpDriverLoadRequest, proof?: AcpDelegationProof): Promise<AcpDriverOpenResult>;
  observe(input: AcpDriverObserveRequest, proof?: AcpDelegationProof): AsyncIterable<AcpObservationUpdate>;
  request(input: AcpDriverRequest, proof?: AcpDelegationProof): Promise<AgentDispatchReceipt>;
  cancel(input: AcpDriverCancelRequest, proof?: AcpDelegationProof): Promise<AcpCancelReceipt>;
  reconcile(input: AcpDriverReconcileRequest, proof?: AcpDelegationProof): Promise<AgentReconcileResult>;
  settle(input: AcpDriverSettleRequest, proof?: AcpDelegationProof): Promise<AgentSettleReceipt>;
  close(input: AcpDriverCloseRequest): Promise<AcpDriverCloseReceipt>;
}
